import type { ClientRpcRequest } from "@metis/app-protocol";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionRef } from "../session-runtime-host.ts";

export interface SkillsDispatchContext {
	readonly registry: SessionRegistry;
	runtimeRef(sessionId: string): SessionRef;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isSkillsRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("skill/");
}

export async function dispatchSkillsRequest(
	request: ClientRpcRequest,
	context: SkillsDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "skill/list":
			if ("sessionId" in request.params) {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.listSkills());
			}
			return await context.registry.listDraftSkills(request.params.cwd);
		case "skill/get":
			return await context.registry.getDraftSkill(request.params);
		case "skill/upsert":
			return await context.replayMutation(request, () => context.registry.upsertDraftSkill(request.params));
		case "skill/remove":
			return await context.replayMutation(request, () => context.registry.removeDraftSkill(request.params));
		case "skill/import/inspect":
			return await context.registry.inspectDraftSkillImport(request.params);
		case "skill/import":
			return await context.replayMutation(request, () => context.registry.importDraftSkills(request.params));
		default:
			throw new Error(`Unhandled skill request: ${request.method}`);
	}
}
