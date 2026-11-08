import { createHash } from "node:crypto";
import { type ClientParams, type ClientRpcRequest, MAX_HISTORY_ITEMS } from "@metis/app-protocol";
import { type ModelRegistry, ScheduleError, type ScheduleManager, SessionManager } from "@metis/coding-agent/host";
import { AgentCatalog } from "./agent-catalog.ts";
import { ArchivedConversationCatalog } from "./archived-conversations.ts";
import { dispatchAgentTypeRequest, isAgentTypeRequest } from "./dispatch/agent-types.ts";
import { dispatchAgentsRequest, isAgentsRequest } from "./dispatch/agents.ts";
import { dispatchHooksRequest, isHooksRequest } from "./dispatch/hooks.ts";
import { dispatchKnowledgeRequest, isKnowledgeRequest } from "./dispatch/knowledge.ts";
import { dispatchMcpRequest, isMcpRequest } from "./dispatch/mcp.ts";
import { dispatchMemoryRequest, isMemoryRequest } from "./dispatch/memory.ts";
import { dispatchModelRequest, isModelRequest } from "./dispatch/model.ts";
import { dispatchPermissionRequest, isPermissionRequest } from "./dispatch/permission.ts";
import { dispatchPersonalizationRequest, isPersonalizationRequest } from "./dispatch/personalization.ts";
import { dispatchPlanRequest, isPlanRequest } from "./dispatch/plan.ts";
import { dispatchPluginsRequest, isPluginsRequest } from "./dispatch/plugins.ts";
import { dispatchProfileRequest, isProfileRequest } from "./dispatch/profile.ts";
import {
	dispatchScheduleRequest,
	isScheduleRequest,
	reconcileScheduledTaskSessions as reconcileScheduledSessions,
	type ScheduleCoreContext,
} from "./dispatch/schedule.ts";
import { dispatchSessionsRequest, isSessionsRequest, type SessionsDispatchContext } from "./dispatch/sessions.ts";
import { dispatchSkillsRequest, isSkillsRequest } from "./dispatch/skills.ts";
import { dispatchTurnsRequest, isTurnsRequest } from "./dispatch/turns.ts";
import { dispatchWebSearchRequest, isWebSearchRequest } from "./dispatch/web-search.ts";
import type { HooksService } from "./hooks.ts";
import type { InteractionBroker, InteractionPeer } from "./interactions.ts";
import { KnowledgeService } from "./knowledge.ts";
import type { MemoryService } from "./memory-settings.ts";
import type { ModelSettingsService } from "./model-settings.ts";
import type { PermissionAutoSettingsService } from "./permission-auto-settings.ts";
import type { PermissionRulesService } from "./permission-rules.ts";
import type { PersonalizationService } from "./personalization.ts";
import type { PluginService } from "./plugins.ts";
import { ProfileSummaryCache } from "./profile-summary.ts";
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

export class Dispatcher {
	private readonly knowledge: KnowledgeService;
	private readonly replay = new Map<string, ReplayEntry>();
	private readonly catalog: SessionCatalog;
	private readonly agentCatalog: AgentCatalog;
	private readonly archivedConversations: ArchivedConversationCatalog;
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
		this.agentCatalog = new AgentCatalog(catalog.agentDir);
		this.archivedConversations = new ArchivedConversationCatalog(catalog.agentDir);
		this.knowledge = new KnowledgeService(catalog.agentDir);
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

	private scheduleCoreContext(): ScheduleCoreContext {
		return {
			scheduleManager: this.scheduleManager,
			modelRegistry: this.modelRegistry,
			catalog: this.catalog,
			registry: this.registry,
			subscriptionHub: this.subscriptionHub,
			replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
		};
	}

	async reconcileScheduledTaskSessions(taskId: string): Promise<void> {
		await reconcileScheduledSessions(this.scheduleCoreContext(), taskId);
	}

	private runtimeRef(sessionId: string): SessionRef {
		const ref = this.catalog.get(sessionId);
		if (ref.summary.archived) throw new AppServerError("NOT_FOUND", { sessionId });
		if (ref.summary.state === "unsupported") {
			throw new AppServerError("SESSION_VERSION_UNSUPPORTED", { sessionId });
		}
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
		if (ref.summary.state === "unsupported") {
			throw new AppServerError("SESSION_VERSION_UNSUPPORTED", { sessionId });
		}
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
		const ref = this.catalog.get(sessionId);
		if (ref.summary.state === "unsupported") throw new AppServerError("SESSION_VERSION_UNSUPPORTED", { sessionId });
		if (ref.scheduled) throw new AppServerError("READ_ONLY_SESSION", { sessionId });
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

	private sessionContext(connection: ConnectionState): SessionsDispatchContext {
		return {
			catalog: this.catalog,
			registry: this.registry,
			subscriptionHub: this.subscriptionHub,
			interactions: this.interactions,
			knowledge: this.knowledge,
			archivedConversations: this.archivedConversations,
			scheduleManager: this.scheduleManager,
			connectionSubscriptions: connection.subscriptions,
			interactionPeer: connection.interactionPeer,
			allSessionRefs: () => this.allSessionRefs(),
			runtimeRef: (sessionId) => this.runtimeRef(sessionId),
			hydrateScheduledSession: (sessionId) => this.hydrateScheduledSession(sessionId),
			assertMutableSession: (sessionId) => this.assertMutableSession(sessionId),
			allowRetainedScheduledDelete: (sessionId) => this.allowRetainedScheduledDelete(sessionId),
			replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
		};
	}

	async dispatch(request: ClientRpcRequest, connection: ConnectionState): Promise<unknown> {
		if (isKnowledgeRequest(request)) {
			return await dispatchKnowledgeRequest(request, {
				knowledge: this.knowledge,
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isProfileRequest(request)) {
			return await dispatchProfileRequest(request, {
				profileSummary: this.profileSummary,
				allSessionRefs: () => this.allSessionRefs(),
			});
		}
		if (isPersonalizationRequest(request)) {
			return await dispatchPersonalizationRequest(request, {
				personalization: this.personalization,
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isHooksRequest(request)) {
			return await dispatchHooksRequest(request, {
				hooks: this.hooks,
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isWebSearchRequest(request)) {
			return await dispatchWebSearchRequest(request, {
				webSearch: this.webSearch,
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
				refreshOpenWebSearchSettings: () => this.registry.refreshOpenWebSearchSettings(),
			});
		}
		if (isAgentTypeRequest(request)) {
			return await dispatchAgentTypeRequest(request, {
				registry: this.registry,
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isSkillsRequest(request)) {
			return await dispatchSkillsRequest(request, {
				registry: this.registry,
				runtimeRef: (sessionId) => this.runtimeRef(sessionId),
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isPlanRequest(request)) {
			return await dispatchPlanRequest(request, {
				registry: this.registry,
				runtimeRef: (sessionId) => this.runtimeRef(sessionId),
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isMcpRequest(request)) {
			return await dispatchMcpRequest(request, {
				registry: this.registry,
				runtimeRef: (sessionId) => this.runtimeRef(sessionId),
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isMemoryRequest(request)) {
			return await dispatchMemoryRequest(request, {
				memorySettings: this.memorySettings,
				registry: this.registry,
				dropRuntimeSubscriptions: (sessionIds) => this.dropRuntimeSubscriptions(sessionIds),
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isModelRequest(request)) {
			return await dispatchModelRequest(request, {
				modelRegistry: this.modelRegistry,
				modelSettings: this.modelSettings,
				registry: this.registry,
				dropRuntimeSubscriptions: (sessionIds) => this.dropRuntimeSubscriptions(sessionIds),
				mutateModelServiceSettings: <T>(mutate: () => Promise<T>) => this.mutateModelServiceSettings(mutate),
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isPermissionRequest(request)) {
			return await dispatchPermissionRequest(request, {
				permissionRules: this.permissionRules,
				permissionAutoSettings: this.permissionAutoSettings,
				registry: this.registry,
				mutatePermissionAutoSettings: <T>(mutate: () => Promise<T>) => this.mutatePermissionAutoSettings(mutate),
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isPluginsRequest(request)) {
			return await dispatchPluginsRequest(request, {
				plugins: this.plugins,
				registry: this.registry,
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isAgentsRequest(request)) {
			return await dispatchAgentsRequest(request, {
				registry: this.registry,
				catalog: this.catalog,
				agentCatalog: this.agentCatalog,
				connectionSubscriptions: connection.subscriptions,
				interactions: this.interactions,
				interactionPeer: connection.interactionPeer,
				runtimeRef: (sessionId) => this.runtimeRef(sessionId),
				assertMutableSession: (sessionId) => this.assertMutableSession(sessionId),
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isTurnsRequest(request)) {
			return await dispatchTurnsRequest(request, {
				registry: this.registry,
				runtimeRef: (sessionId) => this.runtimeRef(sessionId),
				assertMutableSession: (sessionId) => this.assertMutableSession(sessionId),
				startTitleJob: (sessionId, input) => this.startTitleJob(sessionId, input),
				replayMutation: (replayRequest, run) => this.replayMutation(replayRequest, run),
			});
		}
		if (isScheduleRequest(request)) {
			return await dispatchScheduleRequest(request, {
				...this.scheduleCoreContext(),
				subscriptions: connection.subscriptions,
			});
		}
		if (isSessionsRequest(request)) {
			return await dispatchSessionsRequest(request, this.sessionContext(connection));
		}
		switch (request.method) {
			case "initialize":
				throw new AppServerError("INVALID_REQUEST");
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
