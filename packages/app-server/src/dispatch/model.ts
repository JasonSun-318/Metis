import type { ClientRpcRequest } from "@metis/app-protocol";
import type { ModelRegistry } from "@metis/coding-agent/host";
import type { ModelSettingsService } from "../model-settings.ts";
import type { SessionRegistry } from "../session-registry.ts";

export interface ModelDispatchContext {
	readonly modelRegistry: ModelRegistry;
	readonly modelSettings: ModelSettingsService;
	readonly registry: SessionRegistry;
	dropRuntimeSubscriptions(sessionIds: readonly string[]): void;
	mutateModelServiceSettings<T>(mutate: () => Promise<T>): Promise<T>;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isModelRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("model/");
}

export async function dispatchModelRequest(request: ClientRpcRequest, context: ModelDispatchContext): Promise<unknown> {
	switch (request.method) {
		case "model/list":
			context.modelRegistry.refresh();
			return {
				models: context.modelRegistry
					.getAvailable()
					.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }))
					.sort(
						(left, right) => left.name.localeCompare(right.name) || left.provider.localeCompare(right.provider),
					),
			};
		case "model/settings/get":
			return context.modelSettings.view();
		case "model/settings/update":
			return await context.replayMutation(request, () =>
				context.mutateModelServiceSettings(async () => {
					const result = await context.modelSettings.update(request.params.mutation);
					if (request.params.mutation.type === "set_permission_reviewer") {
						context.dropRuntimeSubscriptions(await context.registry.refreshOpenPermissionAutoSettings());
					}
					return result;
				}),
			);
		case "model/testConnection":
			return await context.replayMutation(request, () => context.modelSettings.testConnection(request.params));
		case "model/discover":
			return await context.modelSettings.discover(request.params);
		default:
			throw new Error(`Unhandled model request: ${request.method}`);
	}
}
