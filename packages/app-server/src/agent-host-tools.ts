import {
	createAskUserToolDefinition,
	type SessionDeliveredArtifacts,
	type ToolDefinition,
} from "@metis/coding-agent/host";
import type { BrowserPermissionAudit } from "./browser-permission-audit.ts";
import { BROWSER_TOOL_NAMES, browserToolCall, createBrowserToolDefinitions } from "./browser-tools.ts";
import type { InteractionBroker } from "./interactions.ts";

/** Trusted identity supplied by the runtime, never by model tool arguments. */
export interface AgentHostIdentity {
	readonly rootSessionId: string;
	readonly actorSessionId: string;
	readonly agentId?: string;
	readonly taskId?: string;
}

export const DELEGATABLE_HOST_TOOL_NAMES = ["ask_user", "deliver_file", ...BROWSER_TOOL_NAMES] as const;

export interface AgentHostToolsOptions {
	readonly rootSessionId: string;
	readonly actorSessionId?: string;
	readonly agentId?: string;
	readonly taskId?: () => string | undefined;
	/** Already intersected with the parent and role capabilities; no implicit widening. */
	readonly allowedToolNames: readonly string[];
	readonly interactions?: InteractionBroker;
	readonly deliveredArtifacts?: Pick<SessionDeliveredArtifacts, "createToolDefinition">;
	readonly audit?: BrowserPermissionAudit;
}

/** Rebuild actor-bound closures for both fresh and resumed sessions. */
export function createAgentHostTools(options: AgentHostToolsOptions) {
	const allowed = new Set(options.allowedToolNames);
	const identity = (): AgentHostIdentity => {
		const taskId = options.taskId?.();
		if (options.agentId && !taskId) throw new Error("Child host tools require an active task identity");
		return {
			rootSessionId: options.rootSessionId,
			actorSessionId: options.actorSessionId ?? options.agentId ?? options.rootSessionId,
			...(options.agentId ? { agentId: options.agentId } : {}),
			...(taskId ? { taskId } : {}),
		};
	};
	const tools: ToolDefinition<any, any, any>[] = [];
	const interactions = options.interactions;
	if (interactions) {
		if (allowed.has("ask_user")) {
			tools.push(
				createAskUserToolDefinition((request) =>
					interactions.requestUserInput(options.rootSessionId, request, identity()),
				),
			);
		}
		tools.push(
			...createBrowserToolDefinitions(
				(request) =>
					interactions.requestBrowserTool(
						options.rootSessionId,
						request.toolCallId,
						browserToolCall(request),
						request.signal,
						identity(),
					),
				options.audit,
			).filter((tool) => allowed.has(tool.name)),
		);
	}
	if (allowed.has("deliver_file") && options.deliveredArtifacts) {
		const delivery = options.deliveredArtifacts.createToolDefinition();
		const boundDelivery: typeof delivery = {
			...delivery,
			async execute(...args) {
				const actor = identity();
				const result = await delivery.execute(...args);
				return { ...result, details: { ...result.details, ...actor } };
			},
		};
		tools.push(boundDelivery);
	}
	return {
		tools,
		automaticPermissionToolNames: tools.filter((tool) => tool.name !== "deliver_file").map((tool) => tool.name),
		delegatableToolNames: tools.map((tool) => tool.name),
	};
}
