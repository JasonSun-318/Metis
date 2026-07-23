import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeActionPath, isPathInside, pathsIntersect } from "../utils/paths.ts";
import type { PermissionSettings } from "./permission-mode.ts";

export type ToolProvenance = "builtin" | "extension" | "sdk" | "mcp";

export type ActionRisk =
	| "ordinary-read"
	| "sensitive-read"
	| "workspace-write"
	| "outside-write"
	| "shell"
	| "destructive"
	| "network"
	| "elevation"
	| "external-side-effect"
	| "custom"
	| "unknown";

export interface NetworkTarget {
	readonly host: string;
	readonly port: number;
}

export interface PermissionAction {
	readonly actionId: string;
	readonly toolName: string;
	readonly provenance: ToolProvenance;
	readonly risks: readonly ActionRisk[];
	readonly paths: readonly string[];
	readonly networkTargets: readonly NetworkTarget[];
	readonly command?: string;
}

/** @deprecated Use PermissionAction. */
export type ClassifiedAction = PermissionAction;

export type PermissionRoute = "allow" | "user";

export interface PermissionActor {
	readonly type: "subagent";
	readonly id: string;
	readonly name: string;
}

export interface PermissionApprovalRequest {
	readonly action: PermissionAction;
	readonly args: unknown;
	readonly reason: string;
	readonly actor?: PermissionActor;
	readonly signal?: AbortSignal;
}

export interface PermissionApprovalDecision {
	readonly decision: "allow" | "deny";
	readonly reason?: string;
}

export type RequestPermissionApproval = (request: PermissionApprovalRequest) => Promise<PermissionApprovalDecision>;

export interface PermissionApprovalView {
	readonly title: string;
	readonly summary: string;
	readonly details: string;
}

export type PermissionAuthorization =
	| {
			readonly decision: "allow";
			readonly source: "automatic" | "user";
			readonly reason: string;
			readonly action: PermissionAction;
	  }
	| {
			readonly decision: "deny";
			readonly source: "user" | "fallback";
			readonly reason: string;
			readonly action: PermissionAction;
	  };

export interface ClassifyActionInput {
	readonly actionId: string;
	readonly toolName: string;
	readonly provenance: ToolProvenance;
	readonly args: unknown;
	readonly cwd: string;
	readonly mcpAnnotations?: {
		readonly readOnlyHint?: boolean;
		readonly destructiveHint?: boolean;
	};
	readonly builtinNetworkTargets?: readonly NetworkTarget[];
}

export interface PermissionAuthorizeInput {
	readonly settings: PermissionSettings;
	readonly action: PermissionAction;
	readonly args: unknown;
	readonly signal?: AbortSignal;
}

const MAX_PERMISSION_APPROVAL_UTF8_BYTES = 48 * 1024;
const DIRECT_HOST_WARNING =
	"ArcMind does not sandbox this action. Built-in tools run as your current OS user; installed integrations run with the authority you configured.";
const BASH_HOST_EFFECT_WARNING =
	"Runs directly on your computer without a sandbox. It may read or change files, start processes, or access the network.";
const IRREVERSIBLE_WARNING =
	"This action may be irreversible or affect an external target. Verify the command and target before allowing it.";

const RISK_ORDER: readonly ActionRisk[] = [
	"ordinary-read",
	"sensitive-read",
	"workspace-write",
	"outside-write",
	"shell",
	"destructive",
	"network",
	"elevation",
	"external-side-effect",
	"custom",
	"unknown",
];

const SENSITIVE_DIRECTORY_NAMES = new Set([".ssh", ".aws", ".gnupg", ".kube", ".azure"]);
const SENSITIVE_FILE_NAMES = new Set([
	".git-credentials",
	".netrc",
	".npmrc",
	".pypirc",
	"auth.json",
	"credentials",
	"credentials.json",
]);
const COMMON_SENSITIVE_ENV_FILES = [
	".env",
	".env.local",
	".env.development",
	".env.development.local",
	".env.production",
	".env.production.local",
	".env.staging",
	".env.staging.local",
	".env.test",
	".env.test.local",
] as const;
const STRUCTURED_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const STRUCTURED_WRITE_TOOLS = new Set(["write", "edit"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function uniqueRisks(risks: Iterable<ActionRisk>): ActionRisk[] {
	const values = new Set(risks);
	return RISK_ORDER.filter((risk) => values.has(risk));
}

function uniquePaths(paths: Iterable<string>): string[] {
	return [...new Set(paths)];
}

/** Fixed host-owned paths that require explicit sensitive-read authorization. */
export function getSensitiveFilesystemPaths(cwd: string, environment: NodeJS.ProcessEnv = process.env): string[] {
	const home = homedir();
	const environmentFiles = new Set<string>(COMMON_SENSITIVE_ENV_FILES);
	try {
		for (const name of readdirSync(cwd)) {
			const lower = name.toLowerCase();
			if (
				(lower === ".env" || lower.startsWith(".env.")) &&
				!lower.endsWith(".example") &&
				!lower.endsWith(".sample")
			) {
				environmentFiles.add(name);
			}
		}
	} catch {
		// Fixed sensitive paths below still apply when cwd cannot be inspected.
	}
	const roots = [
		...Array.from(SENSITIVE_DIRECTORY_NAMES, (name) => join(home, name)),
		join(home, ".config", "gcloud"),
		join(home, ".config", "google-chrome"),
		join(home, ".config", "chromium"),
		join(home, ".config", "microsoft-edge"),
		join(home, ".docker", "config.json"),
		join(home, ".git-credentials"),
		join(home, ".local", "share", "keyrings"),
		join(home, ".mozilla", "firefox"),
		join(home, ".netrc"),
		join(home, ".npmrc"),
		join(home, ".arcmind", "agent", "auth.json"),
		...Array.from(environmentFiles, (name) => join(cwd, name)),
	];
	if (process.platform === "darwin") {
		roots.push(
			"/Library/Keychains",
			join(home, "Library", "Application Support", "Chromium"),
			join(home, "Library", "Application Support", "Firefox"),
			join(home, "Library", "Application Support", "Google", "Chrome"),
			join(home, "Library", "Application Support", "Microsoft Edge"),
			join(home, "Library", "Keychains"),
			join(home, "Library", "Safari"),
		);
	}
	if (environment.APPDATA && isAbsolute(environment.APPDATA)) {
		roots.push(
			join(environment.APPDATA, "Microsoft", "Credentials"),
			join(environment.APPDATA, "Microsoft", "Vault"),
			join(environment.APPDATA, "Mozilla", "Firefox"),
		);
	}
	if (environment.LOCALAPPDATA && isAbsolute(environment.LOCALAPPDATA)) {
		roots.push(
			join(environment.LOCALAPPDATA, "Google", "Chrome", "User Data"),
			join(environment.LOCALAPPDATA, "Microsoft", "Credentials"),
			join(environment.LOCALAPPDATA, "Microsoft", "Edge", "User Data"),
			join(environment.LOCALAPPDATA, "Microsoft", "Vault"),
		);
	}
	return uniquePaths(roots.map((path) => canonicalizeActionPath(path, cwd)));
}

function hasSensitiveName(path: string): boolean {
	const lowerBase = basename(path).toLowerCase();
	if (lowerBase.startsWith(".env") && (lowerBase.endsWith(".example") || lowerBase.endsWith(".sample"))) return false;
	if (lowerBase === ".env" || lowerBase.startsWith(".env.")) return true;
	if (SENSITIVE_FILE_NAMES.has(lowerBase)) return true;
	return path
		.split(/[\\/]+/)
		.map((part) => part.toLowerCase())
		.some((part) => SENSITIVE_DIRECTORY_NAMES.has(part));
}

function isSensitivePath(path: string, cwd: string, traversal: boolean): boolean {
	if (hasSensitiveName(path)) return true;
	return getSensitiveFilesystemPaths(cwd).some((sensitive) =>
		traversal ? existsSync(sensitive) && pathsIntersect(path, sensitive) : isPathInside(sensitive, path),
	);
}

function normalizePaths(rawPaths: readonly string[], cwd: string): { paths: string[]; invalid: boolean } {
	const paths: string[] = [];
	try {
		for (const path of rawPaths) {
			if (!path || path.includes("\0")) return { paths, invalid: true };
			paths.push(canonicalizeActionPath(path, cwd));
		}
		return { paths: uniquePaths(paths), invalid: false };
	} catch {
		return { paths, invalid: true };
	}
}

function isOrdinaryFilesystemObject(path: string): boolean {
	try {
		const value = statSync(path);
		if (!value.isFile() && !value.isDirectory()) return false;
		accessSync(path, constants.R_OK | (value.isDirectory() ? constants.X_OK : 0));
		return true;
	} catch {
		return false;
	}
}

function action(
	input: ClassifyActionInput,
	risks: Iterable<ActionRisk>,
	paths: readonly string[] = [],
	command?: string,
	networkTargets: readonly NetworkTarget[] = [],
): PermissionAction {
	const normalizedRisks = uniqueRisks(risks);
	return {
		actionId: input.actionId,
		toolName: input.toolName,
		provenance: input.provenance,
		risks: normalizedRisks.length > 0 ? normalizedRisks : ["unknown"],
		paths: uniquePaths(paths),
		networkTargets: [...networkTargets],
		...(command === undefined ? {} : { command }),
	};
}

export function unclassifiedAction(input: ClassifyActionInput): PermissionAction {
	const args = record(input.args);
	return action(
		input,
		input.toolName === "bash" ? ["shell"] : ["unknown"],
		[],
		input.toolName === "bash" && typeof args?.command === "string" ? args.command : undefined,
		input.builtinNetworkTargets,
	);
}

function classifyStructuredRead(input: ClassifyActionInput, rawPath: string, traversal: boolean): PermissionAction {
	const normalized = normalizePaths([rawPath], input.cwd);
	if (normalized.invalid || normalized.paths.length !== 1 || !isOrdinaryFilesystemObject(normalized.paths[0]!)) {
		return action(input, ["unknown"], normalized.paths);
	}
	return action(
		input,
		isSensitivePath(normalized.paths[0]!, input.cwd, traversal) ? ["sensitive-read"] : ["ordinary-read"],
		normalized.paths,
	);
}

function classifyStructuredWrite(input: ClassifyActionInput, rawPath: string): PermissionAction {
	const normalized = normalizePaths([rawPath], input.cwd);
	if (normalized.invalid || normalized.paths.length !== 1) return action(input, ["unknown"], normalized.paths);
	return action(
		input,
		isPathInside(input.cwd, normalized.paths[0]!) ? ["workspace-write"] : ["outside-write"],
		normalized.paths,
	);
}

function classifyBashForDisplay(input: ClassifyActionInput, command: string): PermissionAction {
	const risks: ActionRisk[] = ["shell"];
	if (/(^|[;&|]\s*)(rm|rmdir|shred|del|erase|format)\b|\bgit\s+(reset\s+--hard|clean)\b/i.test(command)) {
		risks.push("destructive");
	}
	if (/\bgit\s+push\b|\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b|\bdeploy\b/i.test(command)) {
		risks.push("external-side-effect");
	}
	if (
		/\b(?:curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b|\bgit\s+(?:push|pull|fetch|clone)\b|\b(?:npm|pnpm|yarn|bun|pip|pip3|cargo|brew)\s+(?:install|add|update|publish)\b/i.test(
			command,
		)
	) {
		risks.push("network");
	}
	if (/\b(?:sudo|doas|runas)\b|\bStart-Process\b.*\b-Verb\s+RunAs\b/i.test(command)) risks.push("elevation");
	return action(input, risks, [], command);
}

export function classifyAction(input: ClassifyActionInput): PermissionAction {
	if (input.provenance !== "builtin") {
		const risks: ActionRisk[] = ["custom"];
		if (input.mcpAnnotations?.destructiveHint) risks.push("destructive", "external-side-effect");
		return action(input, risks);
	}
	if (["update_plan", "tool_search", "inspect_agents", "wait_agents"].includes(input.toolName)) {
		return action(input, ["ordinary-read"]);
	}
	const args = record(input.args);
	if (!args) return action(input, ["unknown"]);
	if (input.toolName === "web_fetch") {
		if (typeof args.url !== "string") return action(input, ["unknown"]);
		try {
			const url = new URL(args.url);
			if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
				return action(input, ["unknown"]);
			}
			return action(input, ["network"], [], undefined, [
				{ host: url.hostname, port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80 },
			]);
		} catch {
			return action(input, ["unknown"]);
		}
	}
	if (input.toolName === "web_search") {
		return input.builtinNetworkTargets?.length
			? action(input, ["network"], [], undefined, input.builtinNetworkTargets)
			: action(input, ["unknown"]);
	}
	if (input.toolName === "bash") {
		return typeof args.command === "string"
			? classifyBashForDisplay(input, args.command)
			: action(input, ["unknown"]);
	}
	if (STRUCTURED_READ_TOOLS.has(input.toolName)) {
		if (args.path !== undefined && typeof args.path !== "string") return action(input, ["unknown"]);
		if (args.path === undefined && input.toolName === "read") return action(input, ["unknown"]);
		return classifyStructuredRead(
			input,
			typeof args.path === "string" ? args.path : input.cwd,
			input.toolName !== "read",
		);
	}
	if (STRUCTURED_WRITE_TOOLS.has(input.toolName)) {
		return typeof args.path === "string" ? classifyStructuredWrite(input, args.path) : action(input, ["unknown"]);
	}
	return action(input, ["unknown"]);
}

export function routeAction(settings: PermissionSettings, value: PermissionAction): PermissionRoute {
	if (settings.mode === "full") return "allow";
	return value.risks.length === 1 && value.risks[0] === "ordinary-read" ? "allow" : "user";
}

export function revalidateStructuredActionBinding(approved: PermissionAction, args: unknown, cwd: string): boolean {
	if (approved.paths.length === 0) return true;
	if (
		approved.provenance !== "builtin" ||
		(!STRUCTURED_READ_TOOLS.has(approved.toolName) && !STRUCTURED_WRITE_TOOLS.has(approved.toolName))
	) {
		return false;
	}
	const current = classifyAction({
		actionId: approved.actionId,
		toolName: approved.toolName,
		provenance: approved.provenance,
		args,
		cwd,
	});
	return isDeepStrictEqual(current.paths, approved.paths) && isDeepStrictEqual(current.risks, approved.risks);
}

function approvalArguments(args: unknown): string {
	try {
		const serialized = JSON.stringify(args, null, 2);
		if (serialized === undefined) throw new TypeError();
		return serialized;
	} catch {
		throw new TypeError("Permission arguments cannot be displayed completely");
	}
}

export function formatPermissionApproval(request: PermissionApprovalRequest): PermissionApprovalView {
	const { action: value } = request;
	const lines = [
		request.actor ? `Subagent: ${request.actor.name} (${request.actor.id})` : undefined,
		DIRECT_HOST_WARNING,
		value.toolName === "bash" ? BASH_HOST_EFFECT_WARNING : undefined,
		value.risks.includes("destructive") || value.risks.includes("external-side-effect")
			? IRREVERSIBLE_WARNING
			: undefined,
		`Risk: ${value.risks.join(", ")}`,
		value.command === undefined ? undefined : `Command: ${value.command}`,
		STRUCTURED_WRITE_TOOLS.has(value.toolName) ? `Operation: ${value.toolName}` : undefined,
		...value.paths.map((path) => `Path: ${path}`),
		...value.networkTargets.map(({ host, port }) => `Network: ${host}:${port}`),
		`Arguments:\n${approvalArguments(request.args)}`,
	].filter((line): line is string => line !== undefined);
	const view = {
		title: `Approve ${value.toolName}?`,
		summary: request.reason,
		details: lines.join("\n"),
	};
	if (
		Buffer.byteLength(`${view.title}\n${view.summary}\n${view.details}`, "utf8") > MAX_PERMISSION_APPROVAL_UTF8_BYTES
	) {
		throw new TypeError("Permission action is too large to display completely");
	}
	return view;
}

export class PermissionPolicy {
	private requestApproval?: RequestPermissionApproval;

	constructor(requestApproval?: RequestPermissionApproval) {
		this.requestApproval = requestApproval;
	}

	setRequestApproval(requestApproval?: RequestPermissionApproval): void {
		this.requestApproval = requestApproval;
	}

	async authorize(input: PermissionAuthorizeInput): Promise<PermissionAuthorization> {
		if (input.settings.mode === "full") {
			return {
				decision: "allow",
				source: "automatic",
				reason: "Full access is enabled",
				action: input.action,
			};
		}
		if (routeAction(input.settings, input.action) === "allow") {
			return {
				decision: "allow",
				source: "automatic",
				reason: "Allowed safe structured read",
				action: input.action,
			};
		}
		if (!this.requestApproval) {
			return {
				decision: "deny",
				source: "fallback",
				reason: "This action requires approval, but no approval UI is available",
				action: input.action,
			};
		}
		try {
			if (input.signal?.aborted) throw new Error("Approval was aborted");
			const approved = await this.requestApproval({
				action: structuredClone(input.action),
				args: structuredClone(input.args),
				reason: "This model-initiated action can affect the host or access sensitive data",
				signal: input.signal,
			});
			if (input.signal?.aborted) throw new Error("Approval was aborted");
			return approved.decision === "allow"
				? {
						decision: "allow",
						source: "user",
						reason: approved.reason ?? "Allowed once by the user",
						action: input.action,
					}
				: {
						decision: "deny",
						source: "user",
						reason: approved.reason ?? "Denied by the user",
						action: input.action,
					};
		} catch {
			return {
				decision: "deny",
				source: "fallback",
				reason: "The approval UI closed or failed before a decision",
				action: input.action,
			};
		}
	}
}
