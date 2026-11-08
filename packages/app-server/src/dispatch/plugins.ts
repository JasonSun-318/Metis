import type { ClientRpcRequest } from "@metis/app-protocol";
import { type PluginSnapshot, readPluginSnapshot } from "@metis/coding-agent/host";
import type { PluginActivationStatus, PluginInstalledView, PluginService } from "../plugins.ts";
import type { SessionRegistry } from "../session-registry.ts";

interface PluginRuntimeError {
	readonly componentId: string;
	readonly message: string;
}

interface PluginActivationState {
	readonly activation: PluginActivationStatus;
	readonly runtimeErrors: PluginRuntimeError[];
}

export interface PluginsDispatchContext {
	readonly plugins: PluginService;
	readonly registry: SessionRegistry;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isPluginsRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("plugin/");
}

async function getPluginActivationState(
	context: PluginsDispatchContext,
	pluginId?: string,
): Promise<PluginActivationState> {
	const statuses = await context.registry.pluginRuntimeStatuses();
	let snapshot: PluginSnapshot;
	try {
		snapshot = readPluginSnapshot(context.plugins.agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			activation: "failed",
			runtimeErrors: [{ componentId: "snapshot", message }],
		};
	}
	const runtimeErrors: PluginRuntimeError[] = [];
	for (const status of statuses) {
		if (status.error) {
			runtimeErrors.push({ componentId: status.sessionId, message: status.error });
		}
	}
	for (const diagnostic of snapshot.diagnostics ?? []) {
		if (
			(diagnostic.code !== "PACKAGE_MISSING" && diagnostic.code !== "PACKAGE_CORRUPTED") ||
			(pluginId !== undefined && diagnostic.componentId !== pluginId)
		) {
			continue;
		}
		runtimeErrors.push({ componentId: diagnostic.componentId, message: diagnostic.message });
	}
	const activation: PluginActivationStatus =
		runtimeErrors.length > 0
			? "failed"
			: statuses.length === 0
				? "not-running"
				: statuses.every((status) => status.appliedFingerprint === snapshot.fingerprint)
					? "applied"
					: "next-turn";

	return { activation, runtimeErrors };
}

function withPluginActivationState<T extends { plugin: PluginInstalledView; activation: PluginActivationStatus }>(
	result: T,
	state: PluginActivationState,
): T {
	const runtimeErrors = [
		...state.runtimeErrors,
		...result.plugin.runtimeErrors.filter(
			(error) => !state.runtimeErrors.some((existing) => existing.componentId === error.componentId),
		),
	];
	const activation = result.plugin.activation === "failed" ? "failed" : state.activation;
	return { ...result, activation, plugin: { ...result.plugin, activation, runtimeErrors } };
}

export async function dispatchPluginsRequest(
	request: ClientRpcRequest,
	context: PluginsDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "plugin/market/list":
			return context.plugins.listMarkets();
		case "plugin/market/add":
			return await context.replayMutation(request, async () => context.plugins.addMarket(request.params));
		case "plugin/market/select":
			return await context.replayMutation(request, async () => context.plugins.selectMarket(request.params));
		case "plugin/market/remove":
			return await context.replayMutation(request, async () => context.plugins.removeMarket(request.params));
		case "plugin/market/refresh":
			return await context.plugins.refreshMarket(request.params);
		case "plugin/catalog":
			return await context.plugins.getCatalog(request.params.sourceId);
		case "plugin/inspect":
			return await context.plugins.inspectPlugin(request.params.sourceId, request.params.entryId);
		case "plugin/install":
			return await context.replayMutation(request, async () => {
				const res = await context.plugins.install(request.params);
				const state = await getPluginActivationState(context, res.plugin.plugin.id);
				return withPluginActivationState(res, state);
			});
		case "plugin/list":
			return context.plugins.listInstalled();
		case "plugin/get": {
			const { activation, runtimeErrors } = await getPluginActivationState(context, request.params.pluginId);
			return context.plugins.getInstalled(request.params.pluginId, activation, runtimeErrors);
		}
		case "plugin/setEnabled":
			return await context.replayMutation(request, async () => {
				const res = context.plugins.setEnabled(request.params);
				const state = await getPluginActivationState(context, res.plugin.plugin.id);
				return withPluginActivationState(res, state);
			});
		case "plugin/remove":
			return await context.replayMutation(request, async () => {
				const res = context.plugins.remove(request.params);
				const { activation } = await getPluginActivationState(context);
				return { ...res, activation };
			});
		case "plugin/update/inspect":
			return await context.plugins.inspectUpdate(request.params.pluginId);
		case "plugin/update":
			return await context.replayMutation(request, async () => {
				const res = await context.plugins.update(request.params);
				const state = await getPluginActivationState(context, res.plugin.plugin.id);
				return withPluginActivationState(res, state);
			});
		default:
			throw new Error(`Unhandled plugin request: ${request.method}`);
	}
}
