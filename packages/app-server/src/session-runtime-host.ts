import type {
	ClientParams,
	ClientResult,
	DomainEvent,
	ItemView,
	RpcErrorName,
	SessionSnapshot,
	SessionSummary,
} from "@metis/app-protocol";
import type { DurableSessionMutation, PreparedSessionMutation } from "./durable-mutation.ts";

export interface SessionRef {
	readonly path: string;
	readonly relativePath: string;
	readonly summary: SessionSummary;
	readonly storageUpdatedAt?: string;
	readonly scheduled?: { readonly taskId: string; readonly runId: string };
}

export type SessionEventListener = (event: DomainEvent) => void;

/** One opened runtime hidden behind app-server operations and projections. */
export interface OpenedSessionRuntime {
	readonly sessionId: string;
	isActive(): boolean;
	hasPendingInteractions(): boolean;
	getSummary(): SessionSummary;
	markRead(): Promise<SessionSummary>;
	renameSession(name: string): Promise<SessionSummary>;
	/** Create an independent branch session rooted at the given entry and return its session id. */
	fork(input: { entryId: string; name: string }): Promise<string>;
	listSkills(): Promise<ClientResult<"skill/list">>;
	listMcpServers(): Promise<ClientResult<"mcp/list">>;
	inspectMcpImport(input: ClientParams<"mcp/import/inspect">): Promise<ClientResult<"mcp/import/inspect">>;
	importMcpServers(input: ClientParams<"mcp/import">): Promise<ClientResult<"mcp/import">>;
	getMcpServer(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">>;
	getMcpCatalogItem(input: ClientParams<"mcp/catalog/get">): Promise<ClientResult<"mcp/catalog/get">>;
	upsertMcpServer(input: ClientParams<"mcp/upsert">): Promise<ClientResult<"mcp/upsert">>;
	removeMcpServer(input: ClientParams<"mcp/remove">): Promise<ClientResult<"mcp/remove">>;
	restartMcpServer(input: ClientParams<"mcp/restart">): Promise<ClientResult<"mcp/restart">>;
	setMcpCredential(input: ClientParams<"mcp/credential/set">): Promise<ClientResult<"mcp/credential/set">>;
	clearMcpCredential(input: ClientParams<"mcp/credential/clear">): Promise<ClientResult<"mcp/credential/clear">>;
	readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">>;
	readImage(input: ClientParams<"session/readImage">): Promise<ClientResult<"session/readImage">>;
	openDeliveredFile(
		input: ClientParams<"session/openDeliveredFile">,
	): Promise<ClientResult<"session/openDeliveredFile">>;
	readDeliveredFile(
		input: ClientParams<"session/readDeliveredFile">,
	): Promise<ClientResult<"session/readDeliveredFile">>;
	getStatus(input: ClientParams<"session/status">): Promise<ClientResult<"session/status">>;
	compact(input: ClientParams<"session/compact">): Promise<ClientResult<"session/compact">>;
	getGoal(input: ClientParams<"session/goal/get">): Promise<ClientResult<"session/goal/get">>;
	setGoal(input: ClientParams<"session/goal/set">): Promise<ClientResult<"session/goal/set">>;
	clearGoal(input: ClientParams<"session/goal/clear">): Promise<ClientResult<"session/goal/clear">>;
	readSubagentItems(input: ClientParams<"subagent/readItems">): Promise<ClientResult<"subagent/readItems">>;
	interruptSubagent(input: ClientParams<"subagent/interrupt">): Promise<ClientResult<"subagent/interrupt">>;
	setThinkingSelection(
		input: ClientParams<"session/setThinkingSelection">,
	): Promise<ClientResult<"session/setThinkingSelection">>;
	setPermissionMode(
		input: ClientParams<"session/setPermissionMode">,
	): Promise<ClientResult<"session/setPermissionMode">>;
	setModel(input: ClientParams<"session/setModel">): Promise<ClientResult<"session/setModel">>;
	refreshWebSearchSettings?(): Promise<void>;
	prepareModelServiceSettingsRefresh?(): Promise<void>;
	applyModelServiceSettingsRefresh?(): Promise<void>;
	snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot>;
	startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">>;
	steer(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">>;
	queueTurn(input: ClientParams<"turn/queue">): Promise<ClientResult<"turn/queue">>;
	updateQueuedTurn(input: ClientParams<"turn/queue/update">): Promise<ClientResult<"turn/queue/update">>;
	deleteQueuedTurn(input: ClientParams<"turn/queue/delete">): Promise<ClientResult<"turn/queue/delete">>;
	sendQueuedTurn(input: ClientParams<"turn/queue/send">): Promise<ClientResult<"turn/queue/send">>;
	interrupt(input: ClientParams<"turn/interrupt">): Promise<ClientResult<"turn/interrupt">>;
	prepareMutation(input: DurableSessionMutation): Promise<PreparedSessionMutation>;
	subscribe(listener: SessionEventListener): () => void;
	close(): Promise<void>;
}

/** Factory seam used by the registry; production and tests provide different hosts. */
export interface SessionRuntimeHost {
	open(ref: SessionRef): Promise<OpenedSessionRuntime>;
	listSkills?(cwd: string | null): Promise<ClientResult<"skill/list">>;
	getSkill?(input: ClientParams<"skill/get">): Promise<ClientResult<"skill/get">>;
	upsertSkill?(input: ClientParams<"skill/upsert">): Promise<ClientResult<"skill/upsert">>;
	removeSkill?(input: ClientParams<"skill/remove">): Promise<ClientResult<"skill/remove">>;
	inspectSkillImport?(input: ClientParams<"skill/import/inspect">): Promise<ClientResult<"skill/import/inspect">>;
	importSkills?(input: ClientParams<"skill/import">): Promise<ClientResult<"skill/import">>;
	listMcpServers?(cwd: string | null): Promise<ClientResult<"mcp/list">>;
	inspectMcpImport?(input: ClientParams<"mcp/import/inspect">): Promise<ClientResult<"mcp/import/inspect">>;
	importMcpServers?(input: ClientParams<"mcp/import">): Promise<ClientResult<"mcp/import">>;
	getMcpServer?(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">>;
	upsertMcpServer?(input: ClientParams<"mcp/upsert">): Promise<ClientResult<"mcp/upsert">>;
	removeMcpServer?(input: ClientParams<"mcp/remove">): Promise<ClientResult<"mcp/remove">>;
}

export class AppServerError extends Error {
	readonly code: RpcErrorName;
	readonly context: {
		requestId?: string;
		sessionId?: string;
		operationId?: string;
		interactionId?: string;
	};

	constructor(
		code: RpcErrorName,
		context: {
			requestId?: string;
			sessionId?: string;
			operationId?: string;
			interactionId?: string;
		} = {},
	) {
		super(code);
		this.name = "AppServerError";
		this.code = code;
		this.context = context;
	}
}

export function emptyItemPage(): { items: ItemView[]; nextBeforeItemId: null } {
	return { items: [], nextBeforeItemId: null };
}
