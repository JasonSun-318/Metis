import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonicalizeActionPath } from "../../utils/paths.ts";
import { type AutoCommandRule, matchAutoCommandRule } from "./auto-command-rules.ts";
import { assertCompleteAction } from "./normalize.ts";
import { assertPermissionSettings } from "./settings.ts";
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
}

const CRITICAL_EFFECTS = new Set([
	"sensitive-read",
	"elevation",
	"security-weakening",
	"payment",
	"production-mutation",
]);
const HIGH_EFFECTS = new Set(["external-side-effect", "destructive"]);

function isPathInsideNormalized(parent: string, target: string): boolean {
	const child = relative(parent, target);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isOutsideWorkspace(action: NormalizedPermissionAction): boolean {
	const scopedPaths = [...action.readPaths, ...action.writePaths, ...(action.command ? [action.cwd] : [])];
	return scopedPaths.some((path) => !action.workspaceRoots.some((root) => isPathInsideNormalized(root, path)));
}

function protectedRootsFor(action: NormalizedPermissionAction): readonly string[] {
	return Object.freeze(
		[
			...new Set(
				action.workspaceRoots.flatMap((root) =>
					[".git", ".metis", ".codex", ".agents"].map((name) => join(root, name)),
				),
			),
		].sort(),
	);
}

function grantRequestFor(settings: PermissionSettings, action: NormalizedPermissionAction): GrantRequest {
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
		protectedRoots: protectedRootsFor(action),
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
	for (const match of command.matchAll(/\brm\b((?:\s+--?[^\s;&|]+)+)/giu)) {
		const options = (match[1] ?? "").trim().split(/\s+/u);
		if (options.some((option) => option.startsWith("--recursive") || /^-[^-]*r/iu.test(option))) return true;
	}
	return /\bremove-item\b[^;\n]*(?:-recurse|-r\b)/iu.test(command) || /\brmdir\b[^;\n]*\/s\b/iu.test(command);
}

function explicitRecursiveDeleteTargets(command: string): readonly string[] {
	const targets: string[] = [];
	for (const segment of command.split(/(?:&&|\|\||[;|\n])/u)) {
		const match = segment.match(/^\s*rm\s+((?:-[^\s]+\s+)+)([^;&|\n]+)\s*$/iu);
		if (!match || !/(?:^|\s)-[^\s]*r/iu.test(match[1] ?? "")) continue;
		const parts = (match[2] ?? "").trim().split(/\s+/u);
		if (parts.length === 0 || parts.some((target) => /[*?$`'"\\]/u.test(target))) continue;
		targets.push(...parts);
	}
	return targets;
}

function hardDenyReason(action: NormalizedPermissionAction): string | undefined {
	try {
		assertCompleteAction(action);
	} catch {
		return "Permission action scope is incomplete";
	}
	if (!action.networkEndpoints.every(isExactEndpoint)) return "Wildcard or malformed network grants are forbidden";
	if (!action.effects.includes("destructive") && !isRecursiveDeletionCommand(action.command)) return undefined;

	const home = resolve(homedir());
	for (const target of action.writePaths) {
		if (target === parse(target).root) return "Recursive deletion of a filesystem root is forbidden";
		if (target === home) return "Recursive deletion of the user home is forbidden";
	}
	if (!isRecursiveDeletionCommand(action.command)) return undefined;

	const explicitTargets = action.command ? explicitRecursiveDeleteTargets(action.command) : [];
	if (explicitTargets.length > 0) {
		for (const raw of explicitTargets) {
			try {
				if (action.workspaceRoots.includes(canonicalizeActionPath(raw, action.cwd))) {
					return "Recursive deletion of a workspace root is forbidden";
				}
			} catch {}
		}
		return undefined;
	}

	const hitsWorkspaceRoot = action.writePaths.some((target) => action.workspaceRoots.includes(target));
	const hasInteriorWrite = action.writePaths.some((target) =>
		action.workspaceRoots.some((root) => target !== root && isPathInsideNormalized(root, target)),
	);
	if (hitsWorkspaceRoot && !hasInteriorWrite) return "Recursive deletion of a workspace root is forbidden";
	return undefined;
}

function protectedWriteReason(action: NormalizedPermissionAction): string | undefined {
	const protectedRoots = protectedRootsFor(action);
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

export function riskLevelFor(action: NormalizedPermissionAction, grant: GrantRequest): RiskLevel {
	if (action.effects.some((effect) => CRITICAL_EFFECTS.has(effect))) return "critical";
	if (action.effects.some((effect) => HIGH_EFFECTS.has(effect))) return "high";
	if (grant.networkEndpoints.length > 0 || isOutsideWorkspace(action)) return "medium";
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

function minimumReviewerFor(settings: PermissionSettings, riskLevel: RiskLevel): MinimumReviewer | undefined {
	if (riskLevel === "critical") return "user";
	if (settings.sandboxPolicy === "danger-full-access") return riskLevel === "high" ? "user" : undefined;
	if (settings.approvalPolicy === "user") return "user";
	if (settings.approvalPolicy === "auto-review") return riskLevel === "low" ? undefined : "model";
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

function deny(riskLevel: RiskLevel, reason: string): PermissionPolicyDecision {
	return Object.freeze({ kind: "deny", riskLevel, reason });
}

export class PermissionPolicy {
	evaluate(input: PermissionPolicyInput): PermissionPolicyDecision {
		try {
			assertPermissionSettings(input.settings);
		} catch {
			return deny("critical", "Permission settings are invalid");
		}
		const invariant = hardDenyReason(input.action);
		if (invariant) return deny("critical", invariant);
		const protectedWrite = protectedWriteReason(input.action);
		if (protectedWrite) return deny("critical", protectedWrite);

		const ceiling = ceilingDenyReason(input.settings, input.action);
		if (ceiling) return deny(riskLevelFor(input.action, grantRequestFor(input.settings, input.action)), ceiling);

		const grant = grantRequestFor(input.settings, input.action);
		const riskLevel = riskLevelFor(input.action, grant);
		if (isDeterministicRead(input.action, riskLevel, input.settings) || isReadOnlyMcp(input.action)) {
			return Object.freeze({
				kind: "allow",
				riskLevel,
				reason: "Allowed by deterministic read policy",
				grant,
			});
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

		const reviewer = minimumReviewerFor(input.settings, riskLevel);
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
