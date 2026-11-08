import type { ClientRpcRequest } from "@metis/app-protocol";
import type { WebSearchService } from "../web-search.ts";

export interface WebSearchDispatchContext {
	readonly webSearch: WebSearchService;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
	refreshOpenWebSearchSettings(): Promise<void>;
}

export function isWebSearchRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("webSearch/");
}

export async function dispatchWebSearchRequest(
	request: ClientRpcRequest,
	context: WebSearchDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "webSearch/get":
			return context.webSearch.view();
		case "webSearch/credential/reveal":
			return context.webSearch.reveal(request.params);
		case "webSearch/update":
			return await context.replayMutation(request, async () => {
				const result = await context.webSearch.update(request.params);
				await context.refreshOpenWebSearchSettings();
				return result;
			});
		default:
			throw new Error(`Unhandled web search request: ${request.method}`);
	}
}
