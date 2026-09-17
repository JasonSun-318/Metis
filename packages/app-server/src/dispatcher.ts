import { createHash } from "node:crypto";
import { type ClientParams, type ClientRpcRequest, MAX_HISTORY_ITEMS } from "@metis/app-protocol";
import {
	type ModelRegistry,
	type PluginSnapshot,
	readPluginSnapshot,
	resolveScheduleCreateTarget,
	type ScheduleCreateTarget,
	ScheduleError,
	type ScheduleManager,
	SessionManager,
} from "@metis/coding-agent/host";
import type { DurableSessionMutation, PreparedSessionMutation } from "./durable-mutation.ts";
import type { HooksService } from "./hooks.ts";
import type { InteractionBroker, InteractionPeer } from "./interactions.ts";
import type { MemoryService } from "./memory-settings.ts";
import type { ModelSettingsService } from "./model-settings.ts";
import type { PermissionAutoSettingsService } from "./permission-auto-settings.ts";
import type { PermissionRulesService } from "./permission-rules.ts";
import type { PersonalizationService } from "./personalization.ts";
import type { PluginActivationStatus, PluginInstalledView, PluginService } from "./plugins.ts";
import { ProfileSummaryCache } from "./profile-summary.ts";
import { scheduleRunView, scheduleTaskView } from "./schedule-projection.ts";
import type { SessionCatalog } from "./session-catalog.ts";
import type { SessionRegistry } from "./session-registry.ts";
import { AppServerError, type SessionRef } from "./session-runtime-host.ts";
import type { SessionTitleGenerator } from "./session-title-generator.ts";
import type { ConnectionSubscriptions, SessionSubscriptions } from "./subscriptions.ts";
import type { WebSearchService } from "./web-search.ts";

const MAX_REPLAY_ENTRIES = 10_000;

export interface ConnectionState {
	readonly subscriptions: ConnectionSubscriptions;
	readonly interactionPeer: InteractionPeer;
}

interface ReplayEntry {
	readonly fingerprint: string;
	readonly result: Promise<unknown>;
	settled: boolean;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function fingerprint(request: ClientRpcRequest): string {
	return createHash("sha256").update(request.method).update("\0").update(canonicalJson(request.params)).digest("hex");
}

function requestId(request: ClientRpcRequest): string | undefined {
	return "requestId" in request.params ? request.params.requestId : undefined;
}

function replayKey(request: ClientRpcRequest, id: string): string {
	if (request.method === "session/create") return `create\0${id}`;
	const sessionId = "sessionId" in request.params ? request.params.sessionId : undefined;
	return sessionId === undefined ? `global\0${id}` : `session\0${sessionId}\0${id}`;
}

function forkedSessionId(sourceSessionId: string, requestId: string): string {
	const digest = createHash("sha256").update(sourceSessionId).update("\0").update(requestId).digest("hex");
	return `fork-${digest}`;
}

function validatePersistedFork(
	ref: SessionRef,
	input: { readonly requestId: string; readonly sessionId: string; readonly entryId: string },
): void {
	const manager = SessionManager.openReadOnly(ref.path);
	const markers = manager.getDurableJournalSnapshot().filter((raw) => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
		const entry = raw as unknown as Record<string, unknown>;
		if (entry.type !== "custom" || entry.customType !== "metis.app-server.session-fork.v1") return false;
		const data = entry.data as Record<string, unknown> | undefined;
		return (
			data?.requestId === input.requestId &&
			data.sourceSessionId === input.sessionId &&
			data.entryId === input.entryId
		);
	});
	if (markers.length !== 1) throw new AppServerError("REQUEST_ID_REUSED", { requestId: input.requestId });
}

type PluginRuntimeError = { readonly componentId: string; readonly message: string };

interface PluginActivationState {
	readonly activation: PluginActivationStatus;
	readonly runtimeErrors: PluginRuntimeError[];
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

export class Dispatcher {
	private readonly replay = new Map<string, ReplayEntry>();
	private readonly catalog: SessionCatalog;
	private readonly registry: SessionRegistry;
	private readonly subscriptionHub: SessionSubscriptions;
	private readonly interactions: InteractionBroker;
	private readonly scheduleManager: ScheduleManager;
	private readonly modelRegistry: ModelRegistry;
	private readonly modelSettings: ModelSettingsService;
	private readonly personalization: PersonalizationService;
	private readonly permissionRules: PermissionRulesService;
	private readonly permissionAutoSettings: PermissionAutoSettingsService;
	private readonly webSearch: WebSearchService;
	private readonly memorySettings: MemoryService;
	private readonly hooks: HooksService;
	private readonly plugins: PluginService;
	private readonly titleGenerator: SessionTitleGenerator;
	private readonly titleJobs = new Set<string>();
	private readonly profileSummary = new ProfileSummaryCache();

	constructor(
		catalog: SessionCatalog,
		registry: SessionRegistry,
		subscriptionHub: SessionSubscriptions,
		interactions: InteractionBroker,
		scheduleManager: ScheduleManager,
		modelRegistry: ModelRegistry,
		modelSettings: ModelSettingsService,
		personalization: PersonalizationService,
		permissionRules: PermissionRulesService,
		permissionAutoSettings: PermissionAutoSettingsService,
		webSearch: WebSearchService,
		memorySettings: MemoryService,
		hooks: HooksService,
		plugins: PluginService,
		titleGenerator: SessionTitleGenerator,
	) {
		this.catalog = catalog;
		this.registry = registry;
		this.subscriptionHub = subscriptionHub;
		this.interactions = interactions;
		this.scheduleManager = scheduleManager;
		this.modelRegistry = modelRegistry;
		this.modelSettings = modelSettings;
		this.personalization = personalization;
		this.permissionRules = permissionRules;
		this.permissionAutoSettings = permissionAutoSettings;
		this.webSearch = webSearch;
		this.memorySettings = memorySettings;
		this.hooks = hooks;
		this.plugins = plugins;
		this.titleGenerator = titleGenerator;
	}

	private dropRuntimeSubscriptions(sessionIds: readonly string[]): void {
		for (const sessionId of sessionIds) this.subscriptionHub.removeSession(sessionId);
	}

	private async mutateModelServiceSettings<T>(mutate: () => Promise<T>): Promise<T> {
		const release = await this.registry.beginModelServiceSettingsRefresh();
		try {
			this.dropRuntimeSubscriptions(await this.registry.prepareOpenModelServiceSettingsRefresh());
			try {
				const result = await mutate();
				this.dropRuntimeSubscriptions(await this.registry.applyOpenModelServiceSettingsRefresh());
				return result;
			} catch (error) {
				this.dropRuntimeSubscriptions(await this.registry.applyOpenModelServiceSettingsRefresh());
				throw error;
			}
		} finally {
			release();
		}
	}

	private async mutatePermissionAutoSettings<T>(mutate: () => Promise<T>): Promise<T> {
		const release = await this.registry.beginModelServiceSettingsRefresh();
		try {
			const result = await mutate();
			this.dropRuntimeSubscriptions(await this.registry.refreshOpenPermissionAutoSettings());
			return result;
		} finally {
			release();
		}
	}

	private startTitleJob(sessionId: string, input: ClientParams<"turn/start">): void {
		if (this.titleJobs.has(sessionId)) return;
		const source = [
			input.text.trim(),
			...(input.attachments ?? []).map(
				(attachment) => `Attachment: ${attachment.name ?? attachment.path.split(/[\\/]/).at(-1)}`,
			),
			...(!input.text.trim() && input.images?.length
				? [`${input.images.length} image${input.images.length === 1 ? "" : "s"}`]
				: []),
		]
			.filter(Boolean)
			.join("\n");
		if (!source) return;
		this.titleJobs.add(sessionId);
		void this.titleGenerator
			.generate(source)
			.then(async (title) => {
				if (!title) return;
				const ref = this.runtimeRef(sessionId);
				const updated = await this.registry.run(ref, async (runtime) => {
					if (runtime.getSummary().name) return undefined;
					return await runtime.renameSession(title);
				});
				if (!updated || this.catalog.get(sessionId).summary.name === updated.name) return;
				const session = this.catalog.updateSummary(sessionId, updated);
				this.subscriptionHub.publishSessionUpdated(session);
			})
			.catch(() => undefined)
			.finally(() => this.titleJobs.delete(sessionId));
	}

	private availableModel(model: { provider: string; modelId: string }): void {
		this.modelRegistry.refresh();
		const found = this.modelRegistry.find(model.provider, model.modelId);
		if (!found || !this.modelRegistry.hasConfiguredAuth(found)) {
			throw new ScheduleError(
				"MODEL_UNAVAILABLE",
				`Configured model is unavailable: ${model.provider}/${model.modelId}`,
			);
		}
	}

	private scheduleTarget(
		sourceSessionId?: string,
		additionalWorkspaceCwd?: string,
	): {
		target: ScheduleCreateTarget;
	} {
		if (!sourceSessionId) {
			return {
				target: {
					kind: "general",
					workspace: "task",
					...(additionalWorkspaceCwd === undefined ? {} : { additionalWorkspaceCwd }),
				},
			};
		}
		if (additionalWorkspaceCwd !== undefined) throw new AppServerError("INVALID_REQUEST");
		const ref = this.catalog.get(sourceSessionId);
		if (ref.scheduled || ref.summary.archived || ref.summary.state === "corrupt" || !ref.summary.cwd) {
			throw new AppServerError("NOT_FOUND", { sessionId: sourceSessionId });
		}
		const target = resolveScheduleCreateTarget({
			mode: ref.summary.mode,
			cwdOrigin: ref.summary.cwdOrigin,
			cwd: ref.summary.cwd,
		});
		if (!target)
			throw new AppServerError("INVALID_REQUEST", {
				sessionId: sourceSessionId,
			});
		return { target };
	}

	private async scheduleSnapshot(cursor: number) {
		const page = await this.scheduleManager.list({ limit: 200 });
		return {
			serverEpoch: this.subscriptionHub.serverEpoch,
			tasks: page.tasks.map(scheduleTaskView),
			unreadCount: this.scheduleManager.unreadCount(),
			cursor,
		};
	}

	async reconcileScheduledTaskSessions(taskId: string): Promise<void> {
		const previous = this.catalog.scheduledSessionIds(taskId);
		await this.catalog.refresh();
		const retained = new Set(this.catalog.scheduledSessionIds(taskId));
		for (const sessionId of previous) {
			if (retained.has(sessionId)) continue;
			this.subscriptionHub.removeSession(sessionId, {
				type: "session/invalidated",
				sessionId,
				reason: "deleted",
			});
			await this.registry.close(sessionId);
		}
	}

	private async closeScheduledTaskSessions(taskId: string): Promise<void> {
		for (const sessionId of this.catalog.scheduledSessionIds(taskId)) {
			this.subscriptionHub.removeSession(sessionId);
			if (this.registry.has(sessionId)) await this.registry.close(sessionId);
		}
	}

	private runtimeRef(sessionId: string): SessionRef {
		const ref = this.catalog.get(sessionId);
		if (ref.summary.archived) throw new AppServerError("NOT_FOUND", { sessionId });
		if (ref.summary.state === "corrupt") throw new AppServerError("SESSION_CORRUPT", { sessionId });
		return ref;
	}

	private allSessionRefs(): SessionRef[] {
		const refs: SessionRef[] = [];
		let afterSessionId: string | null = null;
		do {
			const page = this.catalog.list({ includeArchived: true, afterSessionId, limit: MAX_HISTORY_ITEMS });
			for (const session of page.sessions) refs.push(this.catalog.get(session.sessionId));
			afterSessionId = page.nextAfterSessionId;
		} while (afterSessionId !== null);
		return refs;
	}

	private async hydrateScheduledSession(sessionId: string): Promise<SessionRef> {
		const ref = this.catalog.get(sessionId);
		if (!ref.scheduled) return ref;
		try {
			const run = await this.scheduleManager.getRun(ref.scheduled.taskId, ref.scheduled.runId);
			await this.catalog.registerScheduledRun(run);
		} catch (error) {
			if (!(error instanceof ScheduleError) || !["SCHEDULE_NOT_FOUND", "RUN_NOT_FOUND"].includes(error.code)) {
				throw error;
			}
		}
		return this.catalog.get(sessionId);
	}

	private assertMutableSession(sessionId: string): void {
		if (this.catalog.get(sessionId).scheduled) throw new AppServerError("READ_ONLY_SESSION", { sessionId });
	}

	private async allowRetainedScheduledDelete(sessionId: string): Promise<boolean> {
		const scheduled = this.catalog.get(sessionId).scheduled;
		if (!scheduled) return false;
		try {
			await this.scheduleManager.get(scheduled.taskId);
		} catch (error) {
			if (error instanceof ScheduleError && error.code === "SCHEDULE_NOT_FOUND") return true;
			throw error;
		}
		throw new AppServerError("READ_ONLY_SESSION", { sessionId });
	}

	private replayMutation(request: ClientRpcRequest, operation: () => Promise<unknown>): Promise<unknown> {
		const id = requestId(request);
		if (!id) return operation();
		const key = replayKey(request, id);
		const digest = fingerprint(request);
		const existing = this.replay.get(key);
		if (existing) {
			if (existing.fingerprint !== digest) throw new AppServerError("REQUEST_ID_REUSED", { requestId: id });
			return existing.result;
		}

		if (this.replay.size >= MAX_REPLAY_ENTRIES) {
			const evictable = [...this.replay].find(([, entry]) => entry.settled);
			if (!evictable) throw new AppServerError("OVERLOADED", { requestId: id });
			this.replay.delete(evictable[0]);
		}
		const entry: ReplayEntry = {
			fingerprint: digest,
			result: Promise.resolve().then(operation),
			settled: false,
		};
		this.replay.set(key, entry);
		void entry.result.then(
			() => {
				entry.settled = true;
			},
			() => {
				entry.settled = true;
			},
		);
		return entry.result;
	}

	private async deleteModeProject(request: Extract<ClientRpcRequest, { method: "project/delete" }>): Promise<unknown> {
		let invalidation: { mode: "chat" | "code"; cwd: string; reason: "deleted" | "reload_required" } | undefined;
		const publishInvalidation = () => {
			const event = invalidation;
			invalidation = undefined;
			if (event) this.subscriptionHub.invalidateProject({ type: "project/invalidated", ...event });
		};
		try {
			const result = await this.replayMutation(request, () =>
				this.catalog.withModeProjectBlocked(request.params, async (snapshot) => {
					const deleteSessions = async () => {
						let quiesced = false;
						try {
							return await this.registry.withSessionsQuiesced(
								snapshot.refs.map((ref) => ref.summary.sessionId),
								async () => {
									quiesced = true;
									const result = await SessionManager.trashModeProjectData({
										agentDir: this.catalog.agentDir,
										sessionsRoot: this.catalog.sessionsRoot,
										mode: snapshot.mode,
										cwd: snapshot.cwd,
										sessions: snapshot.refs.map((ref) => ({
											sessionId: ref.summary.sessionId,
											path: ref.path,
											relativePath: ref.relativePath,
											archived: ref.summary.archived,
											updatedAt: ref.storageUpdatedAt ?? ref.summary.updatedAt,
										})),
									});
									if (!result.ok) {
										if (result.code === "PROJECT_CHANGED") {
											throw new AppServerError("BUSY");
										}
										if (result.code === "SESSION_IN_USE") throw new AppServerError("SESSION_IN_USE");
										if (result.code === "SESSION_CORRUPT") throw new AppServerError("SESSION_CORRUPT");
										console.error(`project/delete failed for ${snapshot.cwd}: ${result.error}`);
										throw new AppServerError("OPERATION_FAILED");
									}
									for (const ref of snapshot.refs) {
										this.subscriptionHub.removeSession(ref.summary.sessionId);
									}
									invalidation = { mode: snapshot.mode, cwd: snapshot.cwd, reason: "deleted" };
									return {
										mode: snapshot.mode,
										cwd: snapshot.cwd,
										deletedSessionCount: result.deletedSessionCount,
									};
								},
								() => {
									for (const ref of snapshot.refs) {
										this.interactions.releaseSession(ref.summary.sessionId);
									}
								},
							);
						} catch (error) {
							if (quiesced) {
								for (const ref of snapshot.refs) {
									this.subscriptionHub.removeSession(ref.summary.sessionId);
								}
								invalidation = { mode: snapshot.mode, cwd: snapshot.cwd, reason: "reload_required" };
							}
							throw error;
						}
					};
					return snapshot.mode === "chat"
						? this.scheduleManager.withNoFixedWorkspaceTasks(snapshot.cwd, deleteSessions)
						: deleteSessions();
				}),
			);
			publishInvalidation();
			return result;
		} catch (error) {
			publishInvalidation();
			throw error;
		}
	}

	private async getPluginActivationState(pluginId?: string): Promise<PluginActivationState> {
		const statuses = await this.registry.pluginRuntimeStatuses();
		let snapshot: PluginSnapshot;
		try {
			snapshot = readPluginSnapshot(this.plugins.agentDir);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				activation: "failed",
				runtimeErrors: [{ componentId: "snapshot", message }],
			};
		}
		const runtimeErrors: PluginRuntimeError[] = [];
		for (const s of statuses) {
			if (s.error) {
				runtimeErrors.push({ componentId: s.sessionId, message: s.error });
			}
		}
		for (const diagnostic of snapshot.diagnostics ?? []) {
			if (
				(diagnostic.code !== "PACKAGE_MISSING" && diagnostic.code !== "PACKAGE_CORRUPTED") ||
				(pluginId !== undefined && diagnostic.componentId !== pluginId)
			)
				continue;
			runtimeErrors.push({ componentId: diagnostic.componentId, message: diagnostic.message });
		}
		const activation: PluginActivationStatus =
			runtimeErrors.length > 0
				? "failed"
				: statuses.length === 0
					? "not-running"
					: statuses.every((s) => s.appliedFingerprint === snapshot.fingerprint)
						? "applied"
						: "next-turn";

		return { activation, runtimeErrors };
	}

	async dispatch(request: ClientRpcRequest, connection: ConnectionState): Promise<unknown> {
		switch (request.method) {
			case "initialize":
				throw new AppServerError("INVALID_REQUEST");
			case "session/list": {
				const page = this.catalog.list(request.params);
				return {
					...page,
					sessions: await Promise.all(
						page.sessions.map(async (session) => {
							try {
								return (await this.hydrateScheduledSession(session.sessionId)).summary;
							} catch {
								return session;
							}
						}),
					),
				};
			}
			case "skill/list":
				if ("sessionId" in request.params) {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.listSkills());
				}
				return await this.registry.listDraftSkills(request.params.cwd);
			case "skill/get":
				return await this.registry.getDraftSkill(request.params);
			case "skill/upsert":
				return await this.replayMutation(request, () => this.registry.upsertDraftSkill(request.params));
			case "skill/remove":
				return await this.replayMutation(request, () => this.registry.removeDraftSkill(request.params));
			case "skill/import/inspect":
				return await this.registry.inspectDraftSkillImport(request.params);
			case "skill/import":
				return await this.replayMutation(request, () => this.registry.importDraftSkills(request.params));
			case "mcp/list":
				if ("sessionId" in request.params) {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.listMcpServers());
				}
				return await this.registry.listDraftMcpServers(request.params.cwd);
			case "mcp/import/inspect":
				if ("sessionId" in request.params) {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.inspectMcpImport(request.params));
				}
				return await this.registry.inspectDraftMcpImport(request.params);
			case "mcp/import":
				return await this.replayMutation(request, async () => {
					if ("sessionId" in request.params) {
						const ref = this.runtimeRef(request.params.sessionId);
						return await this.registry.run(ref, (runtime) => runtime.importMcpServers(request.params));
					}
					return await this.registry.importDraftMcpServers(request.params);
				});
			case "mcp/get":
				if ("sessionId" in request.params) {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.getMcpServer(request.params));
				}
				return await this.registry.getDraftMcpServer(request.params);
			case "mcp/catalog/get": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.getMcpCatalogItem(request.params));
			}
			case "mcp/upsert":
				return await this.replayMutation(request, async () => {
					if ("sessionId" in request.params) {
						const ref = this.runtimeRef(request.params.sessionId);
						return await this.registry.run(ref, (runtime) => runtime.upsertMcpServer(request.params));
					}
					return await this.registry.upsertDraftMcpServer(request.params);
				});
			case "mcp/remove":
				return await this.replayMutation(request, async () => {
					if ("sessionId" in request.params) {
						const ref = this.runtimeRef(request.params.sessionId);
						return await this.registry.run(ref, (runtime) => runtime.removeMcpServer(request.params));
					}
					return await this.registry.removeDraftMcpServer(request.params);
				});
			case "mcp/restart":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.restartMcpServer(request.params));
				});
			case "mcp/credential/set":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setMcpCredential(request.params));
				});
			case "mcp/credential/clear":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.clearMcpCredential(request.params));
				});
			case "profile/get":
				return this.profileSummary.summarize(this.allSessionRefs());
			case "personalization/get":
				return this.personalization.view();
			case "personalization/update":
				return await this.replayMutation(request, async () => this.personalization.update(request.params));
			case "webSearch/get":
				return this.webSearch.view();
			case "webSearch/credential/reveal":
				return this.webSearch.reveal(request.params);
			case "webSearch/update":
				return await this.replayMutation(request, async () => {
					const result = await this.webSearch.update(request.params);
					await this.registry.refreshOpenWebSearchSettings();
					return result;
				});
			case "memory/get":
				return this.memorySettings.view(request.params);
			case "memory/update":
				return await this.replayMutation(request, () => this.memorySettings.update(request.params));
			case "memory/notes/list":
				return this.memorySettings.listNotes(request.params);
			case "memory/notes/read":
				return this.memorySettings.readNote(request.params);
			case "memory/notes/write":
				return await this.replayMutation(request, () => this.memorySettings.writeNote(request.params));
			case "memory/history/list":
				return this.memorySettings.history(request.params);
			case "memory/history/read":
				return this.memorySettings.historyRead(request.params);
			case "memory/undo":
				return await this.replayMutation(request, () => this.memorySettings.undo(request.params));
			case "memory/undoRun":
				return await this.replayMutation(request, () => this.memorySettings.undoRun(request.params));
			case "memory/dream/run":
				return await this.memorySettings.dreamRun(request.params);
			case "hooks/list":
				return this.hooks.view();
			case "hooks/upsert":
				return await this.replayMutation(request, async () => this.hooks.upsert(request.params));
			case "hooks/delete":
				return await this.replayMutation(request, async () => this.hooks.delete(request.params));
			case "plugin/market/list":
				return this.plugins.listMarkets();
			case "plugin/market/add":
				return await this.replayMutation(request, async () => this.plugins.addMarket(request.params));
			case "plugin/market/select":
				return await this.replayMutation(request, async () => this.plugins.selectMarket(request.params));
			case "plugin/market/remove":
				return await this.replayMutation(request, async () => this.plugins.removeMarket(request.params));
			case "plugin/market/refresh":
				return await this.plugins.refreshMarket(request.params);
			case "plugin/catalog":
				return await this.plugins.getCatalog(request.params.sourceId);
			case "plugin/inspect":
				return await this.plugins.inspectPlugin(request.params.sourceId, request.params.entryId);
			case "plugin/install":
				return await this.replayMutation(request, async () => {
					const res = await this.plugins.install(request.params);
					const state = await this.getPluginActivationState(res.plugin.plugin.id);
					return withPluginActivationState(res, state);
				});
			case "plugin/list":
				return this.plugins.listInstalled();
			case "plugin/get": {
				const { activation, runtimeErrors } = await this.getPluginActivationState(request.params.pluginId);
				return this.plugins.getInstalled(request.params.pluginId, activation, runtimeErrors);
			}
			case "plugin/setEnabled":
				return await this.replayMutation(request, async () => {
					const res = this.plugins.setEnabled(request.params);
					const state = await this.getPluginActivationState(res.plugin.plugin.id);
					return withPluginActivationState(res, state);
				});
			case "plugin/remove":
				return await this.replayMutation(request, async () => {
					const res = this.plugins.remove(request.params);
					const { activation } = await this.getPluginActivationState();
					return { ...res, activation };
				});
			case "plugin/update/inspect":
				return await this.plugins.inspectUpdate(request.params.pluginId);
			case "plugin/update":
				return await this.replayMutation(request, async () => {
					const res = await this.plugins.update(request.params);
					const state = await this.getPluginActivationState(res.plugin.plugin.id);
					return withPluginActivationState(res, state);
				});
			case "usage/get":
				return this.profileSummary.usage(this.allSessionRefs(), request.params.rangeDays);
			case "model/list":
				this.modelRegistry.refresh();
				return {
					models: this.modelRegistry
						.getAvailable()
						.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }))
						.sort(
							(left, right) =>
								left.name.localeCompare(right.name) || left.provider.localeCompare(right.provider),
						),
				};
			case "model/settings/get":
				return this.modelSettings.view();
			case "model/settings/update":
				return await this.replayMutation(request, () =>
					this.mutateModelServiceSettings(() => this.modelSettings.update(request.params.mutation)),
				);
			case "model/testConnection":
				return await this.replayMutation(request, () => this.modelSettings.testConnection(request.params));
			case "permission/auto/get":
				return this.permissionAutoSettings.view();
			case "permission/auto/update":
				return await this.replayMutation(request, () =>
					this.mutatePermissionAutoSettings(() => this.permissionAutoSettings.update(request.params)),
				);
			case "permission/rules/list":
				return this.permissionRules.list(request.params);
			case "permission/rules/delete":
				return await this.replayMutation(request, async () => {
					const result = this.permissionRules.delete(request.params);
					await this.registry.notifyOpenPermissionRulesChanged();
					return result;
				});
			case "permission/rules/clear":
				return await this.replayMutation(request, async () => {
					const result = this.permissionRules.clear(request.params);
					await this.registry.notifyOpenPermissionRulesChanged();
					return result;
				});
			case "project/deletePreview": {
				const cwd = await this.catalog.refreshModeProjectStorage(request.params.cwd);
				const snapshot = this.catalog.modeProjectSnapshot(request.params.mode, cwd);
				return {
					mode: snapshot.mode,
					cwd: snapshot.cwd,
					sessionCount: snapshot.refs.length,
					blockingScheduleCount:
						snapshot.mode === "chat" ? this.scheduleManager.countFixedWorkspaceTasks(snapshot.cwd) : 0,
					revision: snapshot.revision,
				};
			}
			case "project/delete":
				return await this.deleteModeProject(request);
			case "session/create":
				return await this.replayMutation(request, async () => ({
					session: await this.catalog.create(request.params),
				}));
			case "session/open": {
				await this.hydrateScheduledSession(request.params.sessionId);
				const ref = this.runtimeRef(request.params.sessionId);
				this.interactions.assign(request.params.sessionId, connection.interactionPeer);
				try {
					const runtime = await this.registry.open(ref);
					const session = this.catalog.updateSummary(request.params.sessionId, runtime.getSummary());
					return { session };
				} catch (error) {
					this.interactions.release(request.params.sessionId, connection.interactionPeer);
					if (error instanceof AppServerError && error.code === "SESSION_CORRUPT") {
						this.catalog.markCorrupt(request.params.sessionId);
					}
					throw error;
				}
			}
			case "session/markRead": {
				const ref = await this.hydrateScheduledSession(request.params.sessionId);
				if (ref.scheduled) {
					const run = await this.scheduleManager.markRunRead(ref.scheduled.taskId, ref.scheduled.runId);
					const registered = await this.catalog.registerScheduledRun(run);
					const session = registered?.session ?? this.catalog.get(request.params.sessionId).summary;
					if (registered?.changed) this.subscriptionHub.publishSessionUpdated(session);
					return { session };
				}
				const result = this.registry.has(request.params.sessionId)
					? {
							session: await this.registry.run(ref, (runtime) => runtime.markRead()),
							changed: ref.summary.unread,
						}
					: await this.catalog.markClosedSessionRead(request.params.sessionId);
				const session = this.catalog.updateSummary(request.params.sessionId, result.session);
				if (result.changed && !this.registry.has(request.params.sessionId)) {
					this.subscriptionHub.publishSessionUpdated(session);
				}
				return { session };
			}
			case "session/readItems": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.readItems(request.params));
			}
			case "session/readImage": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.readImage(request.params));
			}
			case "session/openDeliveredFile": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.openDeliveredFile(request.params));
			}
			case "session/readDeliveredFile": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.readDeliveredFile(request.params));
			}
			case "session/status": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.getStatus(request.params));
			}
			case "session/compact":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.compact(request.params));
				});
			case "session/goal/get": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.getGoal(request.params));
			}
			case "session/goal/set":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setGoal(request.params));
				});
			case "session/goal/clear":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.clearGoal(request.params));
				});
			case "agent/readItems": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.readAgentItems(request.params));
			}
			case "agent/list": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.listAgents(request.params));
			}
			case "agent/interrupt":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.interruptAgent(request.params));
				});
			case "agent/archive":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.archiveAgent(request.params));
				});
			case "agentType/list":
				return await this.registry.listAgentTypes();
			case "agentType/upsert":
				return await this.replayMutation(request, () => this.registry.upsertAgentType(request.params));
			case "agentType/remove":
				return await this.replayMutation(request, () => this.registry.removeAgentType(request.params));
			case "agent/delete":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.deleteAgent(request.params));
				});
			case "session/setThinkingSelection":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setThinkingSelection(request.params));
				});
			case "session/setPermissionPreset":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setPermissionPreset(request.params));
				});
			case "session/setCollaborationMode":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setCollaborationMode(request.params));
				});
			case "session/setMemoryFlags":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setMemoryFlags(request.params));
				});
			case "plan/startExecution":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.startPlanExecution(request.params));
				});
			case "plan/cancel":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.cancelPlan(request.params));
				});
			case "session/setModel":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setModel(request.params));
				});
			case "session/rename":
				return await this.replayMutation(request, async () => {
					this.assertMutableSession(request.params.sessionId);
					return await this.catalog.withSessionProjectMutable(request.params.sessionId, async (ref) => {
						if (ref.summary.state === "corrupt") {
							throw new AppServerError("SESSION_CORRUPT", {
								sessionId: request.params.sessionId,
							});
						}
						const session = this.registry.has(request.params.sessionId)
							? await this.registry.run(ref, (runtime) => runtime.renameSession(request.params.name))
							: await this.catalog.renameClosedSession(request.params.sessionId, request.params.name);
						return {
							session: this.catalog.updateSummary(request.params.sessionId, session),
						};
					});
				});
			case "session/fork":
				return await this.replayMutation(request, async () => {
					const targetSessionId = forkedSessionId(request.params.sessionId, request.params.requestId);
					await this.catalog.refresh();
					let persisted: SessionRef | undefined;
					try {
						persisted = this.catalog.get(targetSessionId);
					} catch (cause) {
						if (!(cause instanceof AppServerError) || cause.code !== "NOT_FOUND") throw cause;
					}
					if (persisted) {
						validatePersistedFork(persisted, request.params);
						return { session: persisted.summary, entryId: request.params.entryId };
					}
					this.assertMutableSession(request.params.sessionId);
					const ref = this.catalog.get(request.params.sessionId);
					if (ref.summary.state === "corrupt") {
						throw new AppServerError("SESSION_CORRUPT", {
							sessionId: request.params.sessionId,
						});
					}
					const originalName = ref.summary.name ?? `Metis session ${ref.summary.sessionId.slice(0, 8)}`;
					const createdSessionId = await this.registry.run(ref, (runtime) =>
						runtime.fork({
							entryId: request.params.entryId,
							name: `fork ${originalName}`,
							requestId: request.params.requestId,
							targetSessionId,
						}),
					);
					if (createdSessionId !== targetSessionId) throw new AppServerError("SESSION_CORRUPT");
					await this.catalog.refresh();
					const session = this.catalog.get(createdSessionId).summary;
					return { session, entryId: request.params.entryId };
				});
			case "session/delete": {
				let quiesced = false;
				let result: unknown;
				try {
					result = await this.replayMutation(request, async () => {
						const allowRetainedScheduled = await this.allowRetainedScheduledDelete(request.params.sessionId);
						return await this.catalog.withSessionProjectMutable(request.params.sessionId, async (ref) => {
							if (ref.summary.state === "corrupt") {
								throw new AppServerError("SESSION_CORRUPT", {
									sessionId: request.params.sessionId,
								});
							}
							return await this.registry.withSessionsQuiesced(
								[request.params.sessionId],
								async () => {
									quiesced = true;
									const deleted = await SessionManager.deleteSession(ref.path, {
										agentDir: this.catalog.agentDir,
										allowRetainedScheduled,
										sessionsRoot: this.catalog.sessionsRoot,
									});
									if (!deleted.ok) {
										throw new AppServerError(
											deleted.code === "SESSION_IN_USE" ? "SESSION_IN_USE" : "OPERATION_FAILED",
											{
												sessionId: request.params.sessionId,
												requestId: request.params.requestId,
											},
										);
									}
									await this.catalog.removeDeletedSession(request.params.sessionId, ref.path);
									this.subscriptionHub.removeSession(request.params.sessionId, {
										type: "session/invalidated",
										sessionId: request.params.sessionId,
										reason: "deleted",
									});
									return {
										sessionId: request.params.sessionId,
										deleted: true as const,
										method: deleted.method,
										...(deleted.warning
											? {
													warning: "Some session-owned files could not be removed.",
												}
											: {}),
									};
								},
								() => {
									this.interactions.releaseSession(request.params.sessionId);
								},
							);
						});
					});
				} catch (error) {
					if (quiesced) {
						this.subscriptionHub.removeSession(request.params.sessionId, {
							type: "session/invalidated",
							sessionId: request.params.sessionId,
							reason: "reload_required",
						});
					}
					throw error;
				}
				connection.subscriptions.unsubscribe(request.params.sessionId);
				this.interactions.release(request.params.sessionId, connection.interactionPeer);
				return result;
			}
			case "session/close": {
				const ref = this.catalog.get(request.params.sessionId);
				if (ref.scheduled) {
					const result = await this.replayMutation(request, async () => {
						await this.registry.close(request.params.sessionId);
						this.subscriptionHub.removeSession(request.params.sessionId);
						return { sessionId: request.params.sessionId, closed: true };
					});
					connection.subscriptions.unsubscribe(request.params.sessionId);
					this.interactions.release(request.params.sessionId, connection.interactionPeer);
					return result;
				}
				const result = await this.replayMutation(request, () =>
					this.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
						const mutation: DurableSessionMutation = {
							method: "session/close",
							kind: "session_close",
							requestId: request.params.requestId,
							params: { sessionId: request.params.sessionId },
						};
						let prepared: PreparedSessionMutation | undefined;
						let closedRuntime = false;
						if (this.registry.has(request.params.sessionId)) {
							await this.registry.close(request.params.sessionId, async (runtime) => {
								prepared = await runtime.prepareMutation(mutation);
								closedRuntime = prepared.state !== "completed";
								return closedRuntime;
							});
						} else {
							prepared = this.catalog.prepareDurableMutation(request.params.sessionId, mutation);
						}
						if (closedRuntime) this.subscriptionHub.removeSession(request.params.sessionId);
						if (prepared?.state === "completed") return prepared.result;
						const response = {
							sessionId: request.params.sessionId,
							closed: true,
						};
						return this.catalog.completeDurableMutation(request.params.sessionId, mutation, response);
					}),
				);
				connection.subscriptions.unsubscribe(request.params.sessionId);
				this.interactions.release(request.params.sessionId, connection.interactionPeer);
				return result;
			}
			case "session/archive":
				return await this.replayMutation(request, async () => {
					this.assertMutableSession(request.params.sessionId);
					return await this.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
						this.registry.assertClosed(request.params.sessionId);
						return {
							session: await this.catalog.archive(request.params.sessionId, request.params.requestId),
						};
					});
				});
			case "session/unarchive":
				return await this.replayMutation(request, async () => {
					this.assertMutableSession(request.params.sessionId);
					return await this.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
						this.registry.assertClosed(request.params.sessionId);
						return {
							session: await this.catalog.unarchive(request.params.sessionId, request.params.requestId),
						};
					});
				});
			case "session/subscribe": {
				const ref = this.runtimeRef(request.params.sessionId);
				this.interactions.assign(request.params.sessionId, connection.interactionPeer);
				try {
					const snapshot = await this.registry.run(ref, (runtime) => connection.subscriptions.subscribe(runtime));
					this.catalog.updateSummary(request.params.sessionId, snapshot.session);
					return { snapshot };
				} catch (error) {
					this.interactions.release(request.params.sessionId, connection.interactionPeer);
					throw error;
				}
			}
			case "session/unsubscribe":
				connection.subscriptions.unsubscribe(request.params.sessionId);
				this.interactions.release(request.params.sessionId, connection.interactionPeer);
				return { sessionId: request.params.sessionId, unsubscribed: true };
			case "turn/start":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, async (runtime) => {
						const unnamed = !runtime.getSummary().name;
						const result = await runtime.startTurn(request.params);
						if (unnamed) this.startTitleJob(request.params.sessionId, request.params);
						return result;
					});
				});
			case "turn/steer":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.steer(request.params));
				});
			case "turn/queue":
				return await this.replayMutation(request, () => {
					this.assertMutableSession(request.params.sessionId);
					return this.registry.run(this.runtimeRef(request.params.sessionId), (runtime) =>
						runtime.queueTurn(request.params),
					);
				});
			case "turn/queue/update":
				return await this.replayMutation(request, () => {
					this.assertMutableSession(request.params.sessionId);
					return this.registry.run(this.runtimeRef(request.params.sessionId), (runtime) =>
						runtime.updateQueuedTurn(request.params),
					);
				});
			case "turn/queue/delete":
				return await this.replayMutation(request, () => {
					this.assertMutableSession(request.params.sessionId);
					return this.registry.run(this.runtimeRef(request.params.sessionId), (runtime) =>
						runtime.deleteQueuedTurn(request.params),
					);
				});
			case "turn/queue/send":
				return await this.replayMutation(request, () => {
					this.assertMutableSession(request.params.sessionId);
					return this.registry.run(this.runtimeRef(request.params.sessionId), (runtime) =>
						runtime.sendQueuedTurn(request.params),
					);
				});
			case "turn/interrupt":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.interrupt(request.params));
				});
			case "schedule/create":
				return await this.replayMutation(request, async () => {
					this.availableModel(request.params.model);
					const source = this.scheduleTarget(
						request.params.sourceSessionId,
						request.params.additionalWorkspaceCwd,
					);
					return {
						task: scheduleTaskView(
							await this.scheduleManager.create({
								id: request.params.requestId,
								name: request.params.name,
								...(request.params.description === undefined
									? {}
									: { description: request.params.description }),
								instruction: request.params.instruction,
								model: request.params.model,
								schedule: request.params.schedule,
								timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
								...source,
							}),
						),
					};
				});
			case "schedule/list": {
				const page = await this.scheduleManager.list({
					...(request.params.afterTaskId ? { afterTaskId: request.params.afterTaskId } : {}),
					...(request.params.limit === undefined ? {} : { limit: request.params.limit }),
					...(request.params.unreadOnly === undefined ? {} : { unreadOnly: request.params.unreadOnly }),
					...(request.params.query === undefined ? {} : { query: request.params.query }),
					...(request.params.sort === undefined ? {} : { sort: request.params.sort }),
				});
				return {
					tasks: page.tasks.map(scheduleTaskView),
					nextAfterTaskId: page.nextAfterTaskId,
					unreadCount: this.scheduleManager.unreadCount(),
				};
			}
			case "schedule/get":
				return {
					task: scheduleTaskView(await this.scheduleManager.get(request.params.taskId)),
				};
			case "schedule/update":
				return await this.replayMutation(request, async () => {
					if (request.params.model) this.availableModel(request.params.model);
					let target: ScheduleCreateTarget | undefined;
					if (request.params.sourceSessionId !== undefined) {
						target =
							request.params.sourceSessionId === null
								? this.scheduleTarget(undefined, request.params.additionalWorkspaceCwd ?? undefined).target
								: this.scheduleTarget(request.params.sourceSessionId).target;
					} else if (request.params.additionalWorkspaceCwd !== undefined) {
						const current = await this.scheduleManager.get(request.params.taskId);
						if (current.target.workspace !== "task") throw new AppServerError("INVALID_REQUEST");
						target = this.scheduleTarget(undefined, request.params.additionalWorkspaceCwd ?? undefined).target;
					}
					return {
						task: scheduleTaskView(
							await this.scheduleManager.update(request.params.taskId, {
								...(request.params.name === undefined ? {} : { name: request.params.name }),
								...(request.params.description === undefined
									? {}
									: { description: request.params.description }),
								...(request.params.instruction === undefined
									? {}
									: { instruction: request.params.instruction }),
								...(request.params.model === undefined ? {} : { model: request.params.model }),
								...(request.params.schedule === undefined ? {} : { schedule: request.params.schedule }),
								...(target === undefined ? {} : { target }),
							}),
						),
					};
				});
			case "schedule/pause":
				return await this.replayMutation(request, async () => ({
					task: scheduleTaskView(await this.scheduleManager.pause(request.params.taskId)),
				}));
			case "schedule/resume":
				return await this.replayMutation(request, async () => ({
					task: scheduleTaskView(await this.scheduleManager.resume(request.params.taskId)),
				}));
			case "schedule/delete":
				return await this.replayMutation(request, async () => {
					if (request.params.deleteSessions) await this.closeScheduledTaskSessions(request.params.taskId);
					const result = await this.scheduleManager.delete(request.params.taskId, {
						deleteSessions: request.params.deleteSessions,
					});
					await this.reconcileScheduledTaskSessions(request.params.taskId);
					return result;
				});
			case "schedule/run-now":
				return await this.replayMutation(request, async () => ({
					run: scheduleRunView(await this.scheduleManager.runNow(request.params.taskId, request.params.requestId)),
				}));
			case "schedule/run/list": {
				const page = await this.scheduleManager.listRuns(request.params.taskId, {
					...(request.params.beforeRunId ? { beforeRunId: request.params.beforeRunId } : {}),
					...(request.params.limit === undefined ? {} : { limit: request.params.limit }),
				});
				return {
					runs: page.runs.map(scheduleRunView),
					nextBeforeRunId: page.nextBeforeRunId,
				};
			}
			case "schedule/run/get": {
				const run = await this.scheduleManager.getRun(request.params.taskId, request.params.runId);
				const registered = await this.catalog.registerScheduledRun(run);
				if (registered?.changed) this.subscriptionHub.publishSessionUpdated(registered.session);
				return { run: scheduleRunView(run) };
			}
			case "schedule/run/mark-read":
				return await this.replayMutation(request, async () => {
					const run = await this.scheduleManager.markRunRead(request.params.taskId, request.params.runId);
					const registered = await this.catalog.registerScheduledRun(run);
					if (registered?.changed) this.subscriptionHub.publishSessionUpdated(registered.session);
					const task = await this.scheduleManager.get(request.params.taskId);
					return { run: scheduleRunView(run), unreadCount: task.unreadCount };
				});
			case "schedule/subscribe":
				return {
					snapshot: await connection.subscriptions.subscribeSchedule((cursor) => this.scheduleSnapshot(cursor)),
				};
			case "schedule/unsubscribe":
				connection.subscriptions.unsubscribeSchedule();
				return { unsubscribed: true };
			case "connection/ack":
				return {
					acknowledgedCursor: connection.subscriptions.acknowledge(
						request.params.serverEpoch,
						request.params.cursor,
					),
				};
		}
	}
}
