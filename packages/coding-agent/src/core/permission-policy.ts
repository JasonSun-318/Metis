import { accessSync, constants, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeActionPath, isPathInside } from "../utils/paths.ts";
import type { PermissionSettings } from "./permission-mode.ts";
import { bashReferencesSensitivePath, isSensitivePath } from "./permissions/sensitive-paths.ts";
import type { ProjectPermissionRuleStore, ProjectPermissionSignatureInput } from "./project-permission-rules.ts";

export { getSensitiveFilesystemPaths } from "./permissions/sensitive-paths.ts";

export type ToolProvenance = "builtin" | "host" | "extension" | "sdk" | "mcp";

export type ActionRisk =
	| "ordinary-read"
	| "outside-read"
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
export type PermissionExecutionTarget = "sandbox" | "host";

export interface PermissionActor {
	readonly type: "agent";
	readonly id: string;
	readonly name: string;
	readonly taskId: string;
}

export interface PermissionApprovalRequest {
	readonly action: PermissionAction;
	readonly args: unknown;
	readonly reason: string;
	readonly cwd?: string;
	readonly executionTarget?: PermissionExecutionTarget;
	readonly rememberProjectEligible?: boolean;
	readonly actor?: PermissionActor;
	readonly signal?: AbortSignal;
}

export interface PermissionApprovalDecision {
	readonly decision: "allow" | "deny";
	readonly remember?: "project";
	readonly reason?: string;
}

export type RequestPermissionApproval = (request: PermissionApprovalRequest) => Promise<PermissionApprovalDecision>;

export interface PermissionApprovalView {
	readonly title: string;
	readonly summary: string;
	readonly details: string;
}

export type PermissionAuthorizationSource = "automatic" | "user" | "project-rule" | "fallback";

export type PermissionAuthorization =
	| {
			readonly decision: "allow";
			readonly source: Exclude<PermissionAuthorizationSource, "fallback">;
			readonly reason: string;
			readonly action: PermissionAction;
			readonly executionTarget: PermissionExecutionTarget;
	  }
	| {
			readonly decision: "deny";
			readonly source: "user" | "fallback";
			readonly reason: string;
			readonly action: PermissionAction;
			readonly executionTarget: PermissionExecutionTarget;
	  };

export interface ClassifyActionInput {
	readonly actionId: string;
	readonly toolName: string;
	readonly provenance: ToolProvenance;
	readonly args: unknown;
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly readOnlyRoots?: readonly string[];
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
	readonly projectPath?: string;
	readonly cwd?: string;
	readonly workspaceRoots?: readonly string[];
	readonly allowProjectRules?: boolean;
	readonly executionTarget?: PermissionExecutionTarget;
	readonly signal?: AbortSignal;
}

const MAX_PERMISSION_APPROVAL_UTF8_BYTES = 48 * 1024;
const DIRECT_HOST_WARNING =
	"Metis does not sandbox this action. Built-in tools run as your current OS user; installed integrations run with the authority you configured.";
const BASH_HOST_EFFECT_WARNING =
	"Runs directly on your computer without a sandbox. It may read or change files, start processes, or access the network.";
const BASH_SANDBOX_WARNING =
	"Runs in the Metis workspace sandbox. Reads and writes are limited to approved workspace and app-owned paths; network access is blocked.";
const IRREVERSIBLE_WARNING =
	"This action may be irreversible or affect an external target. Verify the command and target before allowing it.";

const RISK_ORDER: readonly ActionRisk[] = [
	"ordinary-read",
	"outside-read",
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

const STRUCTURED_READ_TOOLS = new Set(["read", "grep", "find", "ls", "describe_image"]);
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

function isInsideWorkspaceRoots(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => isPathInside(root, path));
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
		isSensitivePath(normalized.paths[0]!, input.cwd, traversal, input.workspaceRoots)
			? ["sensitive-read"]
			: isInsideWorkspaceRoots(normalized.paths[0]!, [...input.workspaceRoots, ...(input.readOnlyRoots ?? [])])
				? ["ordinary-read"]
				: ["outside-read"],
		normalized.paths,
	);
}

function classifyStructuredWrite(input: ClassifyActionInput, rawPath: string): PermissionAction {
	const normalized = normalizePaths([rawPath], input.cwd);
	if (normalized.invalid || normalized.paths.length !== 1) return action(input, ["unknown"], normalized.paths);
	return action(
		input,
		isInsideWorkspaceRoots(normalized.paths[0]!, input.workspaceRoots) ? ["workspace-write"] : ["outside-write"],
		normalized.paths,
	);
}

function isOpaqueBashExecution(command: string): boolean {
	return (
		/(?:^|[;&|]\s*)(?:\.{1,2}[/\\]|(?:bash|sh|zsh|fish|pwsh|powershell|cmd)(?:\.exe)?\b)/iu.test(command) ||
		/\b(?:node|nodejs|deno|python\d*|pypy\d*|perl|ruby|php|lua|osascript)\b[^\n]*(?:\s(?:-[ceEr]|--eval|--print|--input-type)(?:\s|=)|<<)/iu.test(
			command,
		) ||
		/(?:^|[;&|]\s*)(?:eval|source)\b|(?:^|[;&|]\s*)\.\s+|\$\(|`|\$'|\\(?:x[\da-f]{2}|u[\da-f]{4}|u\{[\da-f]+\})/iu.test(
			command,
		)
	);
}

function classifyBash(input: ClassifyActionInput, command: string): PermissionAction {
	const risks: ActionRisk[] = ["shell"];
	if (bashReferencesSensitivePath(command)) risks.push("sensitive-read");
	if (isOpaqueBashExecution(command)) risks.push("unknown");
	if (
		/\b(?:rm|rmdir|shred|truncate|dd|mkfs|del|erase|format)\b/iu.test(command) ||
		/\bfind\b[^\n]*\s-delete\b/iu.test(command) ||
		/\bgit\s+(?:reset\s+--hard|clean\b)/iu.test(command) ||
		/\b(?:kill|pkill|killall|reboot|shutdown)\b/iu.test(command) ||
		/\b(?:chmod|chown|chgrp)\b/iu.test(command)
	) {
		risks.push("destructive");
	}
	if (/\bgit\s+push\b|\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b|\bdeploy\b/iu.test(command)) {
		risks.push("external-side-effect");
	}
	if (
		/\b(?:curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b|\bgit\s+(?:push|pull|fetch|clone)\b|\b(?:npm|pnpm|yarn|bun|pip|pip3|cargo|brew)\s+(?:install|add|update|publish)\b/iu.test(
			command,
		)
	) {
		risks.push("network");
	}
	if (/\b(?:sudo|doas|runas|su)\b|\bStart-Process\b.*\b-Verb\s+RunAs\b/iu.test(command)) risks.push("elevation");
	return action(input, risks, [], command);
}

export function classifyAction(input: ClassifyActionInput): PermissionAction {
	if (input.provenance !== "builtin") {
		const risks: ActionRisk[] = ["custom"];
		if (input.mcpAnnotations?.destructiveHint) risks.push("destructive", "external-side-effect");
		return action(input, risks);
	}
	if (
		[
			"set_tasks",
			"ask_user",
			"deliver_file",
			"tool_search",
			"inspect_agents",
			"get_goal",
			"create_goal",
			"update_goal",
		].includes(input.toolName)
	) {
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
		return typeof args.command === "string" ? classifyBash(input, args.command) : action(input, ["unknown"]);
	}
	if (STRUCTURED_READ_TOOLS.has(input.toolName)) {
		if (args.path !== undefined && typeof args.path !== "string") return action(input, ["unknown"]);
		if (args.path === undefined && input.toolName === "read") return action(input, ["unknown"]);
		// describe_image reads a single file like `read`, so it must not be
		// classified with the directory-traversal semantics of grep/find/ls.
		const traversal = input.toolName !== "read" && input.toolName !== "describe_image";
		return classifyStructuredRead(input, typeof args.path === "string" ? args.path : input.cwd, traversal);
	}
	if (STRUCTURED_WRITE_TOOLS.has(input.toolName)) {
		return typeof args.path === "string" ? classifyStructuredWrite(input, args.path) : action(input, ["unknown"]);
	}
	return action(input, ["unknown"]);
}

export function routeAction(settings: PermissionSettings, value: PermissionAction): PermissionRoute {
	if (settings.mode === "full") return "allow";
	if (value.risks.length === 1 && value.risks[0] === "ordinary-read") return "allow";
	// Auto mode lets structured reads of workspace-external paths run without
	// approval; sensitive paths are classified separately and still ask.
	if (settings.mode === "auto" && value.risks.length === 1 && value.risks[0] === "outside-read") return "allow";
	if (settings.mode === "ask") return "user";
	if (value.provenance !== "builtin") return "allow";
	if (value.risks.length === 1 && value.risks[0] === "workspace-write") return "allow";
	if (value.toolName === "bash") return value.risks.length === 1 && value.risks[0] === "shell" ? "allow" : "user";
	if (value.toolName === "web_fetch" || value.toolName === "web_search") {
		return value.risks.length === 1 && value.risks[0] === "network" ? "allow" : "user";
	}
	return "user";
}

export function executionTargetFor(settings: PermissionSettings, value: PermissionAction): PermissionExecutionTarget {
	if (
		settings.mode !== "full" &&
		value.toolName === "bash" &&
		!value.risks.some((risk) => ["network", "elevation", "external-side-effect"].includes(risk))
	) {
		return "sandbox";
	}
	return "host";
}

export function revalidateStructuredActionBinding(
	approved: PermissionAction,
	args: unknown,
	cwd: string,
	workspaceRoots: readonly string[],
	readOnlyRoots: readonly string[] = [],
): boolean {
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
		workspaceRoots,
		readOnlyRoots,
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
		request.actor ? `Agent: ${request.actor.name} (${request.actor.id})` : undefined,
		request.actor ? `Task: ${request.actor.taskId}` : undefined,
		request.executionTarget === "sandbox" ? undefined : DIRECT_HOST_WARNING,
		value.toolName === "bash"
			? request.executionTarget === "sandbox"
				? BASH_SANDBOX_WARNING
				: BASH_HOST_EFFECT_WARNING
			: undefined,
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
	private readonly projectRules?: ProjectPermissionRuleStore;

	constructor(requestApproval?: RequestPermissionApproval, projectRules?: ProjectPermissionRuleStore) {
		this.requestApproval = requestApproval;
		this.projectRules = projectRules;
	}

	setRequestApproval(requestApproval?: RequestPermissionApproval): void {
		this.requestApproval = requestApproval;
	}

	async authorize(input: PermissionAuthorizeInput): Promise<PermissionAuthorization> {
		const executionTarget = executionTargetFor(input.settings, input.action);
		if (input.executionTarget !== undefined && input.executionTarget !== executionTarget) {
			return {
				decision: "deny",
				source: "fallback",
				reason: "Permission execution target changed before authorization",
				action: input.action,
				executionTarget,
			};
		}
		if (input.settings.mode === "full") {
			return {
				decision: "allow",
				source: "automatic",
				reason: "Full access is enabled",
				action: input.action,
				executionTarget,
			};
		}
		if (routeAction(input.settings, input.action) === "allow") {
			return {
				decision: "allow",
				source: "automatic",
				reason: input.settings.mode === "auto" ? "Allowed by Auto mode" : "Allowed safe structured read",
				action: input.action,
				executionTarget,
			};
		}
		let signature: ProjectPermissionSignatureInput | undefined;
		if (
			input.allowProjectRules === true &&
			this.projectRules &&
			input.projectPath !== undefined &&
			input.cwd !== undefined &&
			input.workspaceRoots !== undefined &&
			input.executionTarget !== undefined &&
			!input.action.risks.includes("unknown")
		) {
			signature = {
				projectPath: input.projectPath,
				cwd: input.cwd,
				workspaceRoots: input.workspaceRoots,
				action: input.action,
				args: input.args,
				executionTarget,
			};
			try {
				if (this.projectRules.match(signature)) {
					return {
						decision: "allow",
						source: "project-rule",
						reason: "Allowed by an exact current-project rule",
						action: input.action,
						executionTarget,
					};
				}
			} catch {
				return {
					decision: "deny",
					source: "fallback",
					reason: "Current-project permission rules could not be read safely",
					action: input.action,
					executionTarget,
				};
			}
		}
		if (!this.requestApproval) {
			return {
				decision: "deny",
				source: "fallback",
				reason: "This action requires approval, but no approval UI is available",
				action: input.action,
				executionTarget,
			};
		}
		try {
			if (input.signal?.aborted) throw new Error("Approval was aborted");
			const approved = await this.requestApproval({
				action: structuredClone(input.action),
				args: structuredClone(input.args),
				reason: "This model-initiated action can affect the host or access sensitive data",
				executionTarget,
				rememberProjectEligible: signature !== undefined && this.projectRules !== undefined,
				signal: input.signal,
			});
			if (input.signal?.aborted) throw new Error("Approval was aborted");
			if (approved.decision === "allow" && approved.remember === "project") {
				if (!signature || !this.projectRules) {
					return {
						decision: "deny",
						source: "fallback",
						reason: "This action is not eligible for a current-project permission rule",
						action: input.action,
						executionTarget,
					};
				}
				try {
					this.projectRules.remember(signature);
				} catch {
					return {
						decision: "deny",
						source: "fallback",
						reason: "The current-project permission rule could not be saved safely",
						action: input.action,
						executionTarget,
					};
				}
			}
			return approved.decision === "allow"
				? {
						decision: "allow",
						source: "user",
						reason: approved.reason ?? "Allowed once by the user",
						action: input.action,
						executionTarget,
					}
				: {
						decision: "deny",
						source: "user",
						reason: approved.reason ?? "Denied by the user",
						action: input.action,
						executionTarget,
					};
		} catch {
			return {
				decision: "deny",
				source: "fallback",
				reason: "The approval UI closed or failed before a decision",
				action: input.action,
				executionTarget,
			};
		}
	}
}
