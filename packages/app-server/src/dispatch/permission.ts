import type { ClientRpcRequest } from "@metis/app-protocol";
import type { PermissionAutoSettingsService } from "../permission-auto-settings.ts";
import type { PermissionRulesService } from "../permission-rules.ts";
import { readPermissionSandboxHealth, runPermissionSandboxSelfTest } from "../permission-sandbox-health.ts";
import type { SessionRegistry } from "../session-registry.ts";

export interface PermissionDispatchContext {
	readonly permissionRules: PermissionRulesService;
	readonly permissionAutoSettings: PermissionAutoSettingsService;
	readonly registry: SessionRegistry;
	mutatePermissionAutoSettings<T>(mutate: () => Promise<T>): Promise<T>;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isPermissionRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("permission/");
}

export async function dispatchPermissionRequest(
	request: ClientRpcRequest,
	context: PermissionDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "permission/sandbox/health":
			return await readPermissionSandboxHealth();
		case "permission/sandbox/selfTest":
			return await runPermissionSandboxSelfTest();
		case "permission/auto/get":
			return await context.permissionAutoSettings.read();
		case "permission/auto/update":
			return await context.replayMutation(request, () =>
				context.mutatePermissionAutoSettings(() => context.permissionAutoSettings.update(request.params)),
			);
		case "permission/rules/list": {
			const result = await context.permissionRules.list(request.params, context.registry);
			if (result.scope !== "project") return result;
			const opened = await context.registry.withOpenRuntime(request.params.sessionId, async (runtime) =>
				runtime.getPermissionScopePreview?.(),
			);
			return opened.open && opened.result ? { ...result, scopePreview: opened.result } : result;
		}
		case "permission/rules/catalog":
			return await context.permissionRules.listRemembered(context.registry);
		case "permission/rules/revoke":
			return await context.replayMutation(request, async () => {
				const result = await context.permissionRules.revokeRemembered(request.params, context.registry);
				if (request.params.scope === "session") {
					await context.registry.notifySessionPermissionRulesChanged(request.params.sessionId);
				} else {
					await context.registry.notifyOpenPermissionRulesChanged();
				}
				return result;
			});
		case "permission/rules/delete":
			return await context.replayMutation(request, async () => {
				const result = await context.permissionRules.delete(request.params, context.registry);
				if (result.scope === "session") {
					await context.registry.notifySessionPermissionRulesChanged(request.params.sessionId);
				} else {
					await context.registry.notifyOpenPermissionRulesChanged();
				}
				return result;
			});
		case "permission/rules/clear":
			return await context.replayMutation(request, async () => {
				const result = await context.permissionRules.clear(request.params, context.registry);
				if (result.scope === "session") {
					await context.registry.notifySessionPermissionRulesChanged(request.params.sessionId);
				} else {
					await context.registry.notifyOpenPermissionRulesChanged();
				}
				return result;
			});
		default:
			throw new Error(`Unhandled permission request: ${request.method}`);
	}
}
