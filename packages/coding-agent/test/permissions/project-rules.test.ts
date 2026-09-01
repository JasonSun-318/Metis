import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	digestCanonical,
	digestPermissionAction,
	PermissionPolicy,
	ProjectPermissionRuleStore,
	settingsForPreset,
} from "../../src/core/permissions/index.ts";
import { outsideFile, projectDir, rootRecursiveDelete, workspaceWrite } from "./fixtures.ts";
import { ruleInput } from "./project-rule-fixtures.ts";

describe("ProjectPermissionRuleStore", () => {
	let root: string;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-permission-rules-v2-"));
		agentDir = join(root, "agent");
		project = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(project);
	});

	afterEach(() => {
		chmodSync(root, 0o700);
		rmSync(root, { recursive: true, force: true });
	});

	it("matches only the exact project, action, grant, tool, and risk identity", () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		const input = ruleInput({ projectPath: project });
		const stored = store.rememberAllow(input);

		expect(store.match(input)).toMatchObject({ id: stored.id, decision: "allow" });
		expect(store.match(ruleInput({ projectPath: project, actionDigest: "a".repeat(64) }))).toBeUndefined();
		expect(store.match(ruleInput({ projectPath: project, grantDigest: "b".repeat(64) }))).toBeUndefined();
		expect(store.match(ruleInput({ projectPath: project, toolIdentity: "builtin:write_file:v2" }))).toBeUndefined();
		expect(store.match(ruleInput({ projectPath: project, riskLevel: "medium" }))).toBeUndefined();
		expect(store.match(ruleInput({ projectPath: projectDir }))).toBeUndefined();
	});

	it("gives an exact deny precedence until the rule is deleted", () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		const input = ruleInput({ projectPath: project });
		store.rememberAllow(input);
		expect(store.rememberDeny(input).decision).toBe("deny");
		expect(store.rememberAllow(input).decision).toBe("deny");
		expect(store.match(input)?.decision).toBe("deny");
	});

	it("binds the same action and grant digests used by the policy", () => {
		const action = workspaceWrite();
		const decision = new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action });
		if (decision.kind === "deny") throw new Error("Expected a grant");
		const input = ruleInput({
			projectPath: project,
			actionDigest: digestPermissionAction(action),
			grantDigest: digestCanonical(decision.grant),
		});
		const stored = new ProjectPermissionRuleStore(agentDir).rememberAllow(input);
		expect(stored).toMatchObject({ actionDigest: input.actionDigest, grantDigest: input.grantDigest });
	});

	it("cannot turn a hard-denied action into an allow", () => {
		const action = rootRecursiveDelete();
		const store = new ProjectPermissionRuleStore(agentDir);
		const input = ruleInput({
			projectPath: project,
			actionDigest: digestPermissionAction(action),
			grantDigest: digestCanonical({ requested: "filesystem-root" }),
			toolName: action.toolName,
			toolIdentity: action.toolIdentity,
			riskLevel: "critical",
		});
		expect(store.rememberAllow(input).decision).toBe("allow");
		expect(store.match(input)?.decision).toBe("allow");
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("full"), action })).toMatchObject({
			kind: "deny",
			riskLevel: "critical",
		});
	});

	it("stores only bounded redacted summaries outside the repository", () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		store.rememberAllow(
			ruleInput({
				projectPath: project,
				summary: [
					{ label: "Token", value: "secret-value" },
					{ label: "Destination", value: "api.example.com" },
				],
			}),
		);
		const rulesPath = join(agentDir, "permission-rules.json");
		const raw = readFileSync(rulesPath, "utf8");
		expect(raw).not.toContain("secret-value");
		expect(raw).toContain("<redacted>");
		expect(realpathSync(rulesPath)).not.toContain(project);
		expect(lstatSync(rulesPath).mode & 0o777).toBe(0o600);
		expect(() =>
			store.rememberAllow({
				...ruleInput({ projectPath: project }),
				args: { token: "must-not-be-accepted" },
			} as never),
		).toThrow("input");
		expect(readFileSync(rulesPath, "utf8")).not.toContain("must-not-be-accepted");
	});

	it("treats version 1 as no authority and replaces it only on an explicit remember", () => {
		const rulesPath = join(agentDir, "permission-rules.json");
		writeFileSync(rulesPath, JSON.stringify({ version: 1, rules: [{ decision: "allow", toolName: "write_file" }] }));
		const store = new ProjectPermissionRuleStore(agentDir);
		const input = ruleInput({ projectPath: project });
		expect(store.match(input)).toBeUndefined();
		store.rememberAllow(input);
		expect(JSON.parse(readFileSync(rulesPath, "utf8"))).toMatchObject({ version: 2 });
	});

	it("fails closed for malformed or oversized version 2 storage", () => {
		const rulesPath = join(agentDir, "permission-rules.json");
		const store = new ProjectPermissionRuleStore(agentDir);
		writeFileSync(rulesPath, JSON.stringify({ version: 2, rules: [{ id: "forged" }] }));
		expect(() => store.match(ruleInput({ projectPath: project }))).toThrow("invalid rule");
		writeFileSync(rulesPath, "x".repeat(1024 * 1024 + 1));
		expect(() => store.list(project)).toThrow("too large");
	});

	it("canonicalizes project aliases and returns immutable detached views", () => {
		const alias = join(root, "project-alias");
		symlinkSync(project, alias);
		const store = new ProjectPermissionRuleStore(agentDir);
		const stored = store.rememberAllow(ruleInput({ projectPath: alias }));
		expect(store.match(ruleInput({ projectPath: project }))?.id).toBe(stored.id);
		const listed = store.list(alias);
		expect(Object.isFrozen(listed)).toBe(true);
		expect(Object.isFrozen(listed[0]?.summary)).toBe(true);
		expect(() =>
			(listed[0]?.summary as { label: string; value: string }[]).push({ label: "x", value: "y" }),
		).toThrow();
	});

	it("deletes one rule, clears one project, and preserves other projects", () => {
		const otherProject = join(root, "other-project");
		mkdirSync(otherProject);
		const store = new ProjectPermissionRuleStore(agentDir);
		const first = store.rememberAllow(ruleInput({ projectPath: project }));
		store.rememberDeny(ruleInput({ projectPath: project, actionDigest: digestCanonical("second") }));
		store.rememberAllow(ruleInput({ projectPath: otherProject }));

		expect(store.delete(project, first.id)).toBe(true);
		expect(store.delete(project, first.id)).toBe(false);
		expect(store.clear(project)).toBe(1);
		expect(store.clear(project)).toBe(0);
		expect(store.list(otherProject)).toHaveLength(1);
	});

	it("serializes interleaved writers without losing updates", () => {
		const first = new ProjectPermissionRuleStore(agentDir);
		const second = new ProjectPermissionRuleStore(agentDir);
		for (let index = 0; index < 20; index += 1) {
			const store = index % 2 === 0 ? first : second;
			store.rememberAllow(ruleInput({ projectPath: project, actionDigest: digestCanonical(index) }));
		}
		expect(first.list(project)).toHaveLength(20);
	});

	it("enforces the per-project rule limit", () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		for (let index = 0; index < 256; index += 1) {
			store.rememberAllow(ruleInput({ projectPath: project, actionDigest: digestCanonical(index) }));
		}
		expect(() =>
			store.rememberAllow(ruleInput({ projectPath: project, actionDigest: digestCanonical(outsideFile) })),
		).toThrow("project is full");
	});
});
