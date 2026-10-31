import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestCanonical } from "../../src/core/permissions/normalize.ts";
import { SessionPermissionRuleStore } from "../../src/core/permissions/session-rules.ts";
import { ruleInput } from "./project-rule-fixtures.ts";

describe("in-memory exact session permission rules", () => {
	let root: string;
	let projectPath: string;
	let otherProject: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-session-rules-"));
		projectPath = realpathSync(mkdtempSync(join(root, "project-")));
		otherProject = realpathSync(mkdtempSync(join(root, "other-")));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reuses an exact scope within its owner and keeps a different owner isolated", () => {
		const input = ruleInput({ projectPath });
		const a = new SessionPermissionRuleStore("session-a");
		const b = new SessionPermissionRuleStore("session-b");
		const rule = a.rememberAllow(input);
		expect(a.match(input)?.id).toBe(rule.id);
		expect(a.rememberAllow(input)).toEqual(rule);
		expect(b.match(input)).toBeUndefined();
		expect(b.rememberAllow(input).id).not.toBe(rule.id);
		expect(rule).toMatchObject({ decision: "allow", sessionId: "session-a" });
	});

	it.each(["projectPath", "actionDigest", "grantDigest", "toolName", "toolIdentity", "riskLevel"] as const)(
		"does not reuse a changed %s",
		(field) => {
			const input = ruleInput({ projectPath });
			const store = new SessionPermissionRuleStore("owner");
			store.rememberAllow(input);
			const changes: Record<string, unknown> = {
				projectPath: otherProject,
				actionDigest: digestCanonical("changed-action"),
				grantDigest: digestCanonical("changed-grant"),
				toolName: "other-tool",
				toolIdentity: "other:identity",
				riskLevel: "high" as const,
			};
			expect(store.match({ ...input, [field]: changes[field] })).toBeUndefined();
		},
	);

	it("revokes only the specified project and rule", () => {
		const store = new SessionPermissionRuleStore("owner");
		const a = ruleInput({ projectPath });
		const b = ruleInput({ projectPath: otherProject });
		const ruleA = store.rememberAllow(a);
		const ruleB = store.rememberAllow(b);
		expect(store.delete(b.projectPath, ruleA.id)).toBe(false);
		expect(store.delete(a.projectPath, ruleA.id)).toBe(true);
		expect(store.match(a)).toBeUndefined();
		expect(store.match(b)?.id).toBe(ruleB.id);
		expect(store.clear(a.projectPath)).toBe(0);
		expect(store.clear(b.projectPath)).toBe(1);
		expect(store.list(b.projectPath)).toEqual([]);
	});

	it("compares projects through their real paths, not symlink aliases", () => {
		const alias = join(root, "project-alias");
		symlinkSync(projectPath, alias, "dir");
		const otherAlias = join(root, "other-alias");
		symlinkSync(otherProject, otherAlias, "dir");
		const store = new SessionPermissionRuleStore("owner");
		const rule = store.rememberAllow(ruleInput({ projectPath: alias }));

		expect(store.list(projectPath)).toHaveLength(1);
		expect(store.list(alias)).toHaveLength(1);
		expect(store.match(ruleInput({ projectPath: alias }))?.id).toBe(rule.id);
		expect(store.match(ruleInput({ projectPath: projectPath }))?.id).toBe(rule.id);
		expect(store.match(ruleInput({ projectPath: otherAlias }))).toBeUndefined();
		// Revoking through either alias clears the single real project.
		expect(store.delete(otherProject, rule.id)).toBe(false);
		expect(store.delete(alias, rule.id)).toBe(true);
		expect(store.list(realpathSync(alias))).toEqual([]);
	});

	it("rejects existing relative project paths before realpath resolution", () => {
		const store = new SessionPermissionRuleStore("owner");
		expect(() => store.rememberAllow(ruleInput({ projectPath: "." }))).toThrow();
		expect(() => store.list(".")).toThrow();
		expect(() => store.clear(".")).toThrow();
		expect(() => store.delete(".", "rule")).toThrow();
	});

	it("fails closed on a missing project path", () => {
		const store = new SessionPermissionRuleStore("owner");
		const missing = join(root, "missing-project");
		expect(() => store.rememberAllow(ruleInput({ projectPath: missing }))).toThrow();
		expect(() => store.list(missing)).toThrow();
		expect(() => store.clear(missing)).toThrow();
		expect(() => store.delete(missing, "a".repeat(64))).toThrow();
	});

	it("copies and freezes permission data while redacting sensitive summary labels", () => {
		const summary = [{ label: "API token", value: "secret-fixture-value" }];
		const input = ruleInput({ projectPath, summary });
		const store = new SessionPermissionRuleStore("owner");
		const rule = store.rememberAllow(input);
		summary[0]!.value = "changed";
		expect(rule.summary).toEqual([{ label: "API token", value: "<redacted>" }]);
		expect(Object.isFrozen(rule)).toBe(true);
		expect(Object.isFrozen(rule.summary)).toBe(true);
		expect(Object.isFrozen(rule.summary[0])).toBe(true);
		expect(Object.isFrozen(store.list(input.projectPath))).toBe(true);
	});

	it("rejects critical, malformed, accessor and extra-field inputs", () => {
		const store = new SessionPermissionRuleStore("owner");
		expect(() => store.rememberAllow(ruleInput({ projectPath, riskLevel: "critical" }))).toThrow();
		expect(() => store.rememberAllow(ruleInput({ projectPath, actionDigest: "invalid" }))).toThrow();
		expect(() => store.rememberAllow(ruleInput({ projectPath: "relative" }))).toThrow();
		const extra = { ...ruleInput({ projectPath }), decision: "allow" };
		expect(() => store.rememberAllow(extra)).toThrow();
		const getter = { ...ruleInput({ projectPath }) };
		Object.defineProperty(getter, "actionDigest", {
			enumerable: true,
			get: () => {
				throw new Error("must not execute getter");
			},
		});
		expect(() => store.rememberAllow(getter)).toThrow(TypeError);
		expect(store.list(projectPath)).toEqual([]);
	});

	it("does not survive construction of a fresh store with the same session identifier", () => {
		const input = ruleInput({ projectPath });
		new SessionPermissionRuleStore("owner").rememberAllow(input);
		expect(new SessionPermissionRuleStore("owner").list(input.projectPath)).toEqual([]);
	});

	it.each(["", " ", "bad\0owner"])("rejects an invalid session owner", (owner) => {
		expect(() => new SessionPermissionRuleStore(owner)).toThrow(TypeError);
	});
});
