import type { ClientRpcRequest } from "@metis/app-protocol";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionRef } from "../session-runtime-host.ts";

export interface PlanDispatchContext {
	readonly registry: SessionRegistry;
	runtimeRef(sessionId: string): SessionRef;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isPlanRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("plan/");
}

export async function dispatchPlanRequest(request: ClientRpcRequest, context: PlanDispatchContext): Promise<unknown> {
	switch (request.method) {
		case "plan/startExecution":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.startPlanExecution(request.params));
			});
		case "plan/cancel":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.cancelPlan(request.params));
			});
		default:
			throw new Error(`Unhandled plan request: ${request.method}`);
	}
}
