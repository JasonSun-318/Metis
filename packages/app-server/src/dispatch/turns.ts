import type { ClientParams, ClientRpcRequest } from "@metis/app-protocol";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionRef } from "../session-runtime-host.ts";

export interface TurnsDispatchContext {
	readonly registry: SessionRegistry;
	runtimeRef(sessionId: string): SessionRef;
	assertMutableSession(sessionId: string): void;
	startTitleJob(sessionId: string, input: ClientParams<"turn/start">): void;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isTurnsRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("turn/");
}

export async function dispatchTurnsRequest(request: ClientRpcRequest, context: TurnsDispatchContext): Promise<unknown> {
	switch (request.method) {
		case "turn/start":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, async (runtime) => {
					const unnamed = !runtime.getSummary().name;
					const result = await runtime.startTurn(request.params);
					if (unnamed) context.startTitleJob(request.params.sessionId, request.params);
					return result;
				});
			});
		case "turn/steer":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.steer(request.params));
			});
		case "turn/queue":
			return await context.replayMutation(request, () => {
				context.assertMutableSession(request.params.sessionId);
				return context.registry.run(context.runtimeRef(request.params.sessionId), (runtime) =>
					runtime.queueTurn(request.params),
				);
			});
		case "turn/queue/update":
			return await context.replayMutation(request, () => {
				context.assertMutableSession(request.params.sessionId);
				return context.registry.run(context.runtimeRef(request.params.sessionId), (runtime) =>
					runtime.updateQueuedTurn(request.params),
				);
			});
		case "turn/queue/delete":
			return await context.replayMutation(request, () => {
				context.assertMutableSession(request.params.sessionId);
				return context.registry.run(context.runtimeRef(request.params.sessionId), (runtime) =>
					runtime.deleteQueuedTurn(request.params),
				);
			});
		case "turn/queue/send":
			return await context.replayMutation(request, () => {
				context.assertMutableSession(request.params.sessionId);
				return context.registry.run(context.runtimeRef(request.params.sessionId), (runtime) =>
					runtime.sendQueuedTurn(request.params),
				);
			});
		case "turn/interrupt":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.interrupt(request.params));
			});
		default:
			throw new Error(`Unhandled turn request: ${request.method}`);
	}
}
