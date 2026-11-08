import type { ClientRpcRequest } from "@metis/app-protocol";
import type { AgentCatalog } from "../agent-catalog.ts";
import { readAgentCatalogItems, readAgentCatalogQueue } from "../agent-catalog.ts";
import { deleteArchivedAgent } from "../archived-conversations.ts";
import type { InteractionBroker, InteractionPeer } from "../interactions.ts";
import type { SessionCatalog } from "../session-catalog.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionRef } from "../session-runtime-host.ts";
import type { ConnectionSubscriptions } from "../subscriptions.ts";

export interface AgentsDispatchContext {
	readonly registry: SessionRegistry;
	readonly catalog: SessionCatalog;
	readonly agentCatalog: AgentCatalog;
	readonly connectionSubscriptions: ConnectionSubscriptions;
	readonly interactions: InteractionBroker;
	readonly interactionPeer: InteractionPeer;
	runtimeRef(sessionId: string): SessionRef;
	assertMutableSession(sessionId: string): void;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isAgentsRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("agent/");
}

export async function dispatchAgentsRequest(
	request: ClientRpcRequest,
	context: AgentsDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "agent/readItems": {
			const ref = context.runtimeRef(request.params.sessionId);
			const opened = await context.registry.withOpenRuntime(request.params.sessionId, async (runtime) => {
				if (!context.connectionSubscriptions.has(runtime.sessionId))
					await context.connectionSubscriptions.subscribe(runtime);
				return runtime.readAgentItems(request.params);
			});
			return opened.open ? opened.result : readAgentCatalogItems(ref, context.catalog.agentDir, request.params);
		}
		case "agent/list": {
			const ref = context.runtimeRef(request.params.sessionId);
			const opened = await context.registry.withOpenRuntime(request.params.sessionId, (runtime) =>
				runtime.listAgents(request.params),
			);
			return opened.open ? opened.result : context.agentCatalog.list(ref, request.params);
		}
		case "agent/send":
		case "agent/control":
			return await context.replayMutation(request, async () => {
				context.assertMutableSession(request.params.sessionId);
				const ref = context.runtimeRef(request.params.sessionId);
				context.interactions.assign(request.params.sessionId, context.interactionPeer);
				return await context.registry.run(ref, async (runtime) => {
					if (!context.connectionSubscriptions.has(runtime.sessionId))
						await context.connectionSubscriptions.subscribe(runtime);
					return request.method === "agent/send"
						? runtime.sendAgentMessage(request.params)
						: runtime.controlAgent(request.params);
				});
			});
		case "agent/queue/read": {
			const ref = context.runtimeRef(request.params.sessionId);
			const opened = await context.registry.withOpenRuntime(request.params.sessionId, async (runtime) => {
				if (!context.connectionSubscriptions.has(runtime.sessionId))
					await context.connectionSubscriptions.subscribe(runtime);
				return runtime.readAgentQueuedMessages(request.params);
			});
			return opened.open ? opened.result : readAgentCatalogQueue(ref, context.catalog.agentDir, request.params);
		}
		case "agent/queue/delete":
		case "agent/queue/send":
			return await context.replayMutation(request, async () => {
				context.assertMutableSession(request.params.sessionId);
				const ref = context.runtimeRef(request.params.sessionId);
				context.interactions.assign(request.params.sessionId, context.interactionPeer);
				return await context.registry.run(ref, async (runtime) => {
					if (!context.connectionSubscriptions.has(runtime.sessionId))
						await context.connectionSubscriptions.subscribe(runtime);
					return request.method === "agent/queue/delete"
						? runtime.deleteAgentQueuedMessage(request.params)
						: runtime.sendAgentQueuedMessage(request.params);
				});
			});
		case "agent/interrupt":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.interruptAgent(request.params));
			});
		case "agent/archive":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.archiveAgent(request.params));
			});
		case "agent/rename":
			return await context.replayMutation(request, async () => {
				context.assertMutableSession(request.params.sessionId);
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.renameAgent(request.params));
			});
		case "agent/delete":
			return await context.replayMutation(request, async () => {
				if (context.catalog.get(request.params.sessionId).summary.archived) {
					context.assertMutableSession(request.params.sessionId);
					return await context.catalog.withSessionProjectMutable(request.params.sessionId, async (ref) => {
						context.registry.assertClosed(ref.summary.sessionId);
						return await deleteArchivedAgent(ref, context.catalog.agentDir, request.params);
					});
				}
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.deleteAgent(request.params));
			});
		default:
			throw new Error(`Unhandled agent request: ${request.method}`);
	}
}
