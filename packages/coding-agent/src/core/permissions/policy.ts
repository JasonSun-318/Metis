import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { getBundledToolsDir } from "../../config.ts";
import {
	type AutoCommandRule,
	matchAutoCommandRule,
	parseSimpleShellCommand,
	splitShellSegments,
	tokenizeShellWords,
} from "./auto-command-rules.ts";
import { assertWellFormedAction } from "./normalize.ts";
import { assertPermissionSettings, isFullAccess } from "./settings.ts";
import type {
	GrantRequest,
	MinimumReviewer,
	NormalizedPermissionAction,
	PermissionPolicyDecision,
	PermissionSettings,
	RiskLevel,
} from "./types.ts";

export interface PermissionPolicyInput {
	readonly settings: PermissionSettings;
	readonly action: NormalizedPermissionAction;
	readonly autoCommandRules?: readonly AutoCommandRule[];
	/**
	 * Engine-managed roots (e.g. the memory vault) outside the workspace. Builtin
	 * memory tools may write under them without review; every other tool that
	 * declares a write path inside them is denied as a protected write.
	 */
	readonly managedMemoryRoots?: readonly string[];
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

function isRecursiveDeletionCommand(command: string | undefined): boolean {
	if (!command) return false;
	return splitShellSegments(command).some((segment) => {
		const words = tokenizeShellWords(segment).words;
		const executable = words[0]?.replace(/^.*\//u, "").toLowerCase();
		if (executable === "rm") {
			return words
				.slice(1)
				.some(
					(option) => option === "--recursive" || option.startsWith("--recursive=") || /^-[^-]*r/iu.test(option),
				);
		}
		if (executable === "remove-item") {
			return words.some((option) => /^-recurse$/iu.test(option) || /^-(?:r|recurse)\b/iu.test(option));
		}
		return executable === "rmdir" && words.some((option) => option.toLowerCase() === "/s");
	});
}

function hardDenyReason(action: NormalizedPermissionAction): string | undefined {
	if (!action.networkEndpoints.every(isExactEndpoint)) return "Wildcard or malformed network grants are forbidden";
	if (!action.effects.includes("destructive") && !isRecursiveDeletionCommand(action.command)) return undefined;

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

function isDeterministicRead(
	action: NormalizedPermissionAction,
	riskLevel: RiskLevel,
	settings: PermissionSettings,
): boolean {
	return (
		riskLevel === "low" &&
		action.writePaths.length === 0 &&
		action.networkEndpoints.length === 0 &&
		action.effects.length === 0 &&
		(action.command === undefined || settings.sandboxPolicy === "read-only" || settings.approvalPolicy === "deny")
	);
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
): MinimumReviewer | undefined {
	if (riskLevel === "critical") return "user";
	if (settings.sandboxPolicy === "danger-full-access") return riskLevel === "high" ? "user" : undefined;
	if (settings.approvalPolicy === "user") return "user";
	if (settings.approvalPolicy === "auto-review" && riskLevel !== "low") {
		// Model review only permits reads; known mutations and network need user review.
		return action.writePaths.length > 0 ||
			action.networkEndpoints.length > 0 ||
			action.effects.includes("destructive") ||
			action.effects.includes("external-side-effect")
			? "user"
			: "model";
	}
	return undefined;
}

function isAllowedByAutoCommandRule(input: PermissionPolicyInput): boolean {
	if (
		input.settings.sandboxPolicy !== "workspace-write" ||
		input.settings.approvalPolicy !== "auto-review" ||
		input.action.toolName !== "bash" ||
		input.action.command === undefined ||
		input.action.effects.length > 0
	) {
		return false;
	}
	const rule = matchAutoCommandRule(input.action.command, input.autoCommandRules ?? []);
	if (!rule) return false;
	return input.action.networkEndpoints.length === 0 || rule.allowNetwork;
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
		const protectedWrite = protectedWriteReason(input.action, managedMemoryRoots);
		if (protectedWrite) return deny("critical", protectedWrite);
		if (input.settings.approvalPolicy === "auto-review" && isRecursiveDeletionCommand(input.action.command)) {
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
		if (isDeterministicRead(input.action, riskLevel, input.settings) || isReadOnlyMcp(input.action)) {
			return Object.freeze({
				kind: "allow",
				riskLevel,
				reason: "Allowed by deterministic read policy",
				grant,
			});
		}

		if (isManagedMemoryAction(input.action, managedMemoryRoots)) {
			return Object.freeze({
				kind: "allow",
				riskLevel,
				reason: "Allowed by managed memory root policy",
				grant,
			});
		}

		if (isOfficeCliCommand(input.action)) {
			return Object.freeze({ kind: "allow", riskLevel, reason: "Allowed by OfficeCLI policy", grant });
		}

		if (isAllowedByAutoCommandRule(input)) {
			return Object.freeze({
				kind: "allow",
				riskLevel,
				reason: "Allowed by Auto command rule",
				grant,
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

		const reviewer = minimumReviewerFor(input.settings, riskLevel, input.action);
		if (reviewer) {
			return Object.freeze({
				kind: "review",
				riskLevel,
				minimumReviewer: reviewer,
				reason: "The action requires permission review",
				grant,
			});
		}
		return Object.freeze({
			kind: "allow",
			riskLevel,
			reason: "Allowed by deterministic permission policy",
			grant,
		});
	}
}
