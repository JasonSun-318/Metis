import type { ClientParams, ClientRequestMethod, ClientResult } from "@metis/app-protocol";

type ForwardingMethod = Exclude<ClientRequestMethod, "initialize">;
type ForwardingInputMode = "none" | "optional" | "required";

interface ForwardingSpec {
	readonly channel: string;
	readonly method: ForwardingMethod;
	readonly input: ForwardingInputMode;
}

export interface DesktopRpcIpcFailure {
	readonly kind: "metis-rpc-failure-v1";
	readonly error: { readonly code: number; readonly message: string };
}

export function desktopRpcIpcFailure(code: number, message: string): DesktopRpcIpcFailure {
	return { kind: "metis-rpc-failure-v1", error: { code, message } };
}

export function unwrapDesktopRpcIpcResult(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "metis-rpc-failure-v1") {
		return value;
	}
	if (
		!("error" in value) ||
		typeof value.error !== "object" ||
		value.error === null ||
		!("code" in value.error) ||
		typeof value.error.code !== "number" ||
		!Number.isFinite(value.error.code) ||
		!("message" in value.error) ||
		typeof value.error.message !== "string"
	) {
		throw new TypeError("Invalid desktop RPC failure envelope");
	}
	const error = new Error(value.error.message);
	error.name = "MetisRpcError";
	Object.defineProperty(error, "code", { value: value.error.code, enumerable: true });
	throw error;
}

export const DESKTOP_RPC_FORWARDING = {
	listKnowledgeLibraries: { channel: "metis:list-knowledge-libraries", method: "knowledge/list", input: "none" },
	registerKnowledgeLibrary: {
		channel: "metis:register-knowledge-library",
		method: "knowledge/register",
		input: "required",
	},
	removeKnowledgeLibrary: { channel: "metis:remove-knowledge-library", method: "knowledge/remove", input: "required" },
	scanKnowledgeLibrary: { channel: "metis:scan-knowledge-library", method: "knowledge/scan", input: "required" },
	readKnowledgeNote: { channel: "metis:read-knowledge-note", method: "knowledge/read", input: "required" },
	resolveKnowledgeResource: {
		channel: "metis:resolve-knowledge-resource",
		method: "knowledge/resource/resolve",
		input: "required",
	},
	getSessionKnowledge: { channel: "metis:get-session-knowledge", method: "session/knowledge/get", input: "required" },
	setSessionKnowledge: { channel: "metis:set-session-knowledge", method: "session/knowledge/set", input: "required" },
	listSessions: { channel: "metis:list-sessions", method: "session/list", input: "optional" },
	listSkills: { channel: "metis:list-skills", method: "skill/list", input: "required" },
	getSkill: { channel: "metis:get-skill", method: "skill/get", input: "required" },
	upsertSkill: { channel: "metis:upsert-skill", method: "skill/upsert", input: "required" },
	removeSkill: { channel: "metis:remove-skill", method: "skill/remove", input: "required" },
	inspectSkillImport: {
		channel: "metis:inspect-skill-import",
		method: "skill/import/inspect",
		input: "required",
	},
	importSkills: { channel: "metis:import-skills", method: "skill/import", input: "required" },
	listMcpServers: { channel: "metis:list-mcp-servers", method: "mcp/list", input: "required" },
	inspectMcpImport: {
		channel: "metis:inspect-mcp-import",
		method: "mcp/import/inspect",
		input: "required",
	},
	importMcpServers: { channel: "metis:import-mcp-servers", method: "mcp/import", input: "required" },
	getMcpServer: { channel: "metis:get-mcp-server", method: "mcp/get", input: "required" },
	getMcpCatalogItem: {
		channel: "metis:get-mcp-catalog-item",
		method: "mcp/catalog/get",
		input: "required",
	},
	upsertMcpServer: { channel: "metis:upsert-mcp-server", method: "mcp/upsert", input: "required" },
	removeMcpServer: { channel: "metis:remove-mcp-server", method: "mcp/remove", input: "required" },
	restartMcpServer: { channel: "metis:restart-mcp-server", method: "mcp/restart", input: "required" },
	setMcpCredential: {
		channel: "metis:set-mcp-credential",
		method: "mcp/credential/set",
		input: "required",
	},
	clearMcpCredential: {
		channel: "metis:clear-mcp-credential",
		method: "mcp/credential/clear",
		input: "required",
	},
	getProfile: { channel: "metis:get-profile", method: "profile/get", input: "none" },
	listModels: { channel: "metis:list-models", method: "model/list", input: "none" },
	getModelSettings: { channel: "metis:get-model-settings", method: "model/settings/get", input: "none" },
	updateModelSettings: {
		channel: "metis:update-model-settings",
		method: "model/settings/update",
		input: "required",
	},
	discoverModels: { channel: "metis:discover-models", method: "model/discover", input: "required" },
	getPersonalization: { channel: "metis:get-personalization", method: "personalization/get", input: "none" },
	updatePersonalization: {
		channel: "metis:update-personalization",
		method: "personalization/update",
		input: "required",
	},
	getWebSearchSettings: { channel: "metis:get-web-search-settings", method: "webSearch/get", input: "none" },
	revealWebSearchCredential: {
		channel: "metis:reveal-web-search-credential",
		method: "webSearch/credential/reveal",
		input: "required",
	},
	updateWebSearchSettings: {
		channel: "metis:update-web-search-settings",
		method: "webSearch/update",
		input: "required",
	},
	getMemorySettings: { channel: "metis:get-memory-settings", method: "memory/get", input: "optional" },
	updateMemorySettings: {
		channel: "metis:update-memory-settings",
		method: "memory/update",
		input: "required",
	},
	listMemoryNotes: {
		channel: "metis:list-memory-notes",
		method: "memory/notes/list",
		input: "optional",
	},
	readMemoryNote: {
		channel: "metis:read-memory-note",
		method: "memory/notes/read",
		input: "required",
	},
	writeMemoryNote: {
		channel: "metis:write-memory-note",
		method: "memory/notes/write",
		input: "required",
	},
	listMemoryHistory: {
		channel: "metis:list-memory-history",
		method: "memory/history/list",
		input: "optional",
	},
	readMemoryHistory: {
		channel: "metis:read-memory-history",
		method: "memory/history/read",
		input: "required",
	},
	undoMemoryChange: { channel: "metis:undo-memory-change", method: "memory/undo", input: "required" },
	undoMemoryRun: { channel: "metis:undo-memory-run", method: "memory/undoRun", input: "required" },
	runMemoryDream: { channel: "metis:run-memory-dream", method: "memory/dream/run", input: "none" },
	listHooks: { channel: "metis:list-hooks", method: "hooks/list", input: "none" },
	upsertHook: { channel: "metis:upsert-hook", method: "hooks/upsert", input: "required" },
	deleteHook: { channel: "metis:delete-hook", method: "hooks/delete", input: "required" },
	testModelConnection: {
		channel: "metis:test-model-connection",
		method: "model/testConnection",
		input: "required",
	},
	getUsage: { channel: "metis:get-usage", method: "usage/get", input: "required" },
	createSchedule: { channel: "metis:create-schedule", method: "schedule/create", input: "required" },
	listSchedules: { channel: "metis:list-schedules", method: "schedule/list", input: "optional" },
	getSchedule: { channel: "metis:get-schedule", method: "schedule/get", input: "required" },
	updateSchedule: { channel: "metis:update-schedule", method: "schedule/update", input: "required" },
	pauseSchedule: { channel: "metis:pause-schedule", method: "schedule/pause", input: "required" },
	resumeSchedule: { channel: "metis:resume-schedule", method: "schedule/resume", input: "required" },
	deleteSchedule: { channel: "metis:delete-schedule", method: "schedule/delete", input: "required" },
	runScheduleNow: { channel: "metis:run-schedule-now", method: "schedule/run-now", input: "required" },
	listScheduleRuns: {
		channel: "metis:list-schedule-runs",
		method: "schedule/run/list",
		input: "required",
	},
	getScheduleRun: { channel: "metis:get-schedule-run", method: "schedule/run/get", input: "required" },
	markScheduleRunRead: {
		channel: "metis:mark-schedule-run-read",
		method: "schedule/run/mark-read",
		input: "required",
	},
	createSession: { channel: "metis:create-session", method: "session/create", input: "required" },
	renameSession: { channel: "metis:rename-session", method: "session/rename", input: "required" },
	forkSession: { channel: "metis:fork-session", method: "session/fork", input: "required" },
	markSessionRead: { channel: "metis:mark-session-read", method: "session/markRead", input: "required" },
	readItems: { channel: "metis:read-items", method: "session/readItems", input: "required" },
	readSessionImage: { channel: "metis:read-session-image", method: "session/readImage", input: "required" },
	openDeliveredFile: {
		channel: "metis:open-delivered-file",
		method: "session/openDeliveredFile",
		input: "required",
	},
	getSessionStatus: { channel: "metis:get-session-status", method: "session/status", input: "required" },
	compactSession: { channel: "metis:compact-session", method: "session/compact", input: "required" },
	setSessionGoal: { channel: "metis:set-session-goal", method: "session/goal/set", input: "required" },
	clearSessionGoal: { channel: "metis:clear-session-goal", method: "session/goal/clear", input: "required" },
	listAgents: { channel: "metis:list-agents", method: "agent/list", input: "required" },
	readAgentItems: { channel: "metis:read-agent-items", method: "agent/readItems", input: "required" },
	sendAgentMessage: { channel: "metis:send-agent-message", method: "agent/send", input: "required" },
	readAgentQueuedMessages: {
		channel: "metis:read-agent-queued-messages",
		method: "agent/queue/read",
		input: "required",
	},
	deleteAgentQueuedMessage: {
		channel: "metis:delete-agent-queued-message",
		method: "agent/queue/delete",
		input: "required",
	},
	sendAgentQueuedMessage: {
		channel: "metis:send-agent-queued-message",
		method: "agent/queue/send",
		input: "required",
	},
	controlAgent: { channel: "metis:control-agent", method: "agent/control", input: "required" },
	interruptAgent: { channel: "metis:interrupt-agent", method: "agent/interrupt", input: "required" },
	archiveAgent: { channel: "metis:archive-agent", method: "agent/archive", input: "required" },
	deleteAgent: { channel: "metis:delete-agent", method: "agent/delete", input: "required" },
	listAgentTypes: { channel: "metis:list-agent-types", method: "agentType/list", input: "none" },
	upsertAgentType: { channel: "metis:upsert-agent-type", method: "agentType/upsert", input: "required" },
	removeAgentType: { channel: "metis:remove-agent-type", method: "agentType/remove", input: "required" },
	setThinkingSelection: {
		channel: "metis:set-thinking-selection",
		method: "session/setThinkingSelection",
		input: "required",
	},
	setPermissionPreset: {
		channel: "metis:set-permission-preset",
		method: "session/setPermissionPreset",
		input: "required",
	},
	setSessionMemoryFlags: {
		channel: "metis:set-session-memory-flags",
		method: "session/setMemoryFlags",
		input: "required",
	},
	setCollaborationMode: {
		channel: "metis:set-collaboration-mode",
		method: "session/setCollaborationMode",
		input: "required",
	},
	startPlanExecution: {
		channel: "metis:start-plan-execution",
		method: "plan/startExecution",
		input: "required",
	},
	cancelPlan: { channel: "metis:cancel-plan", method: "plan/cancel", input: "required" },
	listPermissionRules: {
		channel: "metis:list-permission-rules",
		method: "permission/rules/list",
		input: "required",
	},
	deletePermissionRule: {
		channel: "metis:delete-permission-rule",
		method: "permission/rules/delete",
		input: "required",
	},
	clearPermissionRules: {
		channel: "metis:clear-permission-rules",
		method: "permission/rules/clear",
		input: "required",
	},
	getPermissionAutoSettings: {
		channel: "metis:get-permission-auto-settings",
		method: "permission/auto/get",
		input: "none",
	},
	updatePermissionAutoSettings: {
		channel: "metis:update-permission-auto-settings",
		method: "permission/auto/update",
		input: "required",
	},
	setModel: { channel: "metis:set-model", method: "session/setModel", input: "required" },
	startTurn: { channel: "metis:start-turn", method: "turn/start", input: "required" },
	steerTurn: { channel: "metis:steer-turn", method: "turn/steer", input: "required" },
	queueTurn: { channel: "metis:queue-turn", method: "turn/queue", input: "required" },
	updateQueuedTurn: { channel: "metis:update-queued-turn", method: "turn/queue/update", input: "required" },
	deleteQueuedTurn: { channel: "metis:delete-queued-turn", method: "turn/queue/delete", input: "required" },
	sendQueuedTurn: { channel: "metis:send-queued-turn", method: "turn/queue/send", input: "required" },
	listPluginMarkets: { channel: "metis:list-plugin-markets", method: "plugin/market/list", input: "none" },
	addPluginMarket: { channel: "metis:add-plugin-market", method: "plugin/market/add", input: "required" },
	selectPluginMarket: { channel: "metis:select-plugin-market", method: "plugin/market/select", input: "required" },
	removePluginMarket: { channel: "metis:remove-plugin-market", method: "plugin/market/remove", input: "required" },
	refreshPluginMarket: { channel: "metis:refresh-plugin-market", method: "plugin/market/refresh", input: "required" },
	getPluginCatalog: { channel: "metis:get-plugin-catalog", method: "plugin/catalog", input: "required" },
	inspectPlugin: { channel: "metis:inspect-plugin", method: "plugin/inspect", input: "required" },
	installPlugin: { channel: "metis:install-plugin", method: "plugin/install", input: "required" },
	listInstalledPlugins: { channel: "metis:list-installed-plugins", method: "plugin/list", input: "none" },
	getInstalledPlugin: { channel: "metis:get-installed-plugin", method: "plugin/get", input: "required" },
	setPluginEnabled: { channel: "metis:set-plugin-enabled", method: "plugin/setEnabled", input: "required" },
	removePlugin: { channel: "metis:remove-plugin", method: "plugin/remove", input: "required" },
	inspectPluginUpdate: { channel: "metis:inspect-plugin-update", method: "plugin/update/inspect", input: "required" },
	updatePlugin: { channel: "metis:update-plugin", method: "plugin/update", input: "required" },
} as const satisfies Record<string, ForwardingSpec>;

export type DesktopRpcForwardingDefinition = (typeof DESKTOP_RPC_FORWARDING)[keyof typeof DESKTOP_RPC_FORWARDING];

type ForwardingFunction<Definition extends DesktopRpcForwardingDefinition> = Definition extends {
	readonly method: infer Method extends ForwardingMethod;
	readonly input: infer Input extends ForwardingInputMode;
}
	? Input extends "none"
		? () => Promise<ClientResult<Method>>
		: Input extends "optional"
			? (input?: ClientParams<Method>) => Promise<ClientResult<Method>>
			: (input: ClientParams<Method>) => Promise<ClientResult<Method>>
	: never;

export type DesktopRpcForwardingApi = {
	readonly [Name in keyof typeof DESKTOP_RPC_FORWARDING]: ForwardingFunction<(typeof DESKTOP_RPC_FORWARDING)[Name]>;
};

export const DESKTOP_RPC_FORWARDING_CHANNELS = Object.freeze(
	Object.fromEntries(Object.entries(DESKTOP_RPC_FORWARDING).map(([name, definition]) => [name, definition.channel])),
) as {
	readonly [Name in keyof typeof DESKTOP_RPC_FORWARDING]: (typeof DESKTOP_RPC_FORWARDING)[Name]["channel"];
};

export function createDesktopRpcForwarders(
	invoke: (definition: DesktopRpcForwardingDefinition, input: unknown) => Promise<unknown>,
): DesktopRpcForwardingApi {
	const api: Record<string, (input?: unknown) => Promise<unknown>> = {};
	for (const [name, definition] of Object.entries(DESKTOP_RPC_FORWARDING)) {
		const forward = async (input: unknown) => unwrapDesktopRpcIpcResult(await invoke(definition, input));
		if (definition.input === "none") api[name] = () => forward({});
		else if (definition.input === "optional") api[name] = (input = {}) => forward(input);
		else api[name] = (input) => forward(input);
	}
	return api as DesktopRpcForwardingApi;
}
