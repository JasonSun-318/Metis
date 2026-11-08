import type { ClientRpcRequest } from "@metis/app-protocol";
import type { HooksService } from "../hooks.ts";

export interface HooksDispatchContext {
	readonly hooks: HooksService;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isHooksRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("hooks/");
}

export async function dispatchHooksRequest(request: ClientRpcRequest, context: HooksDispatchContext): Promise<unknown> {
	switch (request.method) {
		case "hooks/list":
			return context.hooks.view();
		case "hooks/upsert":
			return await context.replayMutation(request, async () => context.hooks.upsert(request.params));
		case "hooks/delete":
			return await context.replayMutation(request, async () => context.hooks.delete(request.params));
		default:
			throw new Error(`Unhandled hooks request: ${request.method}`);
	}
}
