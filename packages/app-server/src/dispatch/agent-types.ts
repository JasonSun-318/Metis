import type { ClientRpcRequest } from "@metis/app-protocol";
import type { SessionRegistry } from "../session-registry.ts";

export interface AgentTypeDispatchContext {
	readonly registry: SessionRegistry;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isAgentTypeRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("agentType/");
}

export async function dispatchAgentTypeRequest(
	request: ClientRpcRequest,
	context: AgentTypeDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "agentType/list":
			return await context.registry.listAgentTypes();
		case "agentType/upsert":
			return await context.replayMutation(request, () => context.registry.upsertAgentType(request.params));
		case "agentType/remove":
			return await context.replayMutation(request, () => context.registry.removeAgentType(request.params));
		default:
			throw new Error(`Unhandled agent type request: ${request.method}`);
	}
}
