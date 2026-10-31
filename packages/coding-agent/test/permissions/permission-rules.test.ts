import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createDefaultPermissionRules,
	DEFAULT_PERMISSION_RULE_IDS,
	MAX_PERMISSION_RULE_ID_LENGTH,
	MAX_PERMISSION_RULES,
	MAX_USER_PERMISSION_RULES,
	normalizePermissionRules,
	permissionRuleView,
} from "../../src/core/permissions/index.ts";

function userRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "user-1",
		kind: "command",
		origin: "user",
		name: "curl",
		enabled: true,
		modes: ["auto"],
		scope: "all",
		directories: [],
		command: "curl",
		allowNetwork: false,
		...overrides,
	};
}

describe("default permission rules", () => {
	it("ships exactly C01-C28, T01-T19 and E01-E04 in stable order", () => {
		const rules = createDefaultPermissionRules();
		const ids = rules.map((rule) => rule.id);
		expect(rules).toHaveLength(51);
		expect(ids).toEqual(DEFAULT_PERMISSION_RULE_IDS);
		expect(ids.slice(0, 28)).toEqual(
			Array.from({ length: 28 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`),
		);
		expect(ids.slice(28, 47)).toEqual(
			Array.from({ length: 19 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`),
		);
		expect(ids.slice(47)).toEqual(["E01", "E02", "E03", "E04"]);
		expect(rules.every((rule) => rule.enabled && rule.origin === "default")).toBe(true);
		expect(rules.filter((rule) => rule.kind === "command")).toHaveLength(24);
		expect(rules.filter((rule) => rule.kind === "script")).toHaveLength(2);
		expect(rules.filter((rule) => rule.kind === "shell")).toHaveLength(2);
		expect(rules.filter((rule) => rule.kind === "tool")).toHaveLength(19);
		expect(rules.filter((rule) => rule.kind === "compatibility")).toHaveLength(4);
	});

	it("returns a fresh array without exposing mutable rule objects", () => {
		const first = createDefaultPermissionRules();
		first.pop();
		const second = createDefaultPermissionRules();
		expect(second).toHaveLength(51);
		expect(Object.isFrozen(second[0])).toBe(true);
		expect(Reflect.set(second[0]!, "enabled", false)).toBe(false);
		expect(normalizePermissionRules(second)).toHaveLength(51);
	});
});

describe("normalizePermissionRules", () => {
	it("accepts an explicit empty array as no rules", () => {
		expect(normalizePermissionRules([])).toEqual([]);
	});

	it.each([
		["a non-array", {}],
		["a duplicate id", [userRule(), userRule()]],
		["an unknown field", [userRule({ surprise: true })]],
		["an invalid kind", [userRule({ kind: "wildcard" })]],
		["an invalid origin", [userRule({ origin: "system" })]],
		["an invalid mode", [userRule({ modes: ["always"] })]],
		["an empty mode list", [userRule({ modes: [] })]],
		["an invalid scope", [userRule({ scope: "everything" })]],
		["a relative directory", [userRule({ scope: "directories", directories: ["relative/path"] })]],
		["a shell command outside the structural set", [userRule({ kind: "shell", command: "|" })]],
		["a command without an argv", [userRule({ command: "" })]],
		["a command with shell syntax", [userRule({ command: "ls > out" })]],
		["a tool rule without a tool name", [userRule({ kind: "tool", command: undefined })]],
		[
			"a malformed network target",
			[userRule({ allowNetwork: true, networkTargets: [{ hostname: "*", port: 443 }] })],
		],
	] as const)("rejects %s", (_name, value) => {
		expect(() => normalizePermissionRules(value)).toThrow();
	});

	it("matches protocol limits for UTF-8 names and directory lists", () => {
		expect(normalizePermissionRules([userRule({ name: "读".repeat(85) })])).toHaveLength(1);
		expect(() => normalizePermissionRules([userRule({ name: "读".repeat(86) })])).toThrow(/too long/u);
		const directories = Array.from({ length: 33 }, (_, index) => `/tmp/${index}`);
		expect(() => normalizePermissionRules([userRule({ directories })])).toThrow(/too many.*directories/u);
	});

	it.each([
		userRule({ modes: ["ask"] }),
		userRule({ scope: "memory" }),
		userRule({ scope: "session" }),
		userRule({ scope: "declared" }),
	])("rejects command modes and resource kinds that the editor cannot grant", (value) => {
		expect(() => normalizePermissionRules([value])).toThrow();
	});

	it("caps the total and user rule lists", () => {
		const total = Array.from({ length: MAX_PERMISSION_RULES + 1 }, (_, index) =>
			userRule({ id: `u${index}`, command: "curl" }),
		);
		expect(() => normalizePermissionRules(total)).toThrow(/too many permission rules/u);
		const users = Array.from({ length: MAX_USER_PERMISSION_RULES + 1 }, (_, index) => userRule({ id: `u${index}` }));
		expect(() => normalizePermissionRules(users)).toThrow(/too many user permission rules/u);
	});

	it("normalizes commands, directories and network targets", () => {
		const [rule] = normalizePermissionRules([
			userRule({
				command: "  git   status  ",
				modes: ["auto", "auto"],
				directories: ["/tmp/b", "/tmp/a", "/tmp/a"],
				allowNetwork: true,
				networkTargets: [{ hostname: "Example.com", port: 443 }],
			}),
		]);
		expect(rule).toMatchObject({
			command: "git status",
			modes: ["auto"],
			directories: ["/tmp/a", "/tmp/b"],
			networkTargets: [{ hostname: "example.com", port: 443 }],
		});
		expect(Object.isFrozen(rule)).toBe(true);
		expect(Object.isFrozen(rule?.directories)).toBe(true);
	});

	it("accepts UUID ids and the 128-character protocol limit", () => {
		const uuid = randomUUID();
		expect(normalizePermissionRules([userRule({ id: uuid })])[0]?.id).toBe(uuid);
		const maximum = "a".repeat(MAX_PERMISSION_RULE_ID_LENGTH);
		expect(normalizePermissionRules([userRule({ id: maximum })])[0]?.id).toBe(maximum);
		expect(() =>
			normalizePermissionRules([userRule({ id: "a".repeat(MAX_PERMISSION_RULE_ID_LENGTH + 1) })]),
		).toThrow();
	});

	it("keeps the full legacy prefix length available as a rule name", () => {
		const legacyName = `printf ${"x".repeat(230)}`;
		expect(legacyName.length).toBeGreaterThan(200);
		expect(normalizePermissionRules([userRule({ name: legacyName })])[0]?.name).toBe(legacyName);
		expect(normalizePermissionRules([userRule({ name: "x".repeat(256) })])).toHaveLength(1);
		expect(() => normalizePermissionRules([userRule({ name: "x".repeat(257) })])).toThrow();
	});
});

describe("permissionRuleView", () => {
	const view = (rule: Record<string, unknown>) => {
		const [normalized] = normalizePermissionRules([userRule(rule)]);
		return permissionRuleView(normalized!);
	};

	it("marks default commands and aliases as supported without a second capability list", () => {
		for (const rule of createDefaultPermissionRules()) {
			expect(permissionRuleView(rule)).toMatchObject({ id: rule.id, support: "supported" });
		}
		for (const command of ["git status", "python3.12 -c x", "nodejs -e x"]) {
			expect(view({ command }).support).toBe("supported");
		}
	});

	it.each([
		["docker ps", "command"],
		["git checkout main", "command"],
		["ruby -e x", "script"],
		["unknown_tool", "tool"],
	] as const)("marks unsupported %s as legacy-unsupported", (command, kind) => {
		const value = view({
			kind,
			command,
			toolName: kind === "tool" ? command : undefined,
			...(kind === "script" ? { scope: "workspace" } : {}),
		});
		expect(value.support).toBe("legacy-unsupported");
		expect(value.supportReason).toBeTruthy();
	});

	it("supports only the four known compatibility identities", () => {
		const [known] = normalizePermissionRules([
			userRule({ id: "E01", kind: "compatibility", command: undefined, scope: "all" }),
		]);
		expect(permissionRuleView(known!)).toMatchObject({ support: "supported" });
		const [unknown] = normalizePermissionRules([
			userRule({ id: "E99", kind: "compatibility", command: undefined, scope: "all" }),
		]);
		expect(permissionRuleView(unknown!)).toMatchObject({ support: "legacy-unsupported" });
	});
});

describe("permission rule cross-field semantics", () => {
	function toolRule(toolName: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return userRule({
			id: `user-tool-${toolName}`,
			kind: "tool",
			command: undefined,
			toolName,
			scope: "workspace",
			...overrides,
		});
	}

	it.each([
		["write with Ask mode", toolRule("write", { modes: ["ask", "auto"] })],
		["write with a directory scope", toolRule("write", { scope: "directories", directories: ["/tmp/work"] })],
		["edit outside the workspace", toolRule("edit", { scope: "directories", directories: ["/tmp/work"] })],
		["read with a memory scope", toolRule("read", { scope: "memory" })],
		["grep with a session scope", toolRule("grep", { scope: "session" })],
		["memory search outside memory", toolRule("memory_search", { scope: "workspace" })],
		["a session tool outside the session", toolRule("set_tasks", { scope: "workspace" })],
		["delivery outside the workspace", toolRule("deliver_file", { scope: "session" })],
		[
			"an Ask-mode script rule",
			userRule({ kind: "script", command: "python -c x", scope: "workspace", modes: ["ask", "auto"] }),
		],
		[
			"a directory-scoped shell rule",
			userRule({ kind: "shell", command: "[[", scope: "directories", directories: ["/tmp/work"], modes: ["auto"] }),
		],
		[
			"E01 pretending to be declared",
			userRule({ id: "E01", kind: "compatibility", command: "officecli", scope: "declared" }),
		],
		[
			"E02 pretending to be all paths",
			userRule({ id: "E02", kind: "compatibility", command: undefined, toolName: "mcp", scope: "all" }),
		],
		[
			"E04 gaining Ask mode",
			userRule({
				id: "E04",
				kind: "compatibility",
				command: undefined,
				toolName: "external",
				modes: ["ask", "auto"],
				scope: "declared",
			}),
		],
	] as const)("rejects %s", (_name, rule) => {
		expect(() => normalizePermissionRules([rule])).toThrow();
	});

	it("keeps the approved tool, script, and compatibility shapes", () => {
		expect(
			normalizePermissionRules([
				toolRule("read", { scope: "directories", directories: ["/tmp/work"] }),
				toolRule("ls", { scope: "workspace" }),
				toolRule("memory_read", { scope: "memory" }),
				toolRule("submit_plan", { scope: "session" }),
				toolRule("deliver_file", { scope: "workspace" }),
				userRule({ id: "user-node", kind: "script", command: "node -e x", scope: "workspace", modes: ["auto"] }),
				userRule({ id: "user-shell", kind: "shell", command: "assignment", scope: "workspace", modes: ["auto"] }),
				userRule({ id: "E01", kind: "compatibility", command: "officecli", modes: ["auto"], scope: "all" }),
				userRule({
					id: "E02",
					kind: "compatibility",
					command: undefined,
					toolName: "mcp",
					modes: ["ask"],
					scope: "declared",
				}),
			]),
		).toHaveLength(9);
	});

	it("keeps migrated command rules on their historical all-path scope", () => {
		const [rule] = normalizePermissionRules([userRule({ command: "docker ps", scope: "all" })]);
		expect(rule).toMatchObject({ kind: "command", command: "docker ps", scope: "all", modes: ["auto"] });
	});

	it("leaves unknown compatibility rules visible but unsupported", () => {
		const [rule] = normalizePermissionRules([
			userRule({ id: "E99", kind: "compatibility", command: undefined, scope: "workspace" }),
		]);
		expect(permissionRuleView(rule!)).toMatchObject({ support: "legacy-unsupported" });
	});
});
