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

export type PermissionExecutionTarget = "sandbox" | "host" | "external";

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

const MAX_PERMISSION_APPROVAL_UTF8_BYTES = 48 * 1024;
const DIRECT_HOST_WARNING = "This action will run outside the sandbox with your current user permissions.";
const BASH_HOST_EFFECT_WARNING =
	"Runs directly on your computer without a sandbox. It may read or change files, start processes, or access the network.";
const BASH_SANDBOX_WARNING = "This command remains limited to the displayed workspace sandbox.";
const EXTERNAL_WARNING = "This action reaches a network or external service.";
const IRREVERSIBLE_WARNING = "This operation may not be reversible.";

export function formatPermissionApproval(request: PermissionApprovalRequest): PermissionApprovalView {
	const { action: value } = request;
	const lines = [
		request.actor ? `Agent: ${request.actor.name}` : undefined,
		request.executionTarget === "sandbox"
			? BASH_SANDBOX_WARNING
			: request.executionTarget === "external"
				? EXTERNAL_WARNING
				: DIRECT_HOST_WARNING,
		value.toolName === "bash" && request.executionTarget !== "sandbox" ? BASH_HOST_EFFECT_WARNING : undefined,
		value.risks.includes("destructive") || value.risks.includes("external-side-effect")
			? IRREVERSIBLE_WARNING
			: undefined,
		`Risk: ${value.risks.join(", ")}`,
		value.command === undefined ? undefined : `Command: ${value.command}`,
		...value.paths.map((path) => `Path: ${path}`),
		...value.networkTargets.map(({ host, port }) => `Network: ${host}:${port}`),
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
