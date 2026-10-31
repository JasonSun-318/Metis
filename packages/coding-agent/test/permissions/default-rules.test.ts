import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	createDefaultPermissionRules,
	normalizePermissionAction,
	normalizePermissionRules,
	type PermissionAuditEvent,
	PermissionAuditWriter,
	PermissionPolicy,
	type PermissionRule,
	type PermissionSettings,
	ToolAuthorizationRuntime,
} from "../../src/core/permissions/index.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";
import { bashPermissionClaim } from "../../src/core/tool-permission-adapter.ts";
import { canonicalizeActionPath } from "../../src/utils/paths.ts";
import { actionInput, ordinaryRead, outsideFile, outsideRead, projectDir, workspaceWrite } from "./fixtures.ts";
import { safeRequest } from "./runtime-fixtures.ts";

const auto = { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" } as const;
const ask = { sandboxPolicy: "workspace-write", approvalPolicy: "user" } as const;
const readOnlyAsk = { sandboxPolicy: "read-only", approvalPolicy: "user" } as const;
const deny = { sandboxPolicy: "workspace-write", approvalPolicy: "deny" } as const;

beforeAll(async () => {
	await initializeShellAnalysis();
});

function without(rules: readonly PermissionRule[], ...ids: string[]): PermissionRule[] {
	return rules.filter((rule) => !ids.includes(rule.id));
}

function disabled(rules: readonly PermissionRule[], ...ids: string[]): PermissionRule[] {
	return rules.map((rule) => (ids.includes(rule.id) ? { ...rule, enabled: false } : rule));
}

function bashAction(command: string) {
	const input = actionInput({ toolName: "bash", toolIdentity: "builtin:bash:v1", args: { command } });
	return normalizePermissionAction({ ...input, ...bashPermissionClaim(command, input) });
}

/** A legacy-style action without trusted shell analysis facts. */
function rawBashAction(command: string) {
	return normalizePermissionAction(
		actionInput({
			toolName: "bash",
			toolIdentity: "builtin:bash:v1",
			args: { command },
			command,
			readPaths: [],
			writePaths: [],
			networkEndpoints: [],
			effects: [],
		}),
	);
}

function evaluate(
	action: ReturnType<typeof normalizePermissionAction>,
	permissionRules: readonly PermissionRule[] = createDefaultPermissionRules(),
	settings: PermissionSettings = auto,
) {
	return new PermissionPolicy().evaluate({ action, settings, permissionRules });
}

describe("default permission rules in the policy", () => {
	it("allows default tool and command reads with auditable rule details", () => {
		const read = evaluate(ordinaryRead(), createDefaultPermissionRules(), ask);
		expect(read).toMatchObject({
			kind: "allow",
			ruleIds: ["T01"],
			matchedRule: { id: "T01", name: "读取文件", scope: "workspace" },
		});
		const ls = evaluate(bashAction("ls"));
		expect(ls).toMatchObject({ kind: "allow", ruleIds: ["C03"], matchedRule: { id: "C03", scope: "workspace" } });
	});

	it("requires every AST command node to match, in order", () => {
		expect(evaluate(bashAction("ls && pwd"))).toMatchObject({ kind: "allow", ruleIds: ["C03", "C01"] });
		expect(evaluate(bashAction("ls && rm file.txt"))).toMatchObject({ kind: "review" });
	});

	it("applies bound file-test conditions to the workspace scope", () => {
		expect(evaluate(bashAction("test -f README.md"))).toMatchObject({ kind: "allow", ruleIds: ["C16"] });
		expect(evaluate(bashAction("[[ -f README.md ]]"))).toMatchObject({ kind: "allow", ruleIds: ["C18"] });
		expect(evaluate(bashAction("[[ -f /etc/hosts ]]"))).not.toMatchObject({ kind: "allow" });
		expect(evaluate(bashAction("[[ 1 -eq 1 ]]"))).toMatchObject({ kind: "allow", ruleIds: ["C18"] });
		expect(evaluate(bashAction('[[ -z "" ]]'))).toMatchObject({ kind: "allow", ruleIds: ["C18"] });
		expect(evaluate(bashAction('[[ -f "$FILE" ]]'))).not.toMatchObject({ kind: "allow" });
	});

	it("matches static assignments but not dynamic or environment assignments", () => {
		expect(evaluate(bashAction("x=1"))).toMatchObject({ kind: "allow", ruleIds: ["C28"] });
		expect(evaluate(bashAction("PATH=/tmp"))).not.toMatchObject({ kind: "allow" });
		expect(evaluate(bashAction("x=$HOME"))).not.toMatchObject({ kind: "allow" });
	});

	it("can disable structural C18 and C28 without affecting other reads", () => {
		const rules = disabled(createDefaultPermissionRules(), "C18", "C28");
		expect(evaluate(bashAction("[[ -f README.md ]]"), rules)).not.toMatchObject({ kind: "allow" });
		expect(evaluate(bashAction("x=1"), rules)).not.toMatchObject({ kind: "allow" });
		expect(evaluate(bashAction("pwd"), rules)).toMatchObject({ kind: "allow", ruleIds: ["C01"] });
	});

	it("turning a default rule off removes its implicit allow", () => {
		const noC03 = disabled(createDefaultPermissionRules(), "C03");
		expect(evaluate(bashAction("ls"), noC03)).not.toMatchObject({ kind: "allow" });
		const noT01 = disabled(createDefaultPermissionRules(), "T01");
		expect(evaluate(ordinaryRead(), noT01, ask)).not.toMatchObject({ kind: "allow" });
		const noT06 = disabled(createDefaultPermissionRules(), "T06");
		expect(evaluate(workspaceWrite(), noT06)).not.toMatchObject({ kind: "allow" });
	});

	it("deleting a default rule does not restore a low-risk fallback", () => {
		const rules = without(createDefaultPermissionRules(), "T01", "T06", "T12");
		expect(evaluate(ordinaryRead(), rules)).not.toMatchObject({ kind: "allow" });
		expect(evaluate(workspaceWrite(), rules)).not.toMatchObject({ kind: "allow" });
		const tasks = normalizePermissionAction(
			actionInput({
				toolName: "set_tasks",
				toolIdentity: "builtin:set_tasks:v1",
				args: {},
				readPaths: [],
				writePaths: [],
			}),
		);
		expect(evaluate(tasks, createDefaultPermissionRules(), ask)).toMatchObject({ kind: "allow", ruleIds: ["T12"] });
		expect(evaluate(tasks, rules, ask)).not.toMatchObject({ kind: "allow" });
	});

	it("treats explicit empty rules as no rules, even with legacy Auto rules", () => {
		for (const action of [ordinaryRead(), workspaceWrite()]) {
			expect(new PermissionPolicy().evaluate({ action, settings: auto, permissionRules: [] })).not.toMatchObject({
				kind: "allow",
			});
		}
		expect(
			new PermissionPolicy().evaluate({
				action: bashAction("ls"),
				settings: auto,
				permissionRules: [],
				autoCommandRules: [{ command: "ls", allowNetwork: false }],
			}),
		).not.toMatchObject({ kind: "allow" });
	});

	it("keeps trusted host controls on their own rule, not the external fallback", () => {
		const input = actionInput({
			toolName: "ask_user",
			toolIdentity: "host:ask_user:v1",
			provenance: "host",
			args: {},
			readPaths: [],
			writePaths: [],
		});
		const askUser = normalizePermissionAction(input);
		expect(evaluate(askUser, createDefaultPermissionRules(), ask)).toMatchObject({
			kind: "allow",
			ruleIds: ["T13"],
		});
		expect(evaluate(askUser, disabled(createDefaultPermissionRules(), "T13"), ask)).not.toMatchObject({
			kind: "allow",
		});
	});

	it("keeps OfficeCLI compatibility behavior while making E01 toggleable", () => {
		const command = "officecli view report.docx text";
		expect(evaluate(bashAction(command), createDefaultPermissionRules(), ask)).toMatchObject({
			kind: "allow",
			ruleIds: ["E01"],
		});
		expect(evaluate(bashAction(command), disabled(createDefaultPermissionRules(), "E01"), ask)).not.toMatchObject({
			kind: "allow",
		});
	});

	it("keeps analyzer-proven pure reads under read-only Ask and deny ceilings", () => {
		const rules = createDefaultPermissionRules();
		expect(evaluate(bashAction("pwd"), rules, readOnlyAsk)).toMatchObject({ kind: "allow", ruleIds: ["C01"] });
		expect(evaluate(bashAction("pwd"), disabled(rules, "C01"), readOnlyAsk)).not.toMatchObject({ kind: "allow" });
		expect(evaluate(bashAction("pwd"), rules, ask)).not.toMatchObject({ kind: "allow" });
		expect(evaluate(bashAction("cat README.md"), rules, deny)).toMatchObject({ kind: "allow", ruleIds: ["C04"] });
		expect(evaluate(bashAction("cat README.md > out.txt"), rules, readOnlyAsk)).not.toMatchObject({
			kind: "allow",
		});
		// Legacy actions without trusted analysis keep the same pure-read ability,
		// but only through an enabled visible command rule.
		expect(evaluate(rawBashAction("pwd"), rules, readOnlyAsk)).toMatchObject({ kind: "allow", ruleIds: ["C01"] });
		expect(evaluate(rawBashAction("pwd"), disabled(rules, "C01"), readOnlyAsk)).not.toMatchObject({
			kind: "allow",
		});
		expect(evaluate(rawBashAction("pwd"), rules, ask)).not.toMatchObject({ kind: "allow" });
		expect(evaluate(rawBashAction("python script.py"), rules, readOnlyAsk)).not.toMatchObject({
			kind: "allow",
		});
	});

	it("does not tighten existing read-only E03 external reads", () => {
		const externalRead = normalizePermissionAction(
			actionInput({
				toolName: "external_read",
				toolIdentity: "extension:external_read:v1",
				provenance: "extension",
				readPaths: [join(projectDir, "README.md")],
				effects: [],
			}),
		);
		expect(evaluate(externalRead, createDefaultPermissionRules(), readOnlyAsk)).toMatchObject({
			kind: "allow",
			ruleIds: ["E03"],
		});
		expect(evaluate(externalRead, disabled(createDefaultPermissionRules(), "E03"), readOnlyAsk)).not.toMatchObject({
			kind: "allow",
		});
	});

	it("E03/E04 only cover external identities and cannot bypass disabled C/T rules", () => {
		const externalRead = normalizePermissionAction(
			actionInput({
				toolName: "external_read",
				toolIdentity: "extension:external_read:v1",
				provenance: "extension",
				readPaths: [join(projectDir, "README.md")],
				effects: [],
			}),
		);
		expect(evaluate(externalRead, createDefaultPermissionRules(), ask)).toMatchObject({
			kind: "allow",
			ruleIds: ["E03"],
		});
		expect(evaluate(externalRead, disabled(createDefaultPermissionRules(), "E03"), ask)).not.toMatchObject({
			kind: "allow",
		});
		expect(evaluate(externalRead, disabled(createDefaultPermissionRules(), "E04"))).toMatchObject({
			kind: "allow",
			ruleIds: ["E03"],
		});

		const externalWrite = normalizePermissionAction(
			actionInput({
				toolName: "external_write",
				toolIdentity: "extension:external_write:v1",
				provenance: "extension",
				readPaths: [],
				writePaths: [join(projectDir, "out.txt")],
				effects: [],
			}),
		);
		expect(evaluate(externalWrite, createDefaultPermissionRules(), auto)).toMatchObject({
			kind: "allow",
			ruleIds: ["E04"],
		});
		expect(evaluate(externalWrite, disabled(createDefaultPermissionRules(), "E04"), auto)).not.toMatchObject({
			kind: "allow",
		});

		// Builtin write keeps its real T06 identity, so E04 cannot re-allow it.
		expect(evaluate(workspaceWrite(), disabled(createDefaultPermissionRules(), "T06"), auto)).not.toMatchObject({
			kind: "allow",
		});
		expect(evaluate(bashAction("ls"), disabled(createDefaultPermissionRules(), "C03"), auto)).not.toMatchObject({
			kind: "allow",
		});
	});

	it("requires exact network targets on a user command rule", () => {
		const [curlRule] = normalizePermissionRules([
			{
				id: "user-curl",
				kind: "command",
				origin: "user",
				name: "curl",
				enabled: true,
				modes: ["auto"],
				scope: "all",
				directories: [],
				command: "curl",
				allowNetwork: true,
				networkTargets: [{ hostname: "example.com", port: 443 }],
			},
		]);
		expect(curlRule).toBeDefined();
		expect(evaluate(bashAction("curl https://example.com"), [curlRule!])).toMatchObject({
			kind: "allow",
			ruleIds: ["user-curl"],
		});
		expect(evaluate(bashAction("curl https://other.example.net"), [curlRule!])).not.toMatchObject({
			kind: "allow",
		});
	});

	it("scopes directory rules to what the analyzer really read, not the merged workspace root", () => {
		const outsideDir = canonicalizeActionPath(resolve(tmpdir(), "metis-permission-fixture", "elsewhere"), projectDir);
		const directoryRule = (command: string): PermissionRule =>
			normalizePermissionRules([
				{
					id: `user-${command}`,
					kind: "command",
					origin: "user",
					name: command,
					enabled: true,
					modes: ["auto"],
					scope: "directories",
					directories: [outsideDir],
					command,
					allowNetwork: false,
				},
			])[0]!;

		const commands = { grep: "grep -r secret", rg: "rg secret", ls: "ls -R", find: "find .", cat: "cat *" } as const;
		for (const [prefix, command] of Object.entries(commands)) {
			expect(evaluate(bashAction(command), [directoryRule(prefix)])).not.toMatchObject({ kind: "allow" });
		}

		// A real read inside the configured directory still matches.
		expect(evaluate(bashAction(`cat ${join(outsideDir, "README.md")}`), [directoryRule("cat")])).toMatchObject({
			kind: "allow",
			ruleIds: ["user-cat"],
		});

		// A command that reads nothing is not restricted by a directory scope.
		expect(evaluate(bashAction("pwd"), [directoryRule("pwd")])).toMatchObject({ kind: "allow" });

		// Legacy facts without analyzer read paths must not widen the rule to the
		// merged workspace root the adapter uses for grants.
		const legacy = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "grep -r secret" },
				command: "grep -r secret",
				readPaths: [projectDir],
				writePaths: [],
				effects: [],
			}),
		);
		expect(evaluate(legacy, [directoryRule("grep")], readOnlyAsk)).not.toMatchObject({ kind: "allow" });
	});

	it("keeps outside reads and writes unmatched by workspace and directory tool rules", () => {
		const [writeRule, readRule] = normalizePermissionRules([
			{
				id: "user-write",
				kind: "tool",
				origin: "user",
				name: "write",
				enabled: true,
				modes: ["auto"],
				scope: "workspace",
				directories: [],
				toolName: "write",
				allowNetwork: false,
			},
			{
				id: "user-read",
				kind: "tool",
				origin: "user",
				name: "read",
				enabled: true,
				modes: ["ask", "auto"],
				scope: "directories",
				directories: [canonicalizeActionPath(projectDir, projectDir)],
				toolName: "read",
				allowNetwork: false,
			},
		]);
		const outsideWrite = normalizePermissionAction(
			actionInput({
				toolName: "write",
				toolIdentity: "builtin:write:v1",
				args: { path: outsideFile, content: "x" },
				readPaths: [],
				writePaths: [outsideFile],
			}),
		);
		expect(evaluate(outsideWrite, [writeRule!], auto)).not.toMatchObject({ kind: "allow" });
		expect(evaluate(outsideRead(), [readRule!], ask)).not.toMatchObject({ kind: "allow" });
		expect(evaluate(ordinaryRead(), [readRule!], ask)).toMatchObject({ kind: "allow", ruleIds: ["user-read"] });
	});
});

describe("runtime permission rule audit", () => {
	it("projects ruleIds and matchedRule to decisions and audit events", async () => {
		const events: PermissionAuditEvent[] = [];
		const onDecision = vi.fn();
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "rules-audit",
			audit: new PermissionAuditWriter({ append: (event) => void events.push(event) }),
			onDecision,
		});
		await expect(
			runtime.authorizeAndExecute(safeRequest({ permissionRules: createDefaultPermissionRules() })),
		).resolves.toBe("executed");
		expect(onDecision).toHaveBeenLastCalledWith(
			expect.objectContaining({
				source: "rule",
				ruleIds: ["T01"],
				matchedRule: { id: "T01", name: "读取文件", scope: "workspace" },
			}),
		);
		expect(events.find((event) => event.stage === "decision" && event.outcome === "allow")).toMatchObject({
			reasonCode: "rule.allow",
			ruleIds: ["T01"],
			matchedRule: { id: "T01", name: "读取文件", scope: "workspace" },
		});
	});

	it("requires independent approval when the rules getter throws", async () => {
		const request = safeRequest();
		Object.defineProperty(request, "permissionRules", {
			get() {
				throw new Error("broken settings");
			},
		});
		await expect(
			new ToolAuthorizationRuntime({ sessionId: "rules-invalid" }).authorizeAndExecute(request),
		).rejects.toThrow();
	});

	it("keeps exact remembered grants usable when the rule configuration is broken", async () => {
		const request = safeRequest();
		Object.defineProperty(request, "permissionRules", {
			get() {
				throw new Error("broken settings");
			},
		});
		const match = vi.fn(() => ({ decision: "allow" as const }));
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "rules-invalid-exact",
			projectPath: projectDir,
			projectRules: { match },
		});
		await expect(runtime.authorizeAndExecute(request)).resolves.toBe("executed");
		expect(match).toHaveBeenCalled();
	});

	it("uses valid new rules without consulting a legacy settings getter", async () => {
		const request = safeRequest({ permissionRules: createDefaultPermissionRules() });
		Object.defineProperty(request, "autoCommandRules", {
			get() {
				throw new Error("legacy must not be read");
			},
		});
		await expect(new ToolAuthorizationRuntime({ sessionId: "rules-new" }).authorizeAndExecute(request)).resolves.toBe(
			"executed",
		);
	});

	it("allows Full without reading a throwing permission rules getter", async () => {
		const execute = vi.fn(async () => "executed");
		const request = safeRequest({
			settings: { sandboxPolicy: "danger-full-access", approvalPolicy: "never" },
			execute,
		});
		Object.defineProperty(request, "permissionRules", {
			get() {
				throw new Error("broken settings");
			},
		});
		await expect(
			new ToolAuthorizationRuntime({ sessionId: "rules-full" }).authorizeAndExecute(request),
		).resolves.toBe("executed");
		expect(execute).toHaveBeenCalledOnce();
	});
});
