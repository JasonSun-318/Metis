import type { ClientRpcRequest } from "@metis/app-protocol";
import type { PersonalizationService } from "../personalization.ts";

export interface PersonalizationDispatchContext {
	readonly personalization: PersonalizationService;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isPersonalizationRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("personalization/");
}

export async function dispatchPersonalizationRequest(
	request: ClientRpcRequest,
	context: PersonalizationDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "personalization/get":
			return context.personalization.view();
		case "personalization/update":
			return await context.replayMutation(request, async () => context.personalization.update(request.params));
		default:
			throw new Error(`Unhandled personalization request: ${request.method}`);
	}
}
