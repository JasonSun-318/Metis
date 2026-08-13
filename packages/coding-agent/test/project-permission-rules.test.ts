import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionAction } from "../src/core/permission-policy.ts";
import {
	ProjectPermissionRuleStore,
	type ProjectPermissionSignatureInput,
} from "../src/core/project-permission-rules.ts";

describe("ProjectPermissionRuleStore", () => {
	let root: string;
	let agentDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-project-permissions-"));
		agentDir = join(root, "agent");
		projectA = join(root, "project-a");
		projectB = join(root, "project-b");
		mkdirSync(agentDir);
		mkdirSync(join(projectA, "src"), { recursive: true });
		mkdirSync(projectB);
	});

	afterEach(() => {
		chmodSync(root, 0o700);
		rmSync(root, { recursive: true, force: true });
	});

	const signature = (
		options: {
			command?: string;
			cwd?: string;
			roots?: readonly string[];
			projectPath?: string;
			action?: Partial<PermissionAction>;
			args?: unknown;
			executionTarget?: "sandbox" | "host";
		} = {},
	): ProjectPermissionSignatureInput => {
		const command = options.command ?? "rm -rf ./build";
		return {
			projectPath: options.projectPath ?? projectA,
			cwd: options.cwd ?? projectA,
			workspaceRoots: options.roots ?? [projectA],
			action: {
				actionId: "action-1",
				toolName: "bash",
				provenance: "builtin",
				risks: ["shell", "destructive"],
				paths: [],
				networkTargets: [],
				command,
				...options.action,
			},
			args: options.args ?? { command },
			executionTarget: options.executionTarget ?? "sandbox",
		};
	};

	it("persists and matches only the complete canonical action signature", () => {
		const first = signature();
		const store = new ProjectPermissionRuleStore(agentDir);
		const saved = store.remember(first);

		expect(new ProjectPermissionRuleStore(agentDir).match(first)?.id).toBe(saved.id);
		expect(store.remember(first).id).toBe(saved.id);
		expect(store.list(projectA)).toHaveLength(1);
		expect(store.match(signature({ command: "rm -rf ./src" }))).toBeUndefined();
		expect(store.match(signature({ cwd: join(projectA, "src") }))).toBeUndefined();
		expect(store.match(signature({ roots: [projectA, projectB] }))).toBeUndefined();
		expect(store.match(signature({ projectPath: projectB }))).toBeUndefined();
		expect(store.match(signature({ args: { command: first.action.command, force: true } }))).toBeUndefined();
		expect(store.match(signature({ action: { risks: ["shell"] } }))).toBeUndefined();
		expect(store.match(signature({ action: { paths: [join(projectA, "src")] } }))).toBeUndefined();
		expect(
			store.match(signature({ action: { networkTargets: [{ host: "example.test", port: 443 }] } })),
		).toBeUndefined();
		expect(store.match(signature({ action: { provenance: "sdk" } }))).toBeUndefined();
		expect(store.match(signature({ executionTarget: "host" }))).toBeUndefined();
		expect(store.match(signature({ roots: [projectB, projectA] }))).toBeUndefined();
		const withBothRoots = signature({ roots: [projectA, projectB] });
		const bothSaved = store.remember(withBothRoots);
		expect(store.match(signature({ roots: [projectB, projectA] }))?.id).toBe(bothSaved.id);
	});

	it("persists bounded identifying details without exposing secret values", () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		const saved = store.remember(
			signature({
				action: {
					toolName: "custom_publish",
					provenance: "sdk",
					risks: ["external-side-effect"],
					networkTargets: [{ host: "api.example.test", port: 443 }],
					command: undefined,
				},
				args: {
					repository: "metis",
					branch: "main",
					content: "release notes",
					apiToken: "secret",
					api_key: "also-secret",
				},
				executionTarget: "host",
			}),
		);

		expect(saved.details).toEqual(
			expect.arrayContaining([
				{ label: "Network", value: "api.example.test:443" },
				{ label: "Repository", value: "metis" },
				{ label: "Branch", value: "main" },
				{ label: "Content", value: "release notes" },
				{ label: "ApiToken", value: "<redacted>" },
				{ label: "Api key", value: "<redacted>" },
			]),
		);
		expect(JSON.stringify(saved)).not.toContain("secret");
		expect(new ProjectPermissionRuleStore(agentDir).list(projectA)[0]?.details).toEqual(saved.details);

		const webRule = store.remember(
			signature({
				action: {
					toolName: "web_fetch",
					provenance: "builtin",
					risks: ["network"],
					networkTargets: [{ host: "example.test", port: 443 }],
					command: undefined,
				},
				args: { url: "https://example.test/a" },
				executionTarget: "host",
			}),
		);
		expect(webRule.details).toContainEqual({ label: "Address", value: "https://example.test/a" });

		const longKey = "x".repeat(300);
		const bounded = store.remember(
			signature({
				action: {
					toolName: "custom_long",
					provenance: "sdk",
					risks: ["custom"],
					command: undefined,
				},
				args: { [longKey]: "y".repeat(5_000) },
			}),
		);
		expect(bounded.details[0]?.label).toHaveLength(256);
		expect(bounded.details[0]?.value).toHaveLength(4_096);
		expect(() => new ProjectPermissionRuleStore(agentDir).list(projectA)).not.toThrow();
	});

	it("deletes and clears only the selected current project", () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		const first = store.remember(signature());
		const second = store.remember(signature({ command: "rm -rf ./cache" }));
		store.remember(signature({ projectPath: projectB, cwd: projectB, roots: [projectB] }));

		expect(store.delete(projectA, first.id)).toBe(true);
		expect(store.delete(projectA, first.id)).toBe(false);
		expect(store.list(projectA).map((rule) => rule.id)).toEqual([second.id]);
		expect(store.clear(projectA)).toBe(1);
		expect(store.list(projectA)).toEqual([]);
		expect(store.list(projectB)).toHaveLength(1);
	});

	it("uses locked atomic 0600 persistence across store instances", () => {
		const first = new ProjectPermissionRuleStore(agentDir);
		const second = new ProjectPermissionRuleStore(agentDir);
		first.remember(signature());
		second.remember(signature({ command: "rm -rf ./cache" }));

		const path = join(agentDir, "permission-rules.json");
		expect(new ProjectPermissionRuleStore(agentDir).list(projectA)).toHaveLength(2);
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("migrates legacy long commands into bounded restart-safe details", () => {
		const store = new ProjectPermissionRuleStore(agentDir);
		const saved = store.remember(signature({ command: "x".repeat(5_000) }));
		const { details: _details, omittedDetails: _omittedDetails, ...legacy } = saved;
		const path = join(agentDir, "permission-rules.json");
		writeFileSync(path, `${JSON.stringify({ version: 1, rules: [legacy] }, null, 2)}\n`);

		expect(store.list(projectA)[0]?.details[0]?.value).toHaveLength(4_096);
		store.remember(signature({ command: "pwd" }));
		expect(() => new ProjectPermissionRuleStore(agentDir).list(projectA)).not.toThrow();
	});

	it("fails closed for malformed, aliased, oversized, and unbounded storage", () => {
		const path = join(agentDir, "permission-rules.json");
		writeFileSync(path, "not-json");
		expect(() => new ProjectPermissionRuleStore(agentDir).list(projectA)).toThrow("malformed");

		writeFileSync(path, "x".repeat(1024 * 1024 + 1));
		expect(() => new ProjectPermissionRuleStore(agentDir).list(projectA)).toThrow("too large");

		writeFileSync(path, "{}\n");
		expect(() =>
			new ProjectPermissionRuleStore(agentDir).remember(signature({ command: "x".repeat(16 * 1024 + 1) })),
		).toThrow("command is too long");

		if (process.platform !== "win32") {
			const target = join(root, "aliased-rules.json");
			writeFileSync(target, "{}\n");
			rmSync(path);
			symlinkSync(target, path);
			expect(() => new ProjectPermissionRuleStore(agentDir).list(projectA)).toThrow();
		}
	});
});
