import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { getBundledToolsDir } from "../../config.ts";
import { canonicalizeActionPath } from "../../utils/paths.ts";
import {
	type AutoCommandRule,
	parseSimpleShellCommand,
	splitShellSegments,
	tokenizeShellWords,
} from "./auto-command-rules.ts";
import { MAX_SHELL_COMMAND_BYTES } from "./limits.ts";
import { assertWellFormedAction } from "./normalize.ts";
import {
	type CompiledPermissionRules,
	compilePermissionRules,
	createDefaultPermissionRules,
	type PermissionRule,
	permissionRuleMatchedView,
	scriptFamilyFor,
} from "./permission-rules.ts";
import { assertPermissionSettings, isFullAccess } from "./settings.ts";
import type {
	GrantRequest,
	MinimumReviewer,
	NormalizedPermissionAction,
	PermissionPolicyDecision,
	PermissionSettings,
	RiskLevel,
	ShellAnalysisFacts,
	ShellCommandTraceEntry,
} from "./types.ts";

export interface PermissionPolicyInput {
	readonly settings: PermissionSettings;
	readonly action: NormalizedPermissionAction;
	readonly autoCommandRules?: readonly AutoCommandRule[];
	/**
	 * Effective permission rules. Omitted keeps the legacy-compatible behavior:
	 * the 51 defaults plus `autoCommandRules`. An explicit empty array means no
	 * rule may authorize the action.
	 */
	readonly permissionRules?: readonly PermissionRule[];
	/**
	 * Engine-managed roots (e.g. the memory vault) outside the workspace. Builtin
	 * memory tools may write under them without review; every other tool that
	 * declares a write path inside them is denied as a protected write.
	 */
	readonly managedMemoryRoots?: readonly string[];
}

export interface PermissionDecisionRule {
	readonly id: string;
	readonly name: string;
	readonly scope: string;
}

const CRITICAL_EFFECTS = new Set([
	"sensitive-read",
	"elevation",
	"security-weakening",
	"payment",
	"production-mutation",
]);
const HIGH_EFFECTS = new Set(["external-side-effect", "destructive", "unknown"]);

const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(["memory_search", "memory_read", "memory_write"]);

function isPathInsideNormalized(parent: string, target: string): boolean {
	const child = relative(parent, target);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/**
 * Builtin memory tools manage the vault directly. The action qualifies only when
 * every declared write path stays inside a managed memory root and the claim
 * carries no command, network, or side effects.
 */
function isManagedMemoryAction(action: NormalizedPermissionAction, managedMemoryRoots: readonly string[]): boolean {
	return (
		action.provenance === "builtin" &&
		MEMORY_TOOL_NAMES.has(action.toolName) &&
		managedMemoryRoots.length > 0 &&
		action.writePaths.every((path) => managedMemoryRoots.some((root) => isPathInsideNormalized(root, path))) &&
		action.command === undefined &&
		action.networkEndpoints.length === 0 &&
		action.effects.length === 0
	);
}

function isOutsideWorkspace(action: NormalizedPermissionAction, managedMemoryRoots: readonly string[]): boolean {
	const roots = [...action.workspaceRoots, ...managedMemoryRoots];
	const scopedPaths = [...action.readPaths, ...action.writePaths, ...(action.command ? [action.cwd] : [])];
	return scopedPaths.some((path) => !roots.some((root) => isPathInsideNormalized(root, path)));
}

function protectedRootsFor(
	action: NormalizedPermissionAction,
	managedMemoryRoots: readonly string[],
): readonly string[] {
	return Object.freeze(
		[
			...new Set(
				action.workspaceRoots.flatMap((root) =>
					[".git", ".metis", ".codex", ".agents"].map((name) => join(root, name)),
				),
			),
			...managedMemoryRoots,
		].sort(),
	);
}

function grantRequestFor(
	settings: PermissionSettings,
	action: NormalizedPermissionAction,
	managedMemoryRoots: readonly string[],
): GrantRequest {
	const executionTarget =
		action.provenance === "mcp" || settings.sandboxPolicy === "external-sandbox"
			? "external"
			: action.provenance === "host" ||
					action.provenance === "extension" ||
					action.provenance === "sdk" ||
					settings.sandboxPolicy === "danger-full-access"
				? "host"
				: "sandbox";
	return Object.freeze({
		executionTarget,
		readRoots: action.readPaths,
		writeRoots: action.writePaths,
		protectedRoots: isFullAccess(settings) ? Object.freeze([]) : protectedRootsFor(action, managedMemoryRoots),
		networkEndpoints: action.networkEndpoints,
	});
}

function isExactEndpoint(endpoint: { readonly hostname: string; readonly port: number }): boolean {
	return (
		typeof endpoint.hostname === "string" &&
		endpoint.hostname.length > 0 &&
		!endpoint.hostname.includes("*") &&
		Number.isInteger(endpoint.port) &&
		endpoint.port >= 1 &&
		endpoint.port <= 65_535
	);
}

/**
 * Trusted analysis facts only exist for builtin bash actions: claims from MCP,
 * SDK, or extension tools can never inject shell analysis into the policy.
 */
function trustedShellAnalysis(action: NormalizedPermissionAction): ShellAnalysisFacts | undefined {
	return action.provenance === "builtin" && action.toolName === "bash" ? action.shellAnalysis : undefined;
}

function isRecursiveDeletionTrace(analysis: ShellAnalysisFacts): boolean {
	return analysis.commands.some((entry) => {
		const [rawExecutable, ...rest] = entry.argv;
		const executable = rawExecutable?.toLowerCase();
		if (executable === "rm") {
			return rest.some(
				(option) => option === "--recursive" || option.startsWith("--recursive=") || /^-[^-]*r/iu.test(option),
			);
		}
		if (executable === "remove-item") {
			return rest.some((option) => /^-recurse$/iu.test(option) || /^-(?:r|recurse)\b/iu.test(option));
		}
		return executable === "rmdir" && rest.some((option) => option.toLowerCase() === "/s");
	});
}

/**
 * Deny-only fallback for actions that arrive without trusted analysis facts.
 * It can only add a deny decision, never clear one, so it cannot whiten a
 * dangerous tail the way the old split-based safety shortcut did.
 */
function isRecursiveDeletionCommandText(command: string | undefined): boolean {
	if (!command) return false;
	const { words } = tokenizeShellWords(command);
	const [rawExecutable, ...rest] = words;
	const executable = rawExecutable?.replace(/^.*\//u, "").toLowerCase();
	if (executable === "rm") {
		return rest.some(
			(option) => option === "--recursive" || option.startsWith("--recursive=") || /^-[^-]*r/iu.test(option),
		);
	}
	if (executable === "remove-item") {
		return rest.some((option) => /^-recurse$/iu.test(option) || /^-(?:r|recurse)\b/iu.test(option));
	}
	return executable === "rmdir" && rest.some((option) => option.toLowerCase() === "/s");
}

function hardDenyReason(action: NormalizedPermissionAction): string | undefined {
	if (!action.networkEndpoints.every(isExactEndpoint)) return "Wildcard or malformed network grants are forbidden";
	const analysis = trustedShellAnalysis(action);
	const recursive =
		action.effects.includes("destructive") ||
		(analysis !== undefined && isRecursiveDeletionTrace(analysis)) ||
		(analysis === undefined && isRecursiveDeletionCommandText(action.command));
	if (!recursive) return undefined;

	const home = resolve(homedir());
	for (const target of action.writePaths) {
		if (target === parse(target).root) return "Recursive deletion of a filesystem root is forbidden";
		if (target === home) return "Recursive deletion of the user home is forbidden";
	}
	return undefined;
}

function protectedWriteReason(
	action: NormalizedPermissionAction,
	managedMemoryRoots: readonly string[],
): string | undefined {
	// The builtin memory tools own the managed roots; everyone else is denied.
	if (isManagedMemoryAction(action, managedMemoryRoots)) return undefined;
	const protectedRoots = protectedRootsFor(action, managedMemoryRoots);
	for (const target of action.writePaths) {
		if (protectedRoots.some((root) => target === root || isPathInsideNormalized(root, target))) {
			return "Writes to protected workspace metadata are forbidden";
		}
	}
	return undefined;
}

function ceilingDenyReason(settings: PermissionSettings, action: NormalizedPermissionAction): string | undefined {
	if (settings.sandboxPolicy !== "read-only") return undefined;
	const forbiddenEffects = action.effects.filter((effect) => effect !== "sensitive-read");
	if (action.writePaths.length > 0 || action.networkEndpoints.length > 0 || forbiddenEffects.length > 0) {
		const reasons = [
			...(action.writePaths.length > 0 ? ["write scope"] : []),
			...(action.networkEndpoints.length > 0 ? ["network"] : []),
			...forbiddenEffects,
		];
		return `The read-only sandbox ceiling forbids ${reasons.join(", ")}`;
	}
	return undefined;
}

export function riskLevelFor(
	action: NormalizedPermissionAction,
	grant: GrantRequest,
	managedMemoryRoots: readonly string[] = [],
): RiskLevel {
	if (action.effects.some((effect) => CRITICAL_EFFECTS.has(effect))) return "critical";
	if (action.effects.some((effect) => HIGH_EFFECTS.has(effect))) return "high";
	if (grant.networkEndpoints.length > 0 || isOutsideWorkspace(action, managedMemoryRoots)) return "medium";
	return "low";
}

function isReadOnlyMcp(action: NormalizedPermissionAction): boolean {
	return (
		action.provenance === "mcp" &&
		action.writePaths.length === 0 &&
		action.command === undefined &&
		action.effects.length === 0
	);
}

function minimumReviewerFor(
	settings: PermissionSettings,
	riskLevel: RiskLevel,
	action: NormalizedPermissionAction,
): MinimumReviewer {
	if (riskLevel === "critical" || action.effects.includes("destructive")) return "user";
	// Third-party and host mutations lack the builtin execution boundary. Preserve
	// their human review while retaining the existing known-read-only model path.
	if (
		action.provenance !== "builtin" &&
		(action.writePaths.length > 0 || action.networkEndpoints.length > 0 || action.effects.length > 0)
	)
		return "user";
	// Incomplete static analysis requires judgment, not an automatic escalation.
	// The reviewer still receives the exact bounded grant and cannot expand it.
	return settings.approvalPolicy === "auto-review" ? "model" : "user";
}

interface MatchedPermissionRule {
	readonly ruleIds: readonly string[];
	readonly matchedRule: PermissionDecisionRule;
}

const DEFAULT_COMPILED_RULES = compilePermissionRules(createDefaultPermissionRules());
const compiledRuleCache = new WeakMap<readonly PermissionRule[], CompiledPermissionRules>();

function compileCached(rules: readonly PermissionRule[]): CompiledPermissionRules {
	const cached = compiledRuleCache.get(rules);
	if (cached) return cached;
	const compiled = compilePermissionRules(rules);
	compiledRuleCache.set(rules, compiled);
	return compiled;
}

function legacyPermissionRules(rules: readonly AutoCommandRule[]): PermissionRule[] {
	return rules.map((rule, index) =>
		Object.freeze({
			id: `legacy-command-${index + 1}`,
			kind: "command" as const,
			origin: "user" as const,
			name: rule.command,
			enabled: true,
			modes: Object.freeze(["auto"] as const),
			scope: "all" as const,
			directories: Object.freeze([]),
			command: rule.command,
			allowNetwork: rule.allowNetwork,
			...(rule.networkTargets ? { networkTargets: rule.networkTargets } : {}),
		}),
	);
}

function effectiveCompiledRules(input: PermissionPolicyInput): CompiledPermissionRules {
	if (input.permissionRules !== undefined) return compileCached(input.permissionRules);
	const legacy = input.autoCommandRules ?? [];
	if (legacy.length === 0) return DEFAULT_COMPILED_RULES;
	return compilePermissionRules([...createDefaultPermissionRules(), ...legacyPermissionRules(legacy)]);
}

/**
 * `deny` and `never` ceilings have no interactive reviewer; read-only Ask/Auto
 * rules still apply there so plan/unattended reads keep their prior behavior.
 */
function modeSettings(settings: PermissionSettings): {
	readonly auto: boolean;
	readonly ask: boolean;
	readonly command: boolean;
	readonly readOnlyCeiling: boolean;
} {
	const auto = settings.approvalPolicy === "auto-review";
	const ask = !auto;
	// Read-only and deny ceilings have no way to request a wider grant. Preserve
	// their analyzer-proven pure-read command set, including Ask with a read-only
	// sandbox, while a normal workspace-write Ask still asks for every command.
	const readOnlyCeiling = settings.sandboxPolicy === "read-only" || settings.approvalPolicy === "deny";
	return {
		auto,
		ask,
		command: settings.approvalPolicy !== "user" || readOnlyCeiling,
		readOnlyCeiling,
	};
}

function ruleModeApplies(rule: PermissionRule, modes: { readonly auto: boolean; readonly ask: boolean }): boolean {
	if (rule.modes.includes("auto") && modes.auto) return true;
	if (rule.modes.includes("ask") && modes.ask) return true;
	return false;
}

function ruleCoversNetwork(
	rule: PermissionRule,
	endpoints: readonly { readonly hostname: string; readonly port: number }[],
): boolean {
	if (endpoints.length === 0) return true;
	if (!rule.allowNetwork) return false;
	if (!rule.networkTargets || rule.networkTargets.length === 0) return false;
	return endpoints.every((endpoint) =>
		rule.networkTargets!.some((target) => target.hostname === endpoint.hostname && target.port === endpoint.port),
	);
}

function scopeRoots(
	rule: PermissionRule,
	action: NormalizedPermissionAction,
	managedMemoryRoots: readonly string[],
): readonly string[] | undefined {
	switch (rule.scope) {
		case "workspace":
			return action.workspaceRoots;
		case "directories":
			return rule.directories.map((directory) => canonicalizeActionPath(directory, action.cwd));
		case "memory":
			return managedMemoryRoots.length > 0 ? managedMemoryRoots : undefined;
		case "session":
		case "declared":
		case "all":
			return undefined;
	}
}

/**
 * A scope that cannot resolve any root (empty directories, no managed memory
 * root) never matches, rather than silently widening to every path.
 */
function ruleScopeCovers(
	rule: PermissionRule,
	action: NormalizedPermissionAction,
	managedMemoryRoots: readonly string[],
): boolean {
	if (rule.scope === "session") return action.readPaths.length === 0 && action.writePaths.length === 0;
	if (rule.scope === "declared" || rule.scope === "all") return true;
	const roots = scopeRoots(rule, action, managedMemoryRoots);
	if (!roots || roots.length === 0) return false;
	// Bash claims merge the workspace roots into the action's readPaths for grant
	// coverage. A directory-scoped rule must judge what the command really read,
	// so use the analyzer's own path set. Legacy actions without those facts keep
	// the merged paths: missing facts may narrow a match but never widen it.
	const paths =
		rule.scope === "directories" && action.provenance === "builtin" && action.toolName === "bash"
			? [...(trustedShellAnalysis(action)?.readPaths ?? action.readPaths), ...action.writePaths]
			: [...action.readPaths, ...action.writePaths];
	return paths.every((path) => roots.some((root) => isPathInsideNormalized(root, path)));
}

function entryMatchesCommandRule(
	rule: PermissionRule,
	entry: ShellCommandTraceEntry,
	compiled: CompiledPermissionRules,
): boolean {
	if (!entry.complete || entry.argv.length === 0) return false;
	if (entry.disposition !== "safe" && entry.disposition !== "review") return false;
	if (entry.effects.length > 0) return false;
	if (!ruleCoversNetwork(rule, entry.networkEndpoints)) return false;
	switch (rule.kind) {
		case "command": {
			const configured = compiled.commands.find((candidate) => candidate.rule.id === rule.id);
			if (!configured) return false;
			const prefix = configured.prefix;
			return prefix.length <= entry.argv.length && prefix.every((word, index) => word === entry.argv[index]);
		}
		case "script": {
			const configured = compiled.scripts.find((candidate) => candidate.rule.id === rule.id);
			const family = scriptFamilyFor(entry.argv[0]);
			return configured !== undefined && family === configured.family;
		}
		case "shell": {
			const configured = compiled.shells.find((candidate) => candidate.rule.id === rule.id);
			if (!configured || entry.structural !== configured.structural) return false;
			return configured.structural === "assignment" || entry.argv[0] === "[[";
		}
		default:
			return false;
	}
}

function commandRuleCandidates(
	compiled: CompiledPermissionRules,
	entry: ShellCommandTraceEntry,
	action: NormalizedPermissionAction,
	managedMemoryRoots: readonly string[],
	modes: { readonly auto: boolean; readonly ask: boolean; readonly readOnlyCeiling: boolean },
): readonly PermissionRule[] {
	const candidates: PermissionRule[] = [];
	for (const rule of [...compiled.commands, ...compiled.scripts, ...compiled.shells].map(({ rule }) => rule)) {
		// Auto command rules also apply under stricter deny/read-only ceilings,
		// which have no interactive reviewer of their own. A normal
		// workspace-write Ask is deliberately excluded.
		const modeApplies =
			(rule.modes.includes("auto") && (modes.auto || modes.readOnlyCeiling)) ||
			(modes.ask && rule.modes.includes("ask"));
		if (!rule.enabled || !modeApplies) continue;
		if (!ruleScopeCovers(rule, action, managedMemoryRoots)) continue;
		if (entryMatchesCommandRule(rule, entry, compiled)) candidates.push(rule);
	}
	return candidates;
}

function matchCommandRules(
	input: PermissionPolicyInput,
	compiled: CompiledPermissionRules,
	managedMemoryRoots: readonly string[],
	modes: {
		readonly auto: boolean;
		readonly ask: boolean;
		readonly command: boolean;
		readonly readOnlyCeiling: boolean;
	},
): MatchedPermissionRule | undefined {
	if (!modes.command || input.action.provenance !== "builtin" || input.action.toolName !== "bash") return undefined;
	if (input.action.command === undefined || input.action.effects.length > 0) return undefined;
	if (input.action.writePaths.length > 0) return undefined;
	const analysis = trustedShellAnalysis(input.action);
	if (!analysis || !analysis.complete || analysis.commands.length === 0) return undefined;
	if (analysis.disposition !== "safe" && analysis.disposition !== "review") return undefined;

	const ruleIds: string[] = [];
	let matchedRule: PermissionRule | undefined;
	for (const entry of analysis.commands) {
		const candidates = commandRuleCandidates(compiled, entry, input.action, managedMemoryRoots, modes);
		if (candidates.length === 0) return undefined;
		const best = [...candidates].sort((left, right) => {
			const leftPrefix = compiled.commands.find(({ rule }) => rule.id === left.id)?.prefix.length ?? 0;
			const rightPrefix = compiled.commands.find(({ rule }) => rule.id === right.id)?.prefix.length ?? 0;
			return rightPrefix - leftPrefix;
		})[0]!;
		if (!ruleIds.includes(best.id)) ruleIds.push(best.id);
		matchedRule ??= best;
	}
	if (!matchedRule) return undefined;
	return Object.freeze({ ruleIds: Object.freeze(ruleIds), matchedRule: permissionRuleMatchedView(matchedRule) });
}

/**
 * Read-only and deny ceilings historically allowed a low-risk simple command
 * even when no trusted trace was attached. Keep that narrow capability, but
 * only through an enabled visible command rule. Scripts and structural nodes
 * still require their real analysis facts.
 */
function matchReadOnlySimpleCommandRules(
	input: PermissionPolicyInput,
	compiled: CompiledPermissionRules,
	managedMemoryRoots: readonly string[],
	modes: {
		readonly auto: boolean;
		readonly ask: boolean;
		readonly command: boolean;
		readonly readOnlyCeiling: boolean;
	},
	riskLevel: RiskLevel,
): MatchedPermissionRule | undefined {
	const action = input.action;
	if (
		!modes.readOnlyCeiling ||
		riskLevel !== "low" ||
		action.provenance !== "builtin" ||
		action.toolName !== "bash" ||
		action.command === undefined ||
		trustedShellAnalysis(action) !== undefined ||
		action.effects.length > 0 ||
		action.writePaths.length > 0 ||
		action.networkEndpoints.length > 0
	) {
		return undefined;
	}
	const argv = parseSimpleShellCommand(action.command);
	if (!argv || argv.length === 0) return undefined;
	const entry: ShellCommandTraceEntry = Object.freeze({
		argv: Object.freeze(argv),
		complete: true,
		disposition: "safe",
		effects: Object.freeze([]),
		networkEndpoints: Object.freeze([]),
	});
	const candidates = commandRuleCandidates(compiled, entry, action, managedMemoryRoots, modes).filter(
		(rule) => rule.kind === "command",
	);
	const best = [...candidates].sort((left, right) => {
		const leftPrefix = compiled.commands.find(({ rule }) => rule.id === left.id)?.prefix.length ?? 0;
		const rightPrefix = compiled.commands.find(({ rule }) => rule.id === right.id)?.prefix.length ?? 0;
		return rightPrefix - leftPrefix;
	})[0];
	if (!best) return undefined;
	return Object.freeze({ ruleIds: Object.freeze([best.id]), matchedRule: permissionRuleMatchedView(best) });
}

const BUILTIN_RULE_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"write",
	"edit",
	"memory_search",
	"memory_read",
	"memory_write",
	"deliver_file",
	"set_tasks",
	"tool_search",
	"get_goal",
	"create_goal",
	"update_goal",
]);
const HOST_RULE_TOOLS: ReadonlySet<string> = new Set(["wait_agents", "ask_user", "inspect_agents", "submit_plan"]);
const WRITE_RULE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "memory_write"]);
const MEMORY_RULE_TOOLS: ReadonlySet<string> = new Set(["memory_search", "memory_read", "memory_write"]);

function toolIdentityMatchesRule(rule: PermissionRule, action: NormalizedPermissionAction): boolean {
	const name = rule.toolName;
	if (!name || action.toolName !== name) return false;
	if (HOST_RULE_TOOLS.has(name)) return action.provenance === "host";
	if (name === "deliver_file") return action.provenance === "builtin" || action.provenance === "host";
	return action.provenance === "builtin";
}

function matchToolRules(
	input: PermissionPolicyInput,
	compiled: CompiledPermissionRules,
	managedMemoryRoots: readonly string[],
	modes: { readonly auto: boolean; readonly ask: boolean },
): MatchedPermissionRule | undefined {
	const action = input.action;
	if (action.command !== undefined || action.networkEndpoints.length > 0 || action.effects.length > 0)
		return undefined;
	const writes = action.writePaths.length > 0;
	for (const rule of compiled.tools) {
		if (!rule.enabled || !ruleModeApplies(rule, modes)) continue;
		if (!toolIdentityMatchesRule(rule, action)) continue;
		const toolName = rule.toolName!;
		if (writes !== WRITE_RULE_TOOLS.has(toolName)) continue;
		if (toolName === "deliver_file" && action.readPaths.length === 0) continue;
		if (MEMORY_RULE_TOOLS.has(toolName) && managedMemoryRoots.length === 0) continue;
		if (!ruleScopeCovers(rule, action, managedMemoryRoots)) continue;
		return Object.freeze({
			ruleIds: Object.freeze([rule.id]),
			matchedRule: permissionRuleMatchedView(rule),
		});
	}
	return undefined;
}

const EXTERNAL_PROVENANCES: ReadonlySet<NormalizedPermissionAction["provenance"]> = new Set([
	"host",
	"extension",
	"sdk",
	"mcp",
]);

/**
 * E03/E04 only take over the pre-existing external-tool allow branches. They
 * never cover an action whose real identity is already handled by C/T, so
 * disabling those rules cannot be bypassed through a same-named tool.
 */
function isExternalRuleIdentity(action: NormalizedPermissionAction): boolean {
	if (!EXTERNAL_PROVENANCES.has(action.provenance)) return false;
	if (HOST_RULE_TOOLS.has(action.toolName) && action.provenance === "host") return false;
	if (
		BUILTIN_RULE_TOOLS.has(action.toolName) &&
		(action.provenance === "builtin" || (action.toolName === "deliver_file" && action.provenance === "host"))
	) {
		return false;
	}
	return true;
}

function findCompatibilityRule(
	compiled: CompiledPermissionRules,
	id: string,
	modes: { readonly auto: boolean; readonly ask: boolean },
): PermissionRule | undefined {
	return compiled.compatibility.find((rule) => rule.id === id && rule.enabled && ruleModeApplies(rule, modes));
}

function compatibilityMatch(rule: PermissionRule): MatchedPermissionRule {
	return Object.freeze({ ruleIds: Object.freeze([rule.id]), matchedRule: permissionRuleMatchedView(rule) });
}

function matchAskAutoCompatibilityRules(
	input: PermissionPolicyInput,
	compiled: CompiledPermissionRules,
	modes: { readonly auto: boolean; readonly ask: boolean },
	riskLevel: RiskLevel,
): MatchedPermissionRule | undefined {
	const action = input.action;
	const officeCli = findCompatibilityRule(compiled, "E01", modes);
	if (officeCli && isOfficeCliCommand(action)) return compatibilityMatch(officeCli);
	const readOnlyMcp = findCompatibilityRule(compiled, "E02", modes);
	if (readOnlyMcp && isReadOnlyMcp(action)) return compatibilityMatch(readOnlyMcp);
	const externalRead = findCompatibilityRule(compiled, "E03", modes);
	if (
		externalRead &&
		riskLevel === "low" &&
		isExternalRuleIdentity(action) &&
		action.writePaths.length === 0 &&
		(action.command === undefined ||
			input.settings.sandboxPolicy === "read-only" ||
			input.settings.approvalPolicy === "deny") &&
		action.networkEndpoints.length === 0 &&
		action.effects.length === 0
	) {
		return compatibilityMatch(externalRead);
	}
	return undefined;
}

function matchExternalLowRiskRule(
	input: PermissionPolicyInput,
	compiled: CompiledPermissionRules,
	riskLevel: RiskLevel,
): MatchedPermissionRule | undefined {
	// Auto only: this replaces the old review-free low-risk fallback for SDK,
	// extension, host, and MCP tools whose scope is known.
	if (input.settings.approvalPolicy !== "auto-review") return undefined;
	const rule = findCompatibilityRule(compiled, "E04", { auto: true, ask: false });
	if (
		rule &&
		riskLevel === "low" &&
		isExternalRuleIdentity(input.action) &&
		input.action.networkEndpoints.length === 0 &&
		input.action.effects.length === 0
	) {
		return compatibilityMatch(rule);
	}
	return undefined;
}

function isOfficeCliCommand(action: NormalizedPermissionAction): boolean {
	if (action.provenance !== "builtin" || action.toolName !== "bash" || !action.command) return false;
	const toolsDir = getBundledToolsDir();
	const executable = process.platform === "win32" ? "officecli.exe" : "officecli";
	const segments = splitShellSegments(action.command);
	return (
		segments.length > 0 &&
		segments.every((segment) => {
			const argv = parseSimpleShellCommand(segment, Number.POSITIVE_INFINITY);
			const name = argv?.[0];
			return (
				name === "officecli" ||
				name === executable ||
				(!!toolsDir && name === join(toolsDir, executable).replaceAll("\\", "/"))
			);
		})
	);
}

function deny(riskLevel: RiskLevel, reason: string): PermissionPolicyDecision {
	return Object.freeze({ kind: "deny", riskLevel, reason });
}

export class PermissionPolicy {
	evaluate(input: PermissionPolicyInput): PermissionPolicyDecision {
		try {
			assertPermissionSettings(input.settings);
			assertWellFormedAction(input.action);
		} catch {
			return deny("critical", "Permission settings or action are invalid");
		}
		if (isFullAccess(input.settings)) {
			const grant = grantRequestFor(input.settings, input.action, input.managedMemoryRoots ?? []);
			return Object.freeze({
				kind: "allow",
				riskLevel: riskLevelFor(input.action, grant, input.managedMemoryRoots ?? []),
				reason: "Allowed by Full access",
				grant,
			});
		}
		const managedMemoryRoots = input.managedMemoryRoots ?? [];
		const invariant = hardDenyReason(input.action);
		if (invariant) return deny("critical", invariant);
		const analysis = trustedShellAnalysis(input.action);
		if (analysis?.disposition === "deny") return deny("high", "The command hit a hard-deny shell semantic");
		// Ask/Auto commands above the analyzer limit must be split and retried;
		// they are rejected outright instead of entering the approval panel.
		if (
			input.action.command !== undefined &&
			Buffer.byteLength(input.action.command, "utf8") > MAX_SHELL_COMMAND_BYTES
		) {
			return deny("high", "命令超过32KiB，请拆分后重试");
		}
		const protectedWrite = protectedWriteReason(input.action, managedMemoryRoots);
		if (protectedWrite) return deny("critical", protectedWrite);
		if (
			input.settings.approvalPolicy === "auto-review" &&
			(analysis !== undefined
				? isRecursiveDeletionTrace(analysis)
				: isRecursiveDeletionCommandText(input.action.command))
		) {
			return deny("high", "Recursive deletion is not allowed in Auto mode");
		}

		const ceiling = ceilingDenyReason(input.settings, input.action);
		if (ceiling) {
			return deny(
				riskLevelFor(
					input.action,
					grantRequestFor(input.settings, input.action, managedMemoryRoots),
					managedMemoryRoots,
				),
				ceiling,
			);
		}

		const grant = grantRequestFor(input.settings, input.action, managedMemoryRoots);
		const riskLevel = riskLevelFor(input.action, grant, managedMemoryRoots);
		const compiled = effectiveCompiledRules(input);
		const modes = modeSettings(input.settings);
		const ruleMatch =
			matchToolRules(input, compiled, managedMemoryRoots, modes) ??
			matchCommandRules(input, compiled, managedMemoryRoots, modes) ??
			matchReadOnlySimpleCommandRules(input, compiled, managedMemoryRoots, modes, riskLevel) ??
			matchAskAutoCompatibilityRules(input, compiled, modes, riskLevel);
		if (ruleMatch) {
			return Object.freeze({
				kind: "allow",
				riskLevel,
				reason: `Allowed by permission rule ${ruleMatch.matchedRule.id}`,
				grant,
				ruleIds: ruleMatch.ruleIds,
				matchedRule: ruleMatch.matchedRule,
			});
		}

		if (input.settings.approvalPolicy === "deny") {
			const categories = [
				...input.action.effects,
				...(input.action.networkEndpoints.length > 0 ? ["network"] : []),
				...(input.action.writePaths.length > 0 ? ["write scope"] : []),
				...(input.action.command !== undefined ? ["shell"] : []),
			];
			return deny(
				riskLevel,
				`The approval ceiling forbids an action that requires review${categories.length > 0 ? ` (${[...new Set(categories)].join(", ")})` : ""}`,
			);
		}

		const externalLowRisk = matchExternalLowRiskRule(input, compiled, riskLevel);
		if (externalLowRisk) {
			return Object.freeze({
				kind: "allow",
				riskLevel,
				reason: `Allowed by permission rule ${externalLowRisk.matchedRule.id}`,
				grant,
				ruleIds: externalLowRisk.ruleIds,
				matchedRule: externalLowRisk.matchedRule,
			});
		}

		const reviewer = minimumReviewerFor(input.settings, riskLevel, input.action);
		return Object.freeze({
			kind: "review",
			riskLevel,
			minimumReviewer: reviewer,
			reason: "The action requires permission review",
			grant,
		});
	}
}
