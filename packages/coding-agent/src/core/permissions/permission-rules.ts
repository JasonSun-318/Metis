import { isAbsolute } from "node:path";
import {
	type AutoCommandNetworkTarget,
	MAX_AUTO_COMMAND_LENGTH,
	MAX_AUTO_COMMAND_NETWORK_TARGETS,
	normalizeNetworkTargets,
	parseSimpleShellCommand,
} from "./auto-command-rules.ts";

export type PermissionRuleKind = "command" | "tool" | "script" | "shell" | "compatibility";
export type PermissionRuleScope = "workspace" | "directories" | "memory" | "session" | "declared" | "all";
export type PermissionRuleMode = "ask" | "auto";

export interface PermissionRule {
	readonly id: string;
	readonly kind: PermissionRuleKind;
	readonly origin: "default" | "user";
	readonly name: string;
	readonly enabled: boolean;
	readonly modes: readonly PermissionRuleMode[];
	readonly scope: PermissionRuleScope;
	readonly directories: readonly string[];
	readonly command?: string;
	readonly toolName?: string;
	readonly allowNetwork: boolean;
	readonly networkTargets?: readonly AutoCommandNetworkTarget[];
}

export interface PermissionRuleView extends PermissionRule {
	readonly support: "supported" | "legacy-unsupported";
	readonly supportReason?: string;
}

export const MAX_PERMISSION_RULES = 115;
export const MAX_USER_PERMISSION_RULES = 64;
export const MAX_PERMISSION_RULE_ID_LENGTH = 128;

const KINDS: readonly PermissionRuleKind[] = ["command", "tool", "script", "shell", "compatibility"];
const ORIGINS: readonly PermissionRule["origin"][] = ["default", "user"];
const MODES: readonly PermissionRuleMode[] = ["ask", "auto"];
const SCOPES: readonly PermissionRuleScope[] = ["workspace", "directories", "memory", "session", "declared", "all"];
const RULE_KEYS = ["id", "kind", "origin", "name", "enabled", "modes", "scope", "directories", "allowNetwork"] as const;
const OPTIONAL_RULE_KEYS = ["command", "toolName", "networkTargets"] as const;
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/u;
const MAX_RULE_NAME_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_DIRECTORY_LENGTH = 32_768;

const READ_TOOL_RULE_NAMES: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOL_RULE_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);
const SESSION_RULE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"set_tasks",
	"ask_user",
	"tool_search",
	"inspect_agents",
	"get_goal",
	"create_goal",
	"update_goal",
	"submit_plan",
	"wait_agents",
]);
/** The four compatibility rules keep their original scope and mode ceiling. */
const COMPATIBILITY_RULE_SHAPES: Readonly<
	Record<string, { readonly scope: PermissionRuleScope; readonly modes: readonly PermissionRuleMode[] }>
> = {
	E01: { scope: "all", modes: ["ask", "auto"] },
	E02: { scope: "declared", modes: ["ask", "auto"] },
	E03: { scope: "declared", modes: ["ask", "auto"] },
	E04: { scope: "declared", modes: ["auto"] },
};

/** Default C/T/E rules documented in the permissions settings design. */
const C_RULES: readonly PermissionRule[] = Object.freeze([
	commandRule("C01", "pwd", "pwd", ["auto"]),
	commandRule("C02", "cd", "cd", ["auto"]),
	commandRule("C03", "ls", "ls", ["auto"]),
	commandRule("C04", "cat", "cat", ["auto"]),
	commandRule("C05", "head", "head", ["auto"]),
	commandRule("C06", "tail", "tail", ["auto"]),
	commandRule("C07", "rg", "rg", ["auto"]),
	commandRule("C08", "grep", "grep", ["auto"]),
	commandRule("C09", "find", "find", ["auto"]),
	commandRule("C10", "wc", "wc", ["auto"]),
	commandRule("C11", "sort", "sort", ["auto"]),
	commandRule("C12", "uniq", "uniq", ["auto"]),
	commandRule("C13", "cut", "cut", ["auto"]),
	commandRule("C14", "echo", "echo", ["auto"]),
	commandRule("C15", "printf", "printf", ["auto"]),
	commandRule("C16", "test", "test", ["auto"]),
	commandRule("C17", "[", "[", ["auto"]),
	baseRule("C18", "shell", "[[ … ]]", ["auto"], "workspace", { command: "[[" }),
	commandRule("C19", "true", "true", ["auto"]),
	commandRule("C20", "false", "false", ["auto"]),
	commandRule("C21", ":", ":", ["auto"]),
	commandRule("C22", "git status", "git status", ["auto"]),
	commandRule("C23", "git diff", "git diff", ["auto"]),
	commandRule("C24", "git log", "git log", ["auto"]),
	commandRule("C25", "git show", "git show", ["auto"]),
	baseRule("C26", "script", "Python 只读内联脚本", ["auto"], "workspace", { command: "python" }),
	baseRule("C27", "script", "Node 只读内联脚本", ["auto"], "workspace", { command: "node" }),
	baseRule("C28", "shell", "Shell 静态赋值", ["auto"], "workspace", { command: "assignment" }),
]);

const T_RULES: readonly PermissionRule[] = Object.freeze([
	toolRule("T01", "读取文件", "read", ["ask", "auto"], "workspace"),
	toolRule("T02", "搜索文本", "grep", ["ask", "auto"], "workspace"),
	toolRule("T03", "查找文件", "find", ["ask", "auto"], "workspace"),
	toolRule("T04", "列出目录", "ls", ["ask", "auto"], "workspace"),
	toolRule("T05", "等待智能体状态", "wait_agents", ["ask", "auto"], "session"),
	toolRule("T06", "写入文件", "write", ["auto"], "workspace"),
	toolRule("T07", "编辑文件", "edit", ["auto"], "workspace"),
	toolRule("T08", "搜索记忆", "memory_search", ["ask", "auto"], "memory"),
	toolRule("T09", "读取记忆", "memory_read", ["ask", "auto"], "memory"),
	toolRule("T10", "更新记忆", "memory_write", ["ask", "auto"], "memory"),
	toolRule("T11", "交付文件", "deliver_file", ["ask", "auto"], "workspace"),
	toolRule("T12", "更新任务列表", "set_tasks", ["ask", "auto"], "session"),
	toolRule("T13", "向用户提问", "ask_user", ["ask", "auto"], "session"),
	toolRule("T14", "查找工具", "tool_search", ["ask", "auto"], "session"),
	toolRule("T15", "查看智能体状态", "inspect_agents", ["ask", "auto"], "session"),
	toolRule("T16", "查看目标", "get_goal", ["ask", "auto"], "session"),
	toolRule("T17", "创建目标", "create_goal", ["ask", "auto"], "session"),
	toolRule("T18", "更新目标", "update_goal", ["ask", "auto"], "session"),
	toolRule("T19", "提交方案", "submit_plan", ["ask", "auto"], "session"),
]);

const E_RULES: readonly PermissionRule[] = Object.freeze([
	baseRule("E01", "compatibility", "OfficeCLI 命令", ["ask", "auto"], "all", { command: "officecli" }),
	baseRule("E02", "compatibility", "MCP 无写入声明的操作", ["ask", "auto"], "declared", { toolName: "mcp" }),
	baseRule("E03", "compatibility", "扩展与宿主工具普通读取", ["ask", "auto"], "declared", {
		toolName: "external",
	}),
	baseRule("E04", "compatibility", "外部工具其他低风险操作", ["auto"], "declared", { toolName: "external" }),
]);

const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = Object.freeze([...C_RULES, ...T_RULES, ...E_RULES]);

function baseRule(
	id: string,
	kind: PermissionRuleKind,
	name: string,
	modes: readonly PermissionRuleMode[],
	scope: PermissionRuleScope,
	extra: Partial<PermissionRule> = {},
): PermissionRule {
	return Object.freeze({
		id,
		kind,
		origin: "default",
		name,
		enabled: true,
		modes: Object.freeze([...modes]),
		scope,
		directories: Object.freeze([]),
		allowNetwork: false,
		...extra,
	});
}

function commandRule(id: string, name: string, command: string, modes: readonly PermissionRuleMode[]): PermissionRule {
	return baseRule(id, "command", name, modes, "workspace", { command });
}

function toolRule(
	id: string,
	name: string,
	toolName: string,
	modes: readonly PermissionRuleMode[],
	scope: PermissionRuleScope,
): PermissionRule {
	return baseRule(id, "tool", name, modes, scope, { toolName });
}

export const DEFAULT_PERMISSION_RULE_IDS: readonly string[] = Object.freeze(
	DEFAULT_PERMISSION_RULES.map((rule) => rule.id),
);

/** Exactly 51 enabled defaults: 28 commands, 19 tool operations, 4 compatibility rules. */
export function createDefaultPermissionRules(): PermissionRule[] {
	return [...DEFAULT_PERMISSION_RULES];
}

export function isSupportedToolRuleName(toolName: string): boolean {
	return T_RULES.some((rule) => rule.toolName === toolName);
}

const SUPPORTED_EXECUTABLES: ReadonlySet<string> = new Set([
	"pwd",
	"cd",
	"ls",
	"cat",
	"head",
	"tail",
	"rg",
	"grep",
	"find",
	"wc",
	"sort",
	"uniq",
	"cut",
	"echo",
	"printf",
	"test",
	"[",
	"true",
	"false",
	":",
	"curl",
]);

const SUPPORTED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "log", "show"]);
const PYTHON_ALIAS_PATTERN = /^(?:python|pypy)(?:\d+(?:\.\d+)?)?$/u;
const NODE_ALIAS_PATTERN = /^node(?:js)?$/u;

export function scriptFamilyFor(command: string | undefined): "python" | "node" | undefined {
	if (!command) return undefined;
	const argv = parseSimpleShellCommand(command, MAX_AUTO_COMMAND_LENGTH);
	const executable = argv?.[0];
	if (!executable) return undefined;
	if (PYTHON_ALIAS_PATTERN.test(executable)) return "python";
	if (NODE_ALIAS_PATTERN.test(executable)) return "node";
	return undefined;
}

function commandRuleSupport(prefix: readonly string[]): string | undefined {
	const executable = prefix[0];
	if (!executable) return "The rule has no command prefix.";
	if (executable === "git") {
		return prefix.length >= 2 && SUPPORTED_GIT_SUBCOMMANDS.has(prefix[1]!)
			? undefined
			: "Only the supported read-only git subcommands can match a rule.";
	}
	if (PYTHON_ALIAS_PATTERN.test(executable) || NODE_ALIAS_PATTERN.test(executable)) return undefined;
	if (SUPPORTED_EXECUTABLES.has(executable)) return undefined;
	return "The current shell analyzer does not support this command prefix.";
}

function unsupported(rule: PermissionRule, reason: string): PermissionRuleView {
	return { ...rule, support: "legacy-unsupported", supportReason: reason };
}

function supported(rule: PermissionRule): PermissionRuleView {
	return { ...rule, support: "supported" };
}

/**
 * Derive whether the current trusted analyzer can ever directly authorize this
 * rule. The client never maintains a second capability list.
 */
export function permissionRuleView(rule: PermissionRule): PermissionRuleView {
	const normalized = normalizePermissionRule(rule);
	switch (normalized.kind) {
		case "command": {
			const prefix = parseSimpleShellCommand(normalized.command ?? "");
			if (!prefix) return unsupported(normalized, "The command prefix is empty or not a simple argv.");
			const reason = commandRuleSupport(prefix);
			return reason ? unsupported(normalized, reason) : supported(normalized);
		}
		case "script":
			return scriptFamilyFor(normalized.command)
				? supported(normalized)
				: unsupported(normalized, "Only the supported Python and Node inline-script aliases apply.");
		case "shell":
			return normalized.command === "[[" || normalized.command === "assignment"
				? supported(normalized)
				: unsupported(normalized, "Only the supported structural shell nodes apply.");
		case "tool":
			return normalized.toolName && isSupportedToolRuleName(normalized.toolName)
				? supported(normalized)
				: unsupported(normalized, "The current runtime has no matching tool operation.");
		case "compatibility":
			return isKnownCompatibilityRule(normalized.id)
				? supported(normalized)
				: unsupported(normalized, "Only the four existing compatibility rules apply.");
		default:
			return unsupported(normalized, "Unsupported rule kind.");
	}
}

export function isKnownCompatibilityRule(id: string): boolean {
	return id === "E01" || id === "E02" || id === "E03" || id === "E04";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maximum: number): string {
	if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
	const text = value.trim();
	if (text.length === 0) throw new TypeError(`${field} must not be empty`);
	if (text.includes("\0")) throw new TypeError(`${field} must not contain NUL bytes`);
	if (Buffer.byteLength(text, "utf8") > maximum) throw new TypeError(`${field} is too long`);
	return text;
}

function normalizeModes(value: unknown): readonly PermissionRuleMode[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new TypeError("permission rule modes must be a non-empty array");
	const modes: PermissionRuleMode[] = [];
	for (const mode of value) {
		if (!MODES.includes(mode as PermissionRuleMode)) throw new TypeError("invalid permission rule mode");
		if (!modes.includes(mode as PermissionRuleMode)) modes.push(mode as PermissionRuleMode);
	}
	return Object.freeze(MODES.filter((mode) => modes.includes(mode)));
}

function normalizeDirectories(value: unknown): readonly string[] {
	if (!Array.isArray(value)) throw new TypeError("permission rule directories must be an array");
	if (value.length > 32) throw new TypeError("too many permission rule directories");
	const seen = new Set<string>();
	const directories: string[] = [];
	for (const entry of value) {
		const directory = requiredText(entry, "permission rule directory", MAX_DIRECTORY_LENGTH);
		if (!isAbsolute(directory)) throw new TypeError("permission rule directories must be absolute");
		if (!seen.has(directory)) {
			seen.add(directory);
			directories.push(directory);
		}
	}
	return Object.freeze(directories.sort());
}

function normalizeRuleCommand(value: unknown, kind: PermissionRuleKind): string {
	const command = requiredText(value, "permission rule command", MAX_AUTO_COMMAND_LENGTH);
	if (kind === "shell") {
		if (command !== "[[" && command !== "assignment") throw new TypeError("invalid structural permission rule");
		return command;
	}
	const argv = parseSimpleShellCommand(command);
	if (!argv) throw new TypeError("invalid permission rule command");
	if (argv.some((token) => /\s/u.test(token))) throw new TypeError("rule tokens must not contain whitespace");
	return argv.join(" ");
}

/**
 * Structural protocol validation cannot see how fields interact. Enforce the
 * real mode/scope matrix of each rule kind here, the single core entry point,
 * so the client cannot persist a rule that claims a capability it never has.
 * Legacy command rules intentionally keep `scope: "all"`: their original
 * prefixes were never directory scoped and must not be narrowed by migration.
 */
function assertRuleSemantics(
	id: string,
	kind: PermissionRuleKind,
	scope: PermissionRuleScope,
	modes: readonly PermissionRuleMode[],
	toolName: string | undefined,
): void {
	if (kind === "command") {
		if (!["workspace", "directories", "all"].includes(scope) || modes.includes("ask")) {
			throw new TypeError("command rules only apply to workspace or selected directories in Auto mode");
		}
		return;
	}
	if (kind === "script" || kind === "shell") {
		if (scope !== "workspace" || modes.includes("ask")) {
			throw new TypeError("script and shell rules only apply to the workspace in Auto mode");
		}
		return;
	}
	if (kind === "compatibility") {
		const shape = COMPATIBILITY_RULE_SHAPES[id];
		if (!shape) return;
		if (scope !== shape.scope || modes.some((mode) => !shape.modes.includes(mode))) {
			throw new TypeError("compatibility rule scope and modes must keep their existing behavior");
		}
		return;
	}
	if (kind !== "tool" || !toolName) return;
	if (WRITE_TOOL_RULE_NAMES.has(toolName)) {
		if (scope !== "workspace" || modes.includes("ask")) {
			throw new TypeError("write and edit rules only apply to the workspace in Auto mode");
		}
		return;
	}
	if (READ_TOOL_RULE_NAMES.has(toolName)) {
		if (scope !== "workspace" && scope !== "directories") {
			throw new TypeError("read tool rules only apply to the workspace or selected directories");
		}
		return;
	}
	if (toolName.startsWith("memory_") && scope !== "memory") {
		throw new TypeError("memory tool rules only apply to Metis memory");
	}
	if (SESSION_RULE_TOOL_NAMES.has(toolName) && scope !== "session") {
		throw new TypeError("session tool rules only apply to the current session");
	}
	if (toolName === "deliver_file" && scope !== "workspace") {
		throw new TypeError("delivery rules only apply to the current workspace");
	}
}

function normalizePermissionRule(value: unknown): PermissionRule {
	if (!isRecord(value)) throw new TypeError("invalid permission rule");
	const keys = Object.keys(value);
	const allowed = new Set<string>([...RULE_KEYS, ...OPTIONAL_RULE_KEYS]);
	if (keys.some((key) => !allowed.has(key))) throw new TypeError("invalid permission rule field");
	if (!keys.includes("id") || !keys.includes("kind") || !keys.includes("origin") || !keys.includes("name")) {
		throw new TypeError("invalid permission rule");
	}
	if (
		typeof value.enabled !== "boolean" ||
		typeof value.allowNetwork !== "boolean" ||
		!Array.isArray(value.modes) ||
		!Array.isArray(value.directories)
	) {
		throw new TypeError("invalid permission rule");
	}
	const id = requiredText(value.id, "permission rule id", MAX_PERMISSION_RULE_ID_LENGTH);
	if (!RULE_ID_PATTERN.test(id)) throw new TypeError("invalid permission rule id");
	if (!KINDS.includes(value.kind as PermissionRuleKind)) throw new TypeError("invalid permission rule kind");
	if (!ORIGINS.includes(value.origin as PermissionRule["origin"]))
		throw new TypeError("invalid permission rule origin");
	if (!SCOPES.includes(value.scope as PermissionRuleScope)) throw new TypeError("invalid permission rule scope");
	const kind = value.kind as PermissionRuleKind;
	const command = value.command === undefined ? undefined : normalizeRuleCommand(value.command, kind);
	const toolName =
		value.toolName === undefined
			? undefined
			: requiredText(value.toolName, "permission rule tool name", MAX_TOOL_NAME_LENGTH);
	if ((kind === "command" || kind === "script" || kind === "shell") && command === undefined) {
		throw new TypeError("invalid permission rule");
	}
	if (kind === "tool" && toolName === undefined) throw new TypeError("invalid permission rule");
	const networkTargets =
		value.networkTargets === undefined ? undefined : normalizeNetworkTargets(value.networkTargets);
	if (networkTargets && networkTargets.length > MAX_AUTO_COMMAND_NETWORK_TARGETS) {
		throw new TypeError("too many Auto command network targets");
	}
	const scope = value.scope as PermissionRuleScope;
	const modes = normalizeModes(value.modes);
	assertRuleSemantics(id, kind, scope, modes, toolName);
	return Object.freeze({
		id,
		kind,
		origin: value.origin as PermissionRule["origin"],
		name: requiredText(value.name, "permission rule name", MAX_RULE_NAME_LENGTH),
		enabled: value.enabled,
		modes,
		scope,
		directories: normalizeDirectories(value.directories),
		...(command === undefined ? {} : { command }),
		...(toolName === undefined ? {} : { toolName }),
		allowNetwork: value.allowNetwork,
		...(networkTargets ? { networkTargets } : {}),
	});
}

export function normalizePermissionRules(value: unknown): readonly PermissionRule[] {
	if (!Array.isArray(value)) throw new TypeError("Permission rules must be an array");
	if (value.length > MAX_PERMISSION_RULES) throw new TypeError("too many permission rules");
	const seen = new Set<string>();
	let userRules = 0;
	const rules: PermissionRule[] = [];
	for (const entry of value) {
		const rule = normalizePermissionRule(entry);
		if (seen.has(rule.id)) throw new TypeError("duplicate permission rule id");
		seen.add(rule.id);
		if (rule.origin === "user") {
			userRules += 1;
			if (userRules > MAX_USER_PERMISSION_RULES) throw new TypeError("too many user permission rules");
		}
		rules.push(rule);
	}
	return Object.freeze(rules);
}

export interface CompiledPermissionRules {
	readonly rules: readonly PermissionRule[];
	readonly byId: ReadonlyMap<string, PermissionRule>;
	readonly commands: readonly { readonly rule: PermissionRule; readonly prefix: readonly string[] }[];
	readonly scripts: readonly { readonly rule: PermissionRule; readonly family: "python" | "node" }[];
	readonly shells: readonly { readonly rule: PermissionRule; readonly structural: "test" | "assignment" }[];
	readonly tools: readonly PermissionRule[];
	readonly compatibility: readonly PermissionRule[];
}

export function compilePermissionRules(rules: readonly PermissionRule[]): CompiledPermissionRules {
	const commands: { rule: PermissionRule; prefix: readonly string[] }[] = [];
	const scripts: { rule: PermissionRule; family: "python" | "node" }[] = [];
	const shells: { rule: PermissionRule; structural: "test" | "assignment" }[] = [];
	const tools: PermissionRule[] = [];
	const compatibility: PermissionRule[] = [];
	const byId = new Map<string, PermissionRule>();
	for (const rule of rules) {
		byId.set(rule.id, rule);
		switch (rule.kind) {
			case "command": {
				const prefix = parseSimpleShellCommand(rule.command ?? "");
				if (prefix) commands.push({ rule, prefix });
				break;
			}
			case "script": {
				const family = scriptFamilyFor(rule.command);
				if (family) scripts.push({ rule, family });
				break;
			}
			case "shell":
				if (rule.command === "[[") shells.push({ rule, structural: "test" });
				else if (rule.command === "assignment") shells.push({ rule, structural: "assignment" });
				break;
			case "tool":
				tools.push(rule);
				break;
			case "compatibility":
				compatibility.push(rule);
				break;
		}
	}
	return Object.freeze({
		rules,
		byId,
		commands: Object.freeze(commands),
		scripts: Object.freeze(scripts),
		shells: Object.freeze(shells),
		tools: Object.freeze(tools),
		compatibility: Object.freeze(compatibility),
	});
}

export function permissionRuleMatchedView(rule: PermissionRule): { id: string; name: string; scope: string } {
	return Object.freeze({ id: rule.id, name: rule.name, scope: rule.scope });
}
