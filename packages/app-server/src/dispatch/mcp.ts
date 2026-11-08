import type { ClientRpcRequest } from "@metis/app-protocol";
import type { SessionRegistry } from "../session-registry.ts";
import type { SessionRef } from "../session-runtime-host.ts";

export interface McpDispatchContext {
	readonly registry: SessionRegistry;
	runtimeRef(sessionId: string): SessionRef;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isMcpRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("mcp/");
}

export async function dispatchMcpRequest(request: ClientRpcRequest, context: McpDispatchContext): Promise<unknown> {
	switch (request.method) {
		case "mcp/list":
			if ("sessionId" in request.params) {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.listMcpServers());
			}
			return await context.registry.listDraftMcpServers(request.params.cwd);
		case "mcp/import/inspect":
			if ("sessionId" in request.params) {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.inspectMcpImport(request.params));
			}
			return await context.registry.inspectDraftMcpImport(request.params);
		case "mcp/import":
			return await context.replayMutation(request, async () => {
				if ("sessionId" in request.params) {
					const ref = context.runtimeRef(request.params.sessionId);
					return await context.registry.run(ref, (runtime) => runtime.importMcpServers(request.params));
				}
				return await context.registry.importDraftMcpServers(request.params);
			});
		case "mcp/get":
			if ("sessionId" in request.params) {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.getMcpServer(request.params));
			}
			return await context.registry.getDraftMcpServer(request.params);
		case "mcp/catalog/get": {
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.getMcpCatalogItem(request.params));
		}
		case "mcp/upsert":
			return await context.replayMutation(request, async () => {
				if ("sessionId" in request.params) {
					const ref = context.runtimeRef(request.params.sessionId);
					return await context.registry.run(ref, (runtime) => runtime.upsertMcpServer(request.params));
				}
				return await context.registry.upsertDraftMcpServer(request.params);
			});
		case "mcp/remove":
			return await context.replayMutation(request, async () => {
				if ("sessionId" in request.params) {
					const ref = context.runtimeRef(request.params.sessionId);
					return await context.registry.run(ref, (runtime) => runtime.removeMcpServer(request.params));
				}
				return await context.registry.removeDraftMcpServer(request.params);
			});
		case "mcp/restart":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.restartMcpServer(request.params));
			});
		case "mcp/credential/set":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.setMcpCredential(request.params));
			});
		case "mcp/credential/clear":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.clearMcpCredential(request.params));
			});
		default:
			throw new Error(`Unhandled MCP request: ${request.method}`);
	}
}
