import type { PermissionRuleView, PermissionScopePreview } from "@metis/app-protocol";

/** Default rules are managed separately from the 64 custom-rule budget. */
export const MAX_USER_PERMISSION_RULES = 64;
export const MAX_PERMISSION_RULES = 115;

export type RuleTranslate = (key: string, options?: Record<string, unknown>) => string;

export type { PermissionScopePreview };

/**
 * Core ships curated Chinese names for default rules. Only an exact match on the
 * original default name is translated; user-created or renamed rules keep their
 * own text.
 */
const DEFAULT_RULE_NAME_KEYS: Readonly<Record<string, string>> = {
	读取文件: "Read file",
	搜索文本: "Search text",
	查找文件: "Find files",
	列出目录: "List directory",
	等待智能体状态: "Wait for agent status",
	写入文件: "Write file",
	编辑文件: "Edit file",
	搜索记忆: "Search memory",
	读取记忆: "Read memory",
	更新记忆: "Update memory",
	交付文件: "Deliver file",
	更新任务列表: "Update task list",
	向用户提问: "Ask the user",
	查找工具: "Discover tools",
	查看智能体状态: "Inspect agent status",
	查看目标: "View goal",
	创建目标: "Create goal",
	更新目标: "Update goal",
	提交方案: "Submit plan",
	"OfficeCLI 命令": "OfficeCLI commands",
	OfficeCLI: "OfficeCLI commands",
	"MCP 无写入声明的操作": "MCP operations without write declarations",
	扩展与宿主工具普通读取: "Extension and host tool reads",
	外部工具其他低风险操作: "Other low-risk external tool actions",
	"Python 只读内联脚本": "Python read-only inline script",
	"Node 只读内联脚本": "Node read-only inline script",
	"Shell 静态赋值": "Shell static assignment",
};

/** The settings page only manages Shell/OfficeCLI command entries. */
export function isCommandRule(rule: PermissionRuleView): boolean {
	return rule.command !== undefined && rule.command.length > 0;
}

export function ruleName(rule: PermissionRuleView): string {
	return rule.name || rule.command || rule.toolName || rule.id;
}

/** Localized list label; never translates user rule names. */
export function ruleDisplayName(rule: PermissionRuleView, t: RuleTranslate): string {
	if (rule.origin === "default") {
		const key = DEFAULT_RULE_NAME_KEYS[rule.name];
		if (key) return t(key);
	}
	return ruleName(rule);
}

export function ruleModesText(rule: PermissionRuleView): string {
	const ask = rule.modes.includes("ask");
	const auto = rule.modes.includes("auto");
	if (ask && auto) return "Ask / Auto";
	if (ask) return "Ask";
	return "Auto";
}

export type RuleResource =
	| "command"
	| "read-skill"
	| "write-workspace"
	| "memory"
	| "delivery"
	| "session"
	| "plain-workspace"
	| "tool-scope"
	| "compatibility";

/** Categories come from the real tool identity, not a second permission allowlist. */
const READ_PATH_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SESSION_TOOLS = new Set([
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

export function ruleResourceOf(
	kind: PermissionRuleView["kind"],
	toolName: string | undefined,
	scope: PermissionRuleView["scope"],
): RuleResource {
	if (kind === "compatibility") return "compatibility";
	if (kind === "command" || kind === "shell" || kind === "script") return "command";
	if (kind !== "tool") return "plain-workspace";
	if (scope === "memory" || toolName?.startsWith("memory_")) return "memory";
	if (toolName === "deliver_file") return "delivery";
	if (scope === "session" || SESSION_TOOLS.has(toolName ?? "")) return "session";
	if (READ_PATH_TOOLS.has(toolName ?? "")) return "read-skill";
	if (toolName === "write" || toolName === "edit") return "write-workspace";
	if (scope === "workspace") return "plain-workspace";
	return "tool-scope";
}

export function ruleResource(rule: PermissionRuleView): RuleResource {
	return ruleResourceOf(rule.kind, rule.toolName, rule.scope);
}

/**
 * E rules keep their original policy position, which is neither the workspace
 * scope nor a Shell-sandboxed execution.
 */
function compatibilityScopeText(rule: PermissionRuleView, t: RuleTranslate): string {
	switch (rule.id) {
		case "E01":
			return t("Existing OfficeCLI source and static arguments");
		case "E02":
			return t("Existing MCP declared scope");
		case "E03":
			return t("Existing extension and host tool scope");
		case "E04":
			return t("Existing external tool scope");
		default:
			return t("Existing tool scope");
	}
}

export function ruleScopeText(rule: PermissionRuleView, t: RuleTranslate, hasConversation = true): string {
	if (rule.kind === "compatibility") return compatibilityScopeText(rule, t);
	switch (rule.scope) {
		case "workspace": {
			const resource = ruleResource(rule);
			if (resource === "read-skill") {
				return t(
					hasConversation
						? "Current workspace + loaded skills (read-only)"
						: "Follows the conversation workspace and loaded skills (read-only)",
				);
			}
			if (resource === "delivery") {
				return t("Current workspace source + session delivery cache");
			}
			if (resource === "command") {
				return t(
					hasConversation
						? "Current workspace + session work directory"
						: "Follows the conversation workspace and session work directory",
				);
			}
			if (resource === "memory") return t("Metis memory");
			if (resource === "session") return t("Current session");
			return t(hasConversation ? "Current workspace" : "Follows the conversation workspace");
		}
		case "directories":
			return rule.directories.length ? rule.directories.join(", ") : t("Selected directories");
		case "memory":
			return t("Metis memory");
		case "session":
			return t("Current session");
		case "declared":
			return t("Existing tool scope");
		case "all":
			return t("All ordinary paths (existing rule)");
	}
}

/** Compatibility rows describe the tool’s existing execution boundary. */
export function ruleScopeNote(rule: PermissionRuleView, t: RuleTranslate): string | null {
	if (rule.kind !== "compatibility") return null;
	return rule.id === "E01"
		? t("Keeps existing OfficeCLI permission; Shell follows the current mode.")
		: t("Keeps this tool’s existing permission conditions and execution environment.");
}

export interface ScopeRangeEntry {
	readonly label: string;
	readonly path: string;
}

interface ScopeRangeInput {
	readonly kind: PermissionRuleView["kind"];
	readonly toolName?: string;
	readonly scope: PermissionRuleView["scope"];
	readonly directories: readonly string[];
	readonly preview?: PermissionScopePreview;
	readonly hasConversation: boolean;
}

function pushRoots(entries: ScopeRangeEntry[], label: string, roots: readonly string[] | undefined): void {
	for (const path of roots ?? []) entries.push({ label, path });
}

/**
 * Lists the real roots that a rule can reach. Without a conversation the page
 * describes the dynamic scope instead of guessing directories.
 */
export function scopeRangeEntries(input: ScopeRangeInput, t: RuleTranslate): readonly ScopeRangeEntry[] {
	if (input.kind === "compatibility") return [];
	if (input.scope === "directories") {
		return input.directories.map((path) => ({ label: t("Selected directories"), path }));
	}
	if (!input.hasConversation) return [];
	const preview = input.preview;
	if (!preview) return [];
	const entries: ScopeRangeEntry[] = [];
	const resource = ruleResourceOf(input.kind, input.toolName, input.scope);
	switch (input.scope) {
		case "workspace":
			pushRoots(entries, t("Workspace"), preview.workspaceRoots);
			if (resource === "read-skill") pushRoots(entries, t("Skills (read-only)"), preview.skillReadRoots);
			if (resource === "command") pushRoots(entries, t("Session work"), preview.sessionWorkRoots);
			if (resource === "delivery") pushRoots(entries, t("Delivery cache"), preview.deliveryRoots);
			break;
		case "memory":
			pushRoots(entries, t("Memory"), preview.memoryRoots);
			break;
		case "session":
		case "declared":
		case "all":
			break;
	}
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const key = `${entry.label}\u0000${entry.path}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function filterRules(
	rules: readonly PermissionRuleView[],
	query: string,
	displayName: (rule: PermissionRuleView) => string = ruleName,
): readonly PermissionRuleView[] {
	const needle = query.trim().toLocaleLowerCase();
	const sorted = [...rules].sort((left, right) =>
		displayName(left).localeCompare(displayName(right), undefined, { sensitivity: "base" }),
	);
	if (!needle) return sorted;
	return sorted.filter((rule) => {
		const haystack = [
			rule.name,
			displayName(rule),
			rule.command ?? "",
			rule.toolName ?? "",
			...rule.directories,
			(rule.networkTargets ?? []).map((target) => `${target.hostname}:${target.port}`).join(" "),
		]
			.join(" ")
			.toLocaleLowerCase();
		return haystack.includes(needle);
	});
}

export function userRuleCount(rules: readonly PermissionRuleView[]): number {
	return rules.filter((rule) => rule.origin === "user").length;
}

export function enabledRuleCount(rules: readonly PermissionRuleView[]): number {
	return rules.filter((rule) => rule.enabled && rule.support === "supported").length;
}

/** Drops view-only fields before the rule goes back to the server. */
export function permissionRuleInput(rule: PermissionRuleView): Omit<PermissionRuleView, "support" | "supportReason"> {
	const { support, supportReason, ...input } = rule;
	void support;
	void supportReason;
	return input;
}

function ruleFingerprint(rule: PermissionRuleView): string {
	return JSON.stringify({
		kind: rule.kind,
		name: rule.name,
		modes: [...rule.modes].sort(),
		scope: rule.scope,
		directories: rule.directories,
		command: rule.command ?? null,
		toolName: rule.toolName ?? null,
		allowNetwork: rule.allowNetwork,
		networkTargets: rule.networkTargets ?? [],
	});
}

export type RestorableDefaultState = "missing" | "disabled" | "modified";

export interface RestorableDefault {
	readonly rule: PermissionRuleView;
	readonly state: RestorableDefaultState;
	/** Missing and disabled defaults start checked; modified defaults need an explicit opt-in. */
	readonly defaultSelected: boolean;
}

export function restorableDefaults(
	defaults: readonly PermissionRuleView[],
	current: readonly PermissionRuleView[],
): readonly RestorableDefault[] {
	const byId = new Map(current.map((rule) => [rule.id, rule]));
	return defaults.flatMap<RestorableDefault>((rule) => {
		const existing = byId.get(rule.id);
		if (!existing) return [{ rule, state: "missing" as const, defaultSelected: true }];
		if (!existing.enabled) return [{ rule: existing, state: "disabled" as const, defaultSelected: true }];
		if (ruleFingerprint(rule) !== ruleFingerprint(existing)) {
			return [{ rule: existing, state: "modified" as const, defaultSelected: false }];
		}
		return [];
	});
}

export function applyDefaultRestore(
	current: readonly PermissionRuleView[],
	defaults: readonly PermissionRuleView[],
	selectedIds: ReadonlySet<string>,
): readonly PermissionRuleView[] {
	const selected = new Map(defaults.filter((rule) => selectedIds.has(rule.id)).map((rule) => [rule.id, rule]));
	const next = current.map((rule) => {
		const replacement = selected.get(rule.id);
		if (!replacement) return rule;
		selected.delete(rule.id);
		return { ...replacement, enabled: true };
	});
	return [...next, ...[...selected.values()].map((rule) => ({ ...rule, enabled: true }))];
}
