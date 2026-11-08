import type { ClientRpcRequest } from "@metis/app-protocol";
import type { KnowledgeService } from "../knowledge.ts";

export interface KnowledgeDispatchContext {
	readonly knowledge: KnowledgeService;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isKnowledgeRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("knowledge/");
}

/**
 * Knowledge library requests are thin delegates over KnowledgeService. Keeping
 * them together in one module lets the main dispatcher shrink without changing
 * request semantics: parameter validation still happens in the protocol layer
 * and replay/idempotency still goes through the shared mutation helper.
 */
export async function dispatchKnowledgeRequest(
	request: ClientRpcRequest,
	context: KnowledgeDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "knowledge/list":
			return context.knowledge.list();
		case "knowledge/register":
			return await context.replayMutation(request, () => context.knowledge.register(request.params.path));
		case "knowledge/remove":
			return await context.replayMutation(request, async () => context.knowledge.remove(request.params.libraryId));
		case "knowledge/scan":
			return await context.knowledge.scan(request.params.libraryId);
		case "knowledge/read":
			return await context.knowledge.read(request.params.libraryId, request.params.path);
		case "knowledge/resource/resolve":
			return await context.knowledge.resolve(
				request.params.libraryId,
				request.params.sourcePath,
				request.params.reference,
				request.params.kind,
			);
		default:
			throw new Error(`Unhandled knowledge request: ${request.method}`);
	}
}
