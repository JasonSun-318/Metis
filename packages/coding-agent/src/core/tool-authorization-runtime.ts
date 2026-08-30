import { isDeepStrictEqual } from "node:util";
import type { AgentTool } from "@metis/agent-core";
import { canonicalizeActionPath } from "../utils/paths.ts";
import type { InteractiveBashBoundary } from "./interactive-bash-boundary.ts";
import { narrowPermissionMode, type PermissionMode } from "./permission-mode.ts";
import {
	type ClassifyActionInput,
	classifyAction,
	executionTargetFor,
	type NetworkTarget,
	type PermissionAction,
	type PermissionApprovalDecision,
	type PermissionApprovalRequest,
	type PermissionExecutionTarget,
	PermissionPolicy,
	type RequestPermissionApproval,
	type ToolProvenance,
	unclassifiedAction,
} from "./permission-policy.ts";
import { ProjectPermissionRuleStore } from "./project-permission-rules.ts";
import type { SessionManager } from "./session-manager.ts";
import {
	authorizeUnattendedAction,
	revalidateUnattendedAction,
	type UnattendedExecutionProfile,
} from "./unattended-execution.ts";

interface AuthorizedPermissionAction {
	readonly action: PermissionAction;
	readonly args: unknown;
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly authorizedMode: PermissionMode | "unattended";
	readonly executionTarget: PermissionExecutionTarget;
}

interface ToolAuthorizationRuntimeOptions {
	readonly agentDir?: string;
	readonly sessionManager: SessionManager;
	readonly cwd: () => string;
	readonly readOnlyRoots: () => readonly string[];
	readonly toolSource: (toolName: string) => string | undefined;
	readonly mcpAnnotations: (toolName: string) => ClassifyActionInput["mcpAnnotations"];
	readonly webSearchNetworkTarget: () => NetworkTarget;
	readonly isTrustedControlTool: (toolName: string) => boolean;
	readonly runtimeShellCommandPrefix: () => string | undefined;
	readonly permissionModeCeiling?: () => PermissionMode;
	readonly workspaceWritePolicy: "inherit" | "deny";
	readonly unattendedExecution?: UnattendedExecutionProfile;
	readonly bashBoundary?: Pick<InteractiveBashBoundary, "bind" | "unbind">;
	readonly requestApproval?: RequestPermissionApproval;
}

function permissionError(toolName: string, error: unknown): string {
	return error instanceof Error ? error.message : `Permission denied for ${toolName}`;
}

export class ToolAuthorizationRuntime {
	private readonly options: ToolAuthorizationRuntimeOptions;
	private readonly policy: PermissionPolicy;
	private readonly grants = new Map<string, AuthorizedPermissionAction>();
	private readonly denials = new Map<string, string>();
	private approvalHandler?: RequestPermissionApproval;
	private approvalTail: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(options: ToolAuthorizationRuntimeOptions) {
		this.options = options;
		this.approvalHandler = options.requestApproval;
		this.policy = new PermissionPolicy(
			(request) => this.requestApproval(request),
			options.agentDir && !options.unattendedExecution
				? new ProjectPermissionRuleStore(options.agentDir)
				: undefined,
		);
	}

	setApprovalHandler(handler?: RequestPermissionApproval): void {
		this.approvalHandler = handler;
	}

	requestApproval(request: PermissionApprovalRequest): Promise<PermissionApprovalDecision> {
		if (this.disposed) return Promise.reject(new Error("Tool authorization runtime is disposed"));
		const approval = request.cwd === undefined ? { ...request, cwd: this.options.cwd() } : request;
		const pending = this.approvalTail.then(async () => {
			if (this.disposed) throw new Error("Tool authorization runtime is disposed");
			if (approval.signal?.aborted) throw new Error("Approval was aborted while queued");
			const handler = this.approvalHandler;
			if (!handler) throw new Error("No interactive session owner is available");
			const decision = await handler(approval);
			if (this.disposed) throw new Error("Tool authorization runtime is disposed");
			if (approval.signal?.aborted) throw new Error("Approval was aborted before completion");
			return decision;
		});
		this.approvalTail = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	async beforeToolExecute(
		input: { readonly actionId: string; readonly toolName: string; readonly args: unknown },
		signal?: AbortSignal,
		onPrepared?: () => void | Promise<void>,
	): Promise<void> {
		this.assertActive();
		if (!this.options.isTrustedControlTool(input.toolName)) {
			try {
				await this.authorize({ ...input, signal });
			} catch (error) {
				this.grants.delete(input.actionId);
				this.denials.set(input.actionId, permissionError(input.toolName, error));
			}
		}
		try {
			await onPrepared?.();
		} catch (error) {
			this.clear(input.actionId);
			throw error;
		}
	}

	guard(tool: AgentTool): AgentTool {
		return {
			...tool,
			execute: async (toolCallId, args, signal, onUpdate) => {
				this.assertActive();
				if (this.options.isTrustedControlTool(tool.name)) {
					return tool.execute(toolCallId, args, signal, onUpdate);
				}
				const denial = this.denials.get(toolCallId);
				if (denial) throw new Error(denial);
				const authorization = this.take(toolCallId, tool.name, args);
				if (tool.name === "bash") this.options.bashBoundary?.bind(toolCallId, authorization.executionTarget);
				try {
					return await tool.execute(toolCallId, args, signal, onUpdate);
				} finally {
					if (tool.name === "bash") this.options.bashBoundary?.unbind(toolCallId);
				}
			},
		};
	}

	clear(actionId?: string): void {
		if (actionId === undefined) {
			this.grants.clear();
			this.denials.clear();
			return;
		}
		this.grants.delete(actionId);
		this.denials.delete(actionId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.approvalHandler = undefined;
		this.clear();
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Tool authorization runtime is disposed");
	}

	private toolProvenance(toolName: string): ToolProvenance {
		const source = this.options.toolSource(toolName)?.toLowerCase();
		if (source === "builtin") return "builtin";
		if (source === "sdk") return "sdk";
		if (source === "mcp" || source?.startsWith("mcp:")) return "mcp";
		return "extension";
	}

	private effectivePermissionSettings(): { readonly mode: PermissionMode } {
		const stored = this.options.sessionManager.getPermissionSettings();
		return {
			mode: this.options.permissionModeCeiling
				? narrowPermissionMode(stored.mode, this.options.permissionModeCeiling())
				: stored.mode,
		};
	}

	private effectiveBashCommand(toolName: string, provenance: ToolProvenance, args: unknown): string | undefined {
		if (provenance !== "builtin" || toolName !== "bash" || typeof args !== "object" || args === null) {
			return undefined;
		}
		const command = (args as Record<string, unknown>).command;
		if (typeof command !== "string") return undefined;
		const prefix = this.options.runtimeShellCommandPrefix();
		return prefix ? `${prefix}\n${command}` : command;
	}

	private classifyInput(input: {
		readonly actionId: string;
		readonly toolName: string;
		readonly provenance: ToolProvenance;
		readonly args: unknown;
		readonly cwd: string;
		readonly workspaceRoots: readonly string[];
		readonly readOnlyRoots: readonly string[];
	}): ClassifyActionInput {
		return {
			...input,
			mcpAnnotations: input.provenance === "mcp" ? this.options.mcpAnnotations(input.toolName) : undefined,
			builtinNetworkTargets:
				input.provenance === "builtin" && input.toolName === "web_search"
					? [this.options.webSearchNetworkTarget()]
					: undefined,
		};
	}

	private async authorize(input: {
		readonly actionId: string;
		readonly toolName: string;
		readonly args: unknown;
		readonly signal?: AbortSignal;
	}): Promise<AuthorizedPermissionAction> {
		if (this.grants.has(input.actionId)) throw new Error(`Permission action ID was reused: ${input.actionId}`);
		const approvedArgs = structuredClone(input.args);
		const approvedCwd = this.options.cwd();
		const approvedWorkspaceRoots =
			this.options.unattendedExecution?.workspaceRoots ?? this.options.sessionManager.getWorkspaceRoots();
		const approvedReadOnlyRoots = this.options.readOnlyRoots();
		const approvedSettings = this.effectivePermissionSettings();
		const provenance = this.toolProvenance(input.toolName);
		const effectiveCommand = this.effectiveBashCommand(input.toolName, provenance, approvedArgs);
		const classificationArgs =
			effectiveCommand === undefined
				? structuredClone(approvedArgs)
				: { ...(structuredClone(approvedArgs) as Record<string, unknown>), command: effectiveCommand };
		const classifyInput = this.classifyInput({
			actionId: input.actionId,
			toolName: input.toolName,
			provenance,
			args: classificationArgs,
			cwd: approvedCwd,
			workspaceRoots: approvedWorkspaceRoots,
			readOnlyRoots: approvedReadOnlyRoots,
		});
		const planBash = this.options.sessionManager.getCollaborationMode() === "plan" && input.toolName === "bash";
		const action =
			this.options.unattendedExecution || planBash
				? classifyAction(classifyInput)
				: approvedSettings.mode === "full"
					? unclassifiedAction(classifyInput)
					: classifyAction(classifyInput);
		if (planBash) {
			const forbidden = action.risks.filter((risk) =>
				["sensitive-read", "unknown", "network", "elevation", "destructive", "external-side-effect"].includes(risk),
			);
			if (forbidden.length > 0) {
				throw new Error(`Permission denied for bash in Plan mode: ${forbidden.join(", ")}`);
			}
		}
		const writePolicyBash = this.options.workspaceWritePolicy === "deny" && input.toolName === "bash";
		const executionTarget =
			planBash || writePolicyBash
				? "sandbox"
				: this.options.unattendedExecution
					? action.toolName === "bash"
						? "sandbox"
						: "host"
					: executionTargetFor(approvedSettings, action);
		const header = this.options.sessionManager.getHeader();
		const authorization =
			planBash || writePolicyBash
				? {
						decision: "allow" as const,
						reason: writePolicyBash
							? "Write-denied agents confine Bash to the read-only workspace sandbox"
							: "Plan Bash is confined to the read-only workspace sandbox",
						source: "automatic" as const,
						action,
						executionTarget: "sandbox" as const,
					}
				: this.options.unattendedExecution
					? authorizeUnattendedAction({
							profile: this.options.unattendedExecution,
							action,
							args: structuredClone(approvedArgs),
							cwd: approvedCwd,
						})
					: await this.policy.authorize({
							settings: approvedSettings,
							action,
							args: structuredClone(approvedArgs),
							projectPath: canonicalizeActionPath(
								this.options.sessionManager.getCwd(),
								this.options.sessionManager.getCwd(),
							),
							cwd: approvedCwd,
							workspaceRoots: approvedWorkspaceRoots,
							allowProjectRules: !header?.agent && !header?.scheduled,
							executionTarget,
							signal: input.signal,
						});
		if (authorization.decision === "deny") {
			if (this.options.unattendedExecution) {
				this.appendAudit(action, "deny", authorization.reason, "policy");
			} else if (authorization.source === "user") {
				this.appendAudit(action, "deny", authorization.reason);
			}
			throw new Error(`Permission denied for ${input.toolName}: ${authorization.reason}`);
		}
		if (authorization.source === "user") this.appendAudit(action, "allow", authorization.reason);
		const authorized = {
			action,
			args: approvedArgs,
			cwd: approvedCwd,
			workspaceRoots: approvedWorkspaceRoots,
			authorizedMode: this.options.unattendedExecution ? "unattended" : approvedSettings.mode,
			executionTarget: authorization.executionTarget,
		} satisfies AuthorizedPermissionAction;
		this.grants.set(input.actionId, authorized);
		return authorized;
	}

	private appendAudit(
		action: PermissionAction,
		decision: "allow" | "deny",
		reason: string,
		source: "user" | "policy" = "user",
	): void {
		this.options.sessionManager.appendPermissionDecision({
			actionId: action.actionId,
			toolName: action.toolName,
			source,
			decision,
			reason,
		});
	}

	private take(actionId: string, toolName: string, args: unknown): AuthorizedPermissionAction {
		const authorized = this.grants.get(actionId);
		this.grants.delete(actionId);
		if (!authorized || authorized.action.toolName !== toolName || authorized.action.actionId !== actionId) {
			throw new Error(`Invalid or expired one-action permission grant for ${toolName}`);
		}
		if (!isDeepStrictEqual(args, authorized.args)) {
			throw new Error(`${toolName} arguments changed after permission approval`);
		}
		const cwd = this.options.cwd();
		if (cwd !== authorized.cwd) throw new Error(`${toolName} working directory changed after permission approval`);
		if (
			toolName === "bash" &&
			authorized.action.command !== this.effectiveBashCommand(toolName, authorized.action.provenance, args)
		) {
			throw new Error("Bash effective command changed after permission approval");
		}
		if (authorized.authorizedMode === "unattended") {
			if (!this.options.unattendedExecution) throw new Error("Unattended execution profile is unavailable");
			revalidateUnattendedAction({
				profile: this.options.unattendedExecution,
				authorized: authorized.action,
				toolName,
				args,
				cwd,
			});
			return authorized;
		}
		const currentSettings = this.effectivePermissionSettings();
		if (narrowPermissionMode(authorized.authorizedMode, currentSettings.mode) !== authorized.authorizedMode) {
			throw new Error(`${toolName} permission mode narrowed before execution; retry requires approval`);
		}
		const currentWorkspaceRoots = this.options.sessionManager.getWorkspaceRoots();
		if (
			authorized.authorizedMode !== "full" &&
			!isDeepStrictEqual(currentWorkspaceRoots, authorized.workspaceRoots)
		) {
			throw new Error(`${toolName} workspace roots changed after authorization; retry requires approval`);
		}
		if (authorized.authorizedMode !== "full") {
			const provenance = this.toolProvenance(toolName);
			if (provenance !== authorized.action.provenance) {
				throw new Error(`${toolName} provenance changed after authorization; retry requires approval`);
			}
			const effectiveCommand = this.effectiveBashCommand(toolName, provenance, args);
			const currentArgs =
				effectiveCommand === undefined
					? structuredClone(args)
					: { ...(structuredClone(args) as Record<string, unknown>), command: effectiveCommand };
			const currentAction = classifyAction(
				this.classifyInput({
					actionId,
					toolName,
					provenance,
					args: currentArgs,
					cwd: authorized.cwd,
					workspaceRoots: currentWorkspaceRoots,
					readOnlyRoots: this.options.readOnlyRoots(),
				}),
			);
			if (
				toolName === "web_search" &&
				!isDeepStrictEqual(currentAction.networkTargets, authorized.action.networkTargets)
			) {
				throw new Error("web_search provider changed after permission approval; retry the search");
			}
			if (!isDeepStrictEqual(currentAction, authorized.action)) {
				throw new Error(`${toolName} classification changed after authorization; retry requires approval`);
			}
		}
		return authorized;
	}
}
