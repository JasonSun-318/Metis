import { ClientRequestMethods, type ClientRpcRequest } from "@metis/app-protocol";
import type { ModelRegistry, ScheduleManager } from "@metis/coding-agent/host";
import { describe, expect, it, vi } from "vitest";
import type { AgentCatalog } from "../src/agent-catalog.ts";
import type { ArchivedConversationCatalog } from "../src/archived-conversations.ts";
import { dispatchAgentTypeRequest, isAgentTypeRequest } from "../src/dispatch/agent-types.ts";
import { dispatchAgentsRequest, isAgentsRequest } from "../src/dispatch/agents.ts";
import { dispatchHooksRequest, isHooksRequest } from "../src/dispatch/hooks.ts";
import { dispatchMcpRequest, isMcpRequest } from "../src/dispatch/mcp.ts";
import { dispatchMemoryRequest, isMemoryRequest } from "../src/dispatch/memory.ts";
import { dispatchModelRequest, isModelRequest } from "../src/dispatch/model.ts";
import { dispatchPermissionRequest, isPermissionRequest } from "../src/dispatch/permission.ts";
import { dispatchPersonalizationRequest, isPersonalizationRequest } from "../src/dispatch/personalization.ts";
import { dispatchPlanRequest, isPlanRequest } from "../src/dispatch/plan.ts";
import { dispatchPluginsRequest, isPluginsRequest } from "../src/dispatch/plugins.ts";
import { dispatchProfileRequest, isProfileRequest } from "../src/dispatch/profile.ts";
import { dispatchProjectRequest, isProjectRequest } from "../src/dispatch/project.ts";
import { dispatchScheduleRequest, isScheduleRequest } from "../src/dispatch/schedule.ts";
import { dispatchSessionsRequest, isSessionsRequest } from "../src/dispatch/sessions.ts";
import { dispatchSkillsRequest, isSkillsRequest } from "../src/dispatch/skills.ts";
import { dispatchTurnsRequest, isTurnsRequest } from "../src/dispatch/turns.ts";
import { dispatchWebSearchRequest, isWebSearchRequest } from "../src/dispatch/web-search.ts";
import type { HooksService } from "../src/hooks.ts";
import type { InteractionBroker, InteractionPeer } from "../src/interactions.ts";
import type { KnowledgeService } from "../src/knowledge.ts";
import type { MemoryService } from "../src/memory-settings.ts";
import type { ModelSettingsService } from "../src/model-settings.ts";
import type { PermissionAutoSettingsService } from "../src/permission-auto-settings.ts";
import type { PermissionRulesService } from "../src/permission-rules.ts";
import type { PersonalizationService } from "../src/personalization.ts";
import type { PluginService } from "../src/plugins.ts";
import type { ProfileSummaryCache } from "../src/profile-summary.ts";
import type { SessionCatalog } from "../src/session-catalog.ts";
import type { SessionRegistry } from "../src/session-registry.ts";
import type { SessionRef } from "../src/session-runtime-host.ts";
import type { ConnectionSubscriptions, SessionSubscriptions } from "../src/subscriptions.ts";
import type { WebSearchService } from "../src/web-search.ts";

function request(method: string, params: unknown = {}): ClientRpcRequest {
	return { jsonrpc: "2.0", id: "req-1", method, params } as ClientRpcRequest;
}

function replayTracker() {
	const mutations: string[] = [];
	return {
		mutations,
		replayMutation: async (replayRequest: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown> => {
			mutations.push(replayRequest.method);
			return await run();
		},
	};
}

function profileContext() {
	const refs = [{ summary: { sessionId: "s1" } }] as unknown as SessionRef[];
	const profileSummary = {
		summarize: vi.fn(() => ({ sessions: refs.length })),
		usage: vi.fn(() => ({ sessions: refs.length })),
	} as unknown as ProfileSummaryCache;
	return { refs, profileSummary, context: { profileSummary, allSessionRefs: () => refs } };
}

function personalizationContext() {
	const personalization = {
		view: vi.fn(() => ({ language: "zh" })),
		update: vi.fn(async (input: unknown) => input),
	} as unknown as PersonalizationService;
	return { personalization, context: { personalization, ...replayTracker() } };
}

function hooksContext() {
	const hooks = {
		view: vi.fn(() => ({ hooks: [] })),
		upsert: vi.fn(async (input: unknown) => input),
		delete: vi.fn(async (input: unknown) => input),
	} as unknown as HooksService;
	return { hooks, context: { hooks, ...replayTracker() } };
}

function webSearchContext() {
	const webSearch = {
		view: vi.fn(() => ({ provider: "brave" })),
		reveal: vi.fn((input: unknown) => input),
		update: vi.fn(async (input: unknown) => input),
	} as unknown as WebSearchService;
	const refreshOpenWebSearchSettings = vi.fn(async () => undefined);
	return {
		webSearch,
		refreshOpenWebSearchSettings,
		context: { webSearch, ...replayTracker(), refreshOpenWebSearchSettings },
	};
}

function agentTypeContext() {
	const registry = {
		listAgentTypes: vi.fn(async () => ({ agentTypes: [] })),
		upsertAgentType: vi.fn(async (input: unknown) => input),
		removeAgentType: vi.fn(async (input: unknown) => input),
	} as unknown as SessionRegistry;
	return { registry, context: { registry, ...replayTracker() } };
}

function skillsContext() {
	const runtime = { listSkills: vi.fn(async () => ({ skills: [] })) };
	const ref = { summary: { sessionId: "s1" } } as unknown as SessionRef;
	const registry = {
		run: vi.fn(async (_ref: SessionRef, run: (runtime: unknown) => Promise<unknown>) => await run(runtime)),
		listDraftSkills: vi.fn(async () => ({ skills: [] })),
		getDraftSkill: vi.fn(async (input: unknown) => input),
		upsertDraftSkill: vi.fn(async (input: unknown) => input),
		removeDraftSkill: vi.fn(async (input: unknown) => input),
		inspectDraftSkillImport: vi.fn(async (input: unknown) => input),
		importDraftSkills: vi.fn(async (input: unknown) => input),
	} as unknown as SessionRegistry;
	return { runtime, registry, context: { registry, runtimeRef: () => ref, ...replayTracker() } };
}

function planContext() {
	const runtime = {
		startPlanExecution: vi.fn(async (input: unknown) => input),
		cancelPlan: vi.fn(async (input: unknown) => input),
	};
	const ref = { summary: { sessionId: "s1" } } as unknown as SessionRef;
	const registry = {
		run: vi.fn(async (_ref: SessionRef, run: (runtime: unknown) => Promise<unknown>) => await run(runtime)),
	} as unknown as SessionRegistry;
	return { runtime, registry, context: { registry, runtimeRef: () => ref, ...replayTracker() } };
}

function mcpContext() {
	const runtime = {
		listMcpServers: vi.fn(async () => ({ servers: [] })),
		inspectMcpImport: vi.fn(async (input: unknown) => input),
		importMcpServers: vi.fn(async (input: unknown) => input),
		getMcpServer: vi.fn(async (input: unknown) => input),
		getMcpCatalogItem: vi.fn(async (input: unknown) => input),
		upsertMcpServer: vi.fn(async (input: unknown) => input),
		removeMcpServer: vi.fn(async (input: unknown) => input),
		restartMcpServer: vi.fn(async (input: unknown) => input),
		setMcpCredential: vi.fn(async (input: unknown) => input),
		clearMcpCredential: vi.fn(async (input: unknown) => input),
	};
	const ref = { summary: { sessionId: "s1" } } as unknown as SessionRef;
	const registry = {
		run: vi.fn(async (_ref: SessionRef, run: (runtime: unknown) => Promise<unknown>) => await run(runtime)),
		listDraftMcpServers: vi.fn(async () => ({ servers: [] })),
		inspectDraftMcpImport: vi.fn(async (input: unknown) => input),
		importDraftMcpServers: vi.fn(async (input: unknown) => input),
		getDraftMcpServer: vi.fn(async (input: unknown) => input),
		upsertDraftMcpServer: vi.fn(async (input: unknown) => input),
		removeDraftMcpServer: vi.fn(async (input: unknown) => input),
	} as unknown as SessionRegistry;
	return { runtime, registry, context: { registry, runtimeRef: () => ref, ...replayTracker() } };
}

function memoryContext() {
	const release = vi.fn();
	const memorySettings = {
		view: vi.fn((input: unknown) => input),
		update: vi.fn(async (input: unknown) => input),
		listNotes: vi.fn(async () => ({ notes: [] })),
		readNote: vi.fn(async () => ({ content: "" })),
		writeNote: vi.fn(async (input: unknown) => input),
		history: vi.fn(async () => ({ entries: [] })),
		historyRead: vi.fn(async () => ({ content: "" })),
		undo: vi.fn(async (input: unknown) => input),
		undoRun: vi.fn(async (input: unknown) => input),
		dreamRun: vi.fn(async (input: unknown) => input),
	} as unknown as MemoryService;
	const registry = {
		beginModelServiceSettingsRefresh: vi.fn(async () => release),
		refreshOpenMemorySettings: vi.fn(async () => ["s1"]),
	} as unknown as SessionRegistry;
	const dropRuntimeSubscriptions = vi.fn();
	return {
		memorySettings,
		release,
		dropRuntimeSubscriptions,
		context: { memorySettings, registry, dropRuntimeSubscriptions, ...replayTracker() },
	};
}

function modelContext() {
	const modelRegistry = {
		refresh: vi.fn(),
		getAvailable: vi.fn(() => [
			{ provider: "p2", id: "m2", name: "Zeta" },
			{ provider: "p1", id: "m1", name: "Alpha" },
		]),
	} as unknown as ModelRegistry;
	const modelSettings = {
		view: vi.fn(() => ({ models: [] })),
		update: vi.fn(async (input: unknown) => ({ updated: input })),
		testConnection: vi.fn(async () => ({ ok: true })),
		discover: vi.fn(async () => ({ models: [] })),
	} as unknown as ModelSettingsService;
	const registry = {
		refreshOpenPermissionAutoSettings: vi.fn(async () => ["s1"]),
	} as unknown as SessionRegistry;
	const dropRuntimeSubscriptions = vi.fn();
	const mutateModelServiceSettings = async <T>(mutate: () => Promise<T>): Promise<T> => await mutate();
	return {
		modelRegistry,
		modelSettings,
		dropRuntimeSubscriptions,
		context: {
			modelRegistry,
			modelSettings,
			registry,
			dropRuntimeSubscriptions,
			mutateModelServiceSettings,
			...replayTracker(),
		},
	};
}

function permissionContext() {
	const permissionRules = {
		list: vi.fn(async () => ({ scope: "project", rules: [] })),
		listRemembered: vi.fn(async () => ({ rules: [] })),
		revokeRemembered: vi.fn(async () => ({ scope: "project" })),
		delete: vi.fn(async () => ({ scope: "project" })),
		clear: vi.fn(async () => ({ scope: "project" })),
	} as unknown as PermissionRulesService;
	const permissionAutoSettings = {
		read: vi.fn(async () => ({ mode: "auto" })),
		update: vi.fn(async (input: unknown) => input),
	} as unknown as PermissionAutoSettingsService;
	const registry = {
		withOpenRuntime: vi.fn(async (_sessionId: string, run: (runtime: unknown) => Promise<unknown>) => ({
			open: true,
			result: await run({ getPermissionScopePreview: () => ({ scope: "workspace" }) }),
		})),
		notifySessionPermissionRulesChanged: vi.fn(async () => undefined),
		notifyOpenPermissionRulesChanged: vi.fn(async () => undefined),
	} as unknown as SessionRegistry;
	const mutatePermissionAutoSettings = async <T>(mutate: () => Promise<T>): Promise<T> => await mutate();
	return {
		permissionRules,
		permissionAutoSettings,
		registry,
		context: { permissionRules, permissionAutoSettings, registry, mutatePermissionAutoSettings, ...replayTracker() },
	};
}

function pluginsContext() {
	const installedPlugin = {
		plugin: { id: "p1", activation: "not-running", runtimeErrors: [] },
		activation: "not-running",
		runtimeErrors: [],
	};
	const plugins = {
		agentDir: "/nonexistent-metis-plugins-fixture",
		listMarkets: vi.fn(() => ({ markets: [] })),
		addMarket: vi.fn(async (input: unknown) => input),
		selectMarket: vi.fn(async (input: unknown) => input),
		removeMarket: vi.fn(async (input: unknown) => input),
		refreshMarket: vi.fn(async () => ({})),
		getCatalog: vi.fn(async () => ({ entries: [] })),
		inspectPlugin: vi.fn(async () => ({ plugin: {} })),
		install: vi.fn(async () => ({ plugin: installedPlugin })),
		listInstalled: vi.fn(() => ({ plugins: [] })),
		getInstalled: vi.fn(() => ({ plugin: installedPlugin })),
		setEnabled: vi.fn(() => ({ plugin: installedPlugin })),
		remove: vi.fn(() => ({ removed: true })),
		inspectUpdate: vi.fn(async () => ({ update: null })),
		update: vi.fn(async () => ({ plugin: installedPlugin })),
	} as unknown as PluginService;
	const registry = { pluginRuntimeStatuses: vi.fn(async () => []) } as unknown as SessionRegistry;
	return { plugins, registry, context: { plugins, registry, ...replayTracker() } };
}

function agentsContext() {
	const runtime = {
		sessionId: "s1",
		readAgentItems: vi.fn(async (input: unknown) => input),
		listAgents: vi.fn(async (input: unknown) => input),
		sendAgentMessage: vi.fn(async (input: unknown) => input),
		controlAgent: vi.fn(async (input: unknown) => input),
		readAgentQueuedMessages: vi.fn(async (input: unknown) => input),
		deleteAgentQueuedMessage: vi.fn(async (input: unknown) => input),
		sendAgentQueuedMessage: vi.fn(async (input: unknown) => input),
		interruptAgent: vi.fn(async (input: unknown) => input),
		archiveAgent: vi.fn(async (input: unknown) => input),
		renameAgent: vi.fn(async (input: unknown) => input),
		deleteAgent: vi.fn(async (input: unknown) => input),
	};
	const ref = { summary: { sessionId: "s1" } } as unknown as SessionRef;
	const registry = {
		run: vi.fn(async (_ref: SessionRef, run: (runtime: unknown) => Promise<unknown>) => await run(runtime)),
		withOpenRuntime: vi.fn(async (_sessionId: string, run: (runtime: unknown) => Promise<unknown>) => ({
			open: true,
			result: await run(runtime),
		})),
		assertClosed: vi.fn(),
	} as unknown as SessionRegistry;
	const catalog = {
		agentDir: "/nonexistent-metis-agent-dir",
		get: vi.fn(() => ({ summary: { archived: false } })),
		withSessionProjectMutable: vi.fn(
			async (_id: string, run: (ref: SessionRef) => Promise<unknown>) => await run(ref),
		),
	} as unknown as SessionCatalog;
	const agentCatalog = { list: vi.fn(async () => ({ agents: [] })) } as unknown as AgentCatalog;
	const connectionSubscriptions = {
		has: vi.fn(() => true),
		subscribe: vi.fn(async () => undefined),
	} as unknown as ConnectionSubscriptions;
	const interactions = { assign: vi.fn() } as unknown as InteractionBroker;
	return {
		runtime,
		registry,
		catalog,
		context: {
			registry,
			catalog,
			agentCatalog,
			connectionSubscriptions,
			interactions,
			interactionPeer: { request: vi.fn(async () => ({})) } as unknown as InteractionPeer,
			runtimeRef: () => ref,
			assertMutableSession: vi.fn(),
			...replayTracker(),
		},
	};
}

function turnsContext() {
	const runtime = {
		getSummary: vi.fn(() => ({ name: "named" })),
		startTurn: vi.fn(async (input: unknown) => input),
		steer: vi.fn(async (input: unknown) => input),
		queueTurn: vi.fn(async (input: unknown) => input),
		updateQueuedTurn: vi.fn(async (input: unknown) => input),
		deleteQueuedTurn: vi.fn(async (input: unknown) => input),
		sendQueuedTurn: vi.fn(async (input: unknown) => input),
		interrupt: vi.fn(async (input: unknown) => input),
	};
	const ref = { summary: { sessionId: "s1" } } as unknown as SessionRef;
	const registry = {
		run: vi.fn(async (_ref: SessionRef, run: (runtime: unknown) => Promise<unknown>) => await run(runtime)),
	} as unknown as SessionRegistry;
	const startTitleJob = vi.fn();
	return {
		runtime,
		startTitleJob,
		context: {
			registry,
			runtimeRef: () => ref,
			assertMutableSession: vi.fn(),
			startTitleJob,
			...replayTracker(),
		},
	};
}

function scheduleContext() {
	const scheduleManager = {
		create: vi.fn(async (input: unknown) => input),
		list: vi.fn(async () => ({ tasks: [], nextAfterTaskId: null })),
		get: vi.fn(async () => ({ taskId: "t1", unreadCount: 0, target: { workspace: "task" } })),
		update: vi.fn(async (taskId: string, input: unknown) => ({ taskId, ...(input as object) })),
		pause: vi.fn(async () => ({ taskId: "t1" })),
		resume: vi.fn(async () => ({ taskId: "t1" })),
		delete: vi.fn(async () => ({ deleted: true })),
		runNow: vi.fn(async () => ({ runId: "r1" })),
		listRuns: vi.fn(async () => ({ runs: [], nextBeforeRunId: null })),
		getRun: vi.fn(async () => ({ runId: "r1" })),
		markRunRead: vi.fn(async () => ({ runId: "r1" })),
		unreadCount: vi.fn(() => 0),
	} as unknown as ScheduleManager;
	const modelRegistry = {
		refresh: vi.fn(),
		find: vi.fn(() => ({ id: "m1" })),
		hasConfiguredAuth: vi.fn(() => true),
	} as unknown as ModelRegistry;
	const catalog = {
		get: vi.fn(() => ({
			scheduled: undefined,
			summary: { archived: false, state: "idle", cwd: "/work", cwdOrigin: "project" },
		})),
		scheduledSessionIds: vi.fn(() => []),
		registerScheduledRun: vi.fn(async () => ({ changed: false })),
		refresh: vi.fn(async () => undefined),
	} as unknown as SessionCatalog;
	const registry = { has: vi.fn(() => false), close: vi.fn(async () => undefined) } as unknown as SessionRegistry;
	const subscriptionHub = {
		serverEpoch: "epoch-1",
		publishSessionUpdated: vi.fn(),
		removeSession: vi.fn(),
	} as unknown as SessionSubscriptions;
	const subscriptions = {
		subscribeSchedule: vi.fn(async () => ({ tasks: [] })),
		unsubscribeSchedule: vi.fn(),
	} as unknown as ConnectionSubscriptions;
	return {
		scheduleManager,
		context: {
			scheduleManager,
			modelRegistry,
			catalog,
			registry,
			subscriptionHub,
			subscriptions,
			...replayTracker(),
		},
	};
}

function sessionsContext() {
	const runtime = {
		getStatus: vi.fn(async (input: unknown) => ({ state: "idle", input })),
		getGoal: vi.fn(async (input: unknown) => input),
	};
	const ref = { summary: { sessionId: "s1" } } as unknown as SessionRef;
	const catalog = {
		list: vi.fn(() => ({ sessions: [], nextAfterSessionId: null })),
		get: vi.fn(() => ref),
	} as unknown as SessionCatalog;
	const registry = {
		run: vi.fn(async (_ref: SessionRef, run: (runtime: unknown) => Promise<unknown>) => await run(runtime)),
		has: vi.fn(() => true),
		withOpenRuntime: vi.fn(async (_sessionId: string, run: (runtime: unknown) => Promise<unknown>) => ({
			open: true,
			result: await run(runtime),
		})),
		withSessionsQuiesced: vi.fn(async (_ids: readonly string[], run: () => Promise<unknown>) => await run()),
		close: vi.fn(async () => undefined),
		assertClosed: vi.fn(),
	} as unknown as SessionRegistry;
	const subscriptionHub = {
		removeSession: vi.fn(),
		publishSessionUpdated: vi.fn(),
	} as unknown as SessionSubscriptions;
	const interactions = {
		assign: vi.fn(),
		release: vi.fn(),
		releaseSession: vi.fn(),
	} as unknown as InteractionBroker;
	const knowledge = { libraries: vi.fn(() => []) } as unknown as KnowledgeService;
	const archivedConversations = {
		list: vi.fn(async () => ({ sessions: [] })),
	} as unknown as ArchivedConversationCatalog;
	const scheduleManager = { markRunRead: vi.fn(async () => ({})) } as unknown as ScheduleManager;
	const connectionSubscriptions = {
		subscribe: vi.fn(async () => ({})),
		unsubscribe: vi.fn(),
	} as unknown as ConnectionSubscriptions;
	return {
		runtime,
		registry,
		context: {
			catalog,
			registry,
			subscriptionHub,
			interactions,
			knowledge,
			archivedConversations,
			scheduleManager,
			connectionSubscriptions,
			interactionPeer: { request: vi.fn(async () => ({})) } as unknown as InteractionPeer,
			allSessionRefs: () => [ref],
			runtimeRef: () => ref,
			hydrateScheduledSession: async () => ref,
			assertMutableSession: vi.fn(),
			allowRetainedScheduledDelete: async () => true,
			...replayTracker(),
		},
	};
}

function projectContext() {
	const catalog = {
		refreshProjectStorage: vi.fn(async (cwd: string) => cwd),
		projectSnapshot: vi.fn((cwd: string) => ({ cwd, refs: [], revision: 1 })),
		withProjectBlocked: vi.fn(async () => {
			throw new Error("project delete runs in integration tests");
		}),
	} as unknown as SessionCatalog;
	const scheduleManager = {
		countFixedWorkspaceTasks: vi.fn(() => 0),
		withNoFixedWorkspaceTasks: vi.fn(async (_cwd: string, run: () => Promise<unknown>) => await run()),
	} as unknown as ScheduleManager;
	const registry = {
		withSessionsQuiesced: vi.fn(async (_ids: readonly string[], run: () => Promise<unknown>) => await run()),
	} as unknown as SessionRegistry;
	const subscriptionHub = { invalidateProject: vi.fn(), removeSession: vi.fn() } as unknown as SessionSubscriptions;
	const interactions = { releaseSession: vi.fn() } as unknown as InteractionBroker;
	return {
		catalog,
		context: {
			catalog,
			registry,
			subscriptionHub,
			interactions,
			scheduleManager,
			...replayTracker(),
		},
	};
}

const DOMAINS = [
	{
		owns: (method: string) => method.startsWith("profile/") || method.startsWith("usage/"),
		recognized: isProfileRequest,
		dispatch: dispatchProfileRequest,
		context: profileContext,
	},
	{
		owns: (method: string) => method.startsWith("personalization/"),
		recognized: isPersonalizationRequest,
		dispatch: dispatchPersonalizationRequest,
		context: personalizationContext,
	},
	{
		owns: (method: string) => method.startsWith("hooks/"),
		recognized: isHooksRequest,
		dispatch: dispatchHooksRequest,
		context: hooksContext,
	},
	{
		owns: (method: string) => method.startsWith("webSearch/"),
		recognized: isWebSearchRequest,
		dispatch: dispatchWebSearchRequest,
		context: webSearchContext,
	},
	{
		owns: (method: string) => method.startsWith("agentType/"),
		recognized: isAgentTypeRequest,
		dispatch: dispatchAgentTypeRequest,
		context: agentTypeContext,
	},
	{
		owns: (method: string) => method.startsWith("skill/"),
		recognized: isSkillsRequest,
		dispatch: dispatchSkillsRequest,
		context: skillsContext,
	},
	{
		owns: (method: string) => method.startsWith("plan/"),
		recognized: isPlanRequest,
		dispatch: dispatchPlanRequest,
		context: planContext,
	},
	{
		owns: (method: string) => method.startsWith("mcp/"),
		recognized: isMcpRequest,
		dispatch: dispatchMcpRequest,
		context: mcpContext,
	},
	{
		owns: (method: string) => method.startsWith("memory/"),
		recognized: isMemoryRequest,
		dispatch: dispatchMemoryRequest,
		context: memoryContext,
	},
	{
		owns: (method: string) => method.startsWith("model/"),
		recognized: isModelRequest,
		dispatch: dispatchModelRequest,
		context: modelContext,
	},
	{
		owns: (method: string) => method.startsWith("permission/"),
		recognized: isPermissionRequest,
		dispatch: dispatchPermissionRequest,
		context: permissionContext,
	},
	{
		owns: (method: string) => method.startsWith("plugin/"),
		recognized: isPluginsRequest,
		dispatch: dispatchPluginsRequest,
		context: pluginsContext,
	},
	{
		owns: (method: string) => method.startsWith("agent/"),
		recognized: isAgentsRequest,
		dispatch: dispatchAgentsRequest,
		context: agentsContext,
	},
	{
		owns: (method: string) => method.startsWith("schedule/"),
		recognized: isScheduleRequest,
		dispatch: dispatchScheduleRequest,
		context: scheduleContext,
	},
	{
		owns: (method: string) => method.startsWith("session/"),
		recognized: isSessionsRequest,
		dispatch: dispatchSessionsRequest,
		context: sessionsContext,
	},
	{
		owns: (method: string) => method.startsWith("project/"),
		recognized: isProjectRequest,
		dispatch: dispatchProjectRequest,
		context: projectContext,
	},
	{
		owns: (method: string) => method.startsWith("turn/"),
		recognized: isTurnsRequest,
		dispatch: dispatchTurnsRequest,
		context: turnsContext,
	},
] as const;

describe("dispatcher domain matrix", () => {
	it("every extracted prefix recognizes exactly the protocol methods it owns", () => {
		const methods = Object.keys(ClientRequestMethods);
		for (const domain of DOMAINS) {
			const owned = methods.filter((method) => domain.owns(method));
			expect(owned.length).toBeGreaterThan(0);
			for (const method of methods) {
				expect(domain.recognized(request(method))).toBe(domain.owns(method));
			}
		}
	});

	it("every protocol method in an extracted domain is handled by its module", async () => {
		for (const domain of DOMAINS) {
			const built = domain.context();
			for (const method of Object.keys(ClientRequestMethods)) {
				if (!domain.owns(method)) continue;
				// The matrix only proves routing: handlers may legitimately reject
				// empty params, but must never fall through as "Unhandled".
				let error: unknown;
				try {
					await domain.dispatch(request(method), built.context as never);
				} catch (dispatchError) {
					error = dispatchError;
				}
				expect(String(error instanceof Error ? error.message : error)).not.toMatch(/^Unhandled /);
			}
		}
	});

	it("delegates profile and usage requests with the session refs", async () => {
		const { refs, profileSummary, context } = profileContext();
		await expect(dispatchProfileRequest(request("profile/get"), context)).resolves.toEqual({ sessions: 1 });
		await expect(dispatchProfileRequest(request("usage/get", { rangeDays: 7 }), context)).resolves.toEqual({
			sessions: 1,
		});
		expect(profileSummary.summarize).toHaveBeenCalledWith(refs);
		expect(profileSummary.usage).toHaveBeenCalledWith(refs, 7);
	});

	it("routes personalization, hooks and web search mutations through replay", async () => {
		const personalization = personalizationContext();
		await dispatchPersonalizationRequest(
			request("personalization/update", { language: "en" }),
			personalization.context,
		);
		expect(personalization.personalization.update).toHaveBeenCalledWith({ language: "en" });
		expect(personalization.context.mutations).toEqual(["personalization/update"]);

		const hooks = hooksContext();
		await dispatchHooksRequest(request("hooks/upsert", { name: "lint" }), hooks.context);
		await dispatchHooksRequest(request("hooks/delete", { name: "lint" }), hooks.context);
		expect(hooks.context.mutations).toEqual(["hooks/upsert", "hooks/delete"]);

		const webSearch = webSearchContext();
		await dispatchWebSearchRequest(request("webSearch/update", { provider: "tavily" }), webSearch.context);
		expect(webSearch.webSearch.update).toHaveBeenCalledWith({ provider: "tavily" });
		expect(webSearch.refreshOpenWebSearchSettings).toHaveBeenCalledOnce();
		expect(webSearch.context.mutations).toEqual(["webSearch/update"]);
	});

	it("routes skill reads by scope and skill mutations through replay", async () => {
		const skills = skillsContext();
		await dispatchSkillsRequest(request("skill/list", { cwd: "/work" }), skills.context);
		await dispatchSkillsRequest(request("skill/list", { sessionId: "s1" }), skills.context);
		await dispatchSkillsRequest(request("skill/upsert", { name: "lint" }), skills.context);
		await dispatchSkillsRequest(request("skill/import", { source: "git" }), skills.context);
		expect(skills.registry.listDraftSkills).toHaveBeenCalledWith("/work");
		expect(skills.runtime.listSkills).toHaveBeenCalledOnce();
		expect(skills.context.mutations).toEqual(["skill/upsert", "skill/import"]);
	});

	it("runs plan mutations through replay and the session runtime", async () => {
		const plan = planContext();
		await dispatchPlanRequest(request("plan/startExecution", { sessionId: "s1" }), plan.context);
		await dispatchPlanRequest(request("plan/cancel", { sessionId: "s1" }), plan.context);
		expect(plan.runtime.startPlanExecution).toHaveBeenCalledOnce();
		expect(plan.runtime.cancelPlan).toHaveBeenCalledOnce();
		expect(plan.context.mutations).toEqual(["plan/startExecution", "plan/cancel"]);
	});

	it("keeps agent-type mutations replay-routed and reads direct", async () => {
		const agentTypes = agentTypeContext();
		await dispatchAgentTypeRequest(request("agentType/list"), agentTypes.context);
		await dispatchAgentTypeRequest(request("agentType/upsert", { id: "a" }), agentTypes.context);
		await dispatchAgentTypeRequest(request("agentType/remove", { id: "a" }), agentTypes.context);
		expect(agentTypes.context.mutations).toEqual(["agentType/upsert", "agentType/remove"]);
		expect(agentTypes.registry.listAgentTypes).toHaveBeenCalledOnce();
	});
	it("scopes MCP reads and routes MCP mutations through replay", async () => {
		const mcp = mcpContext();
		await dispatchMcpRequest(request("mcp/list", { cwd: "/work" }), mcp.context);
		await dispatchMcpRequest(request("mcp/list", { sessionId: "s1" }), mcp.context);
		await dispatchMcpRequest(request("mcp/upsert", { sessionId: "s1", name: "server" }), mcp.context);
		expect(mcp.registry.listDraftMcpServers).toHaveBeenCalledWith("/work");
		expect(mcp.runtime.listMcpServers).toHaveBeenCalledOnce();
		expect(mcp.context.mutations).toEqual(["mcp/upsert"]);
	});

	it("applies the memory settings mutation lock and refresh", async () => {
		const memory = memoryContext();
		await dispatchMemoryRequest(request("memory/update", { toolset: "all" }), memory.context);
		expect(memory.memorySettings.update).toHaveBeenCalledWith({ toolset: "all" });
		expect(memory.release).toHaveBeenCalledOnce();
		expect(memory.dropRuntimeSubscriptions).toHaveBeenCalledWith(["s1"]);
	});

	it("lists sorted models and refreshes permission auto settings on reviewer changes", async () => {
		const model = modelContext();
		await expect(dispatchModelRequest(request("model/list"), model.context)).resolves.toEqual({
			models: [
				{ provider: "p1", modelId: "m1", name: "Alpha" },
				{ provider: "p2", modelId: "m2", name: "Zeta" },
			],
		});
		await dispatchModelRequest(
			request("model/settings/update", { mutation: { type: "set_permission_reviewer" } }),
			model.context,
		);
		expect(model.dropRuntimeSubscriptions).toHaveBeenCalledWith(["s1"]);
	});

	it("merges the project permission scope preview and notifies rule changes", async () => {
		const permission = permissionContext();
		await expect(
			dispatchPermissionRequest(request("permission/rules/list", { sessionId: "s1" }), permission.context),
		).resolves.toEqual({
			scope: "project",
			rules: [],
			scopePreview: { scope: "workspace" },
		});
		await dispatchPermissionRequest(request("permission/auto/update", { mode: "ask" }), permission.context);
		await dispatchPermissionRequest(request("permission/rules/clear", { sessionId: "s1" }), permission.context);
		expect(permission.context.mutations).toEqual(["permission/auto/update", "permission/rules/clear"]);
		expect(permission.registry.notifyOpenPermissionRulesChanged).toHaveBeenCalledOnce();
	});
	it("routes plugin mutations through replay and merges activation state", async () => {
		const plugins = pluginsContext();
		await dispatchPluginsRequest(request("plugin/market/add", { url: "https://example.test" }), plugins.context);
		await dispatchPluginsRequest(request("plugin/install", { pluginId: "p1" }), plugins.context);
		await dispatchPluginsRequest(request("plugin/list"), plugins.context);
		expect(plugins.plugins.addMarket).toHaveBeenCalledWith({ url: "https://example.test" });
		expect(plugins.plugins.install).toHaveBeenCalledWith({ pluginId: "p1" });
		expect(plugins.plugins.listInstalled).toHaveBeenCalledOnce();
		expect(plugins.context.mutations).toEqual(["plugin/market/add", "plugin/install"]);
	});
	it("subscribes open agent runtimes and falls back to catalog reads", async () => {
		const agents = agentsContext();
		await dispatchAgentsRequest(request("agent/readItems", { sessionId: "s1" }), agents.context);
		await dispatchAgentsRequest(request("agent/send", { sessionId: "s1", message: "hi" }), agents.context);
		expect(agents.registry.withOpenRuntime).toHaveBeenCalledOnce();
		expect(agents.runtime.readAgentItems).toHaveBeenCalledOnce();
		expect(agents.runtime.sendAgentMessage).toHaveBeenCalledWith({ sessionId: "s1", message: "hi" });
		expect(agents.context.mutations).toEqual(["agent/send"]);
	});

	it("starts turns through the runtime and keeps the title job hook", async () => {
		const turns = turnsContext();
		await dispatchTurnsRequest(request("turn/start", { sessionId: "s1", text: "hello" }), turns.context);
		await dispatchTurnsRequest(request("turn/queue", { sessionId: "s1", text: "next" }), turns.context);
		expect(turns.runtime.startTurn).toHaveBeenCalledWith({ sessionId: "s1", text: "hello" });
		expect(turns.runtime.queueTurn).toHaveBeenCalledWith({ sessionId: "s1", text: "next" });
		expect(turns.context.mutations).toEqual(["turn/start", "turn/queue"]);
		expect(turns.startTitleJob).not.toHaveBeenCalled();
	});
	it("lists schedules and routes schedule mutations through replay", async () => {
		const schedule = scheduleContext();
		await dispatchScheduleRequest(request("schedule/list", {}), schedule.context);
		await dispatchScheduleRequest(request("schedule/run/list", { taskId: "t1" }), schedule.context);
		await dispatchScheduleRequest(
			request("schedule/delete", { taskId: "t1", deleteSessions: false }),
			schedule.context,
		);
		expect(schedule.scheduleManager.list).toHaveBeenCalledOnce();
		expect(schedule.scheduleManager.listRuns).toHaveBeenCalledWith("t1", {});
		expect(schedule.scheduleManager.delete).toHaveBeenCalledWith("t1", { deleteSessions: false });
		expect(schedule.context.mutations).toEqual(["schedule/delete"]);
	});
	it("reads session status and goals through the open runtime", async () => {
		const sessions = sessionsContext();
		await expect(
			dispatchSessionsRequest(request("session/status", { sessionId: "s1" }), sessions.context),
		).resolves.toEqual({ state: "idle", input: { sessionId: "s1" } });
		await dispatchSessionsRequest(request("session/goal/get", { sessionId: "s1" }), sessions.context);
		expect(sessions.registry.run).toHaveBeenCalledTimes(2);
	});
	it("reports cwd-wide deletion previews with the blocking task count", async () => {
		const project = projectContext();
		await expect(
			dispatchProjectRequest(request("project/deletePreview", { cwd: "/work" }), project.context),
		).resolves.toEqual({
			cwd: "/work",
			sessionCount: 0,
			blockingScheduleCount: 0,
			revision: 1,
		});
	});
});
