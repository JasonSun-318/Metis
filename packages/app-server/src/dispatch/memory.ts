import type { ClientRpcRequest } from "@metis/app-protocol";
import type { MemoryService } from "../memory-settings.ts";
import type { SessionRegistry } from "../session-registry.ts";

export interface MemoryDispatchContext {
	readonly memorySettings: MemoryService;
	readonly registry: SessionRegistry;
	dropRuntimeSubscriptions(sessionIds: readonly string[]): void;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isMemoryRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("memory/");
}

export async function dispatchMemoryRequest(
	request: ClientRpcRequest,
	context: MemoryDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "memory/get":
			return context.memorySettings.view(request.params);
		case "memory/update":
			return await context.replayMutation(request, async () => {
				// Share the settings mutation lock so open sessions cannot run with
				// a half-applied tool set; failed refreshes close the session.
				const release = await context.registry.beginModelServiceSettingsRefresh();
				try {
					const result = await context.memorySettings.update(request.params);
					context.dropRuntimeSubscriptions(await context.registry.refreshOpenMemorySettings());
					return result;
				} finally {
					release();
				}
			});
		case "memory/notes/list":
			return context.memorySettings.listNotes(request.params);
		case "memory/notes/read":
			return context.memorySettings.readNote(request.params);
		case "memory/notes/write":
			return await context.replayMutation(request, () => context.memorySettings.writeNote(request.params));
		case "memory/history/list":
			return context.memorySettings.history(request.params);
		case "memory/history/read":
			return context.memorySettings.historyRead(request.params);
		case "memory/undo":
			return await context.replayMutation(request, () => context.memorySettings.undo(request.params));
		case "memory/undoRun":
			return await context.replayMutation(request, () => context.memorySettings.undoRun(request.params));
		case "memory/dream/run":
			return await context.memorySettings.dreamRun(request.params);
		default:
			throw new Error(`Unhandled memory request: ${request.method}`);
	}
}
