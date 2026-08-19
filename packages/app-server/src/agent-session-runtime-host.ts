import { createHash, randomUUID } from "node:crypto";
import {
	type ClientParams,
	type ClientResult,
	type DomainEvent,
	type DurableImageRefView,
	type ItemView,
	MAX_READ_IMAGE_DATA_UTF8_BYTES,
	type McpCredentialInput,
	type QueuedTurnView,
	type SessionDeliveredFileView,
	type SessionSnapshot,
	type SessionSummary,
	type TurnView,
} from "@metis/app-protocol";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type AuthCredential,
	type AuthStorage,
	type AuthStorageChange,
	buildChildSystemPrompt,
	type CreateAgentSessionRuntimeFactory,
	copySessionDeliveredFiles,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createAskUserToolDefinition,
	createDeliverFileToolDefinition,
	DefaultResourceLoader,
	formatSessionAttachments,
	getLatestCacheHitPercent,
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	importSessionAttachments,
	installScheduleHost,
	isScheduleSessionEligible,
	MAX_SESSION_DELIVERED_FILES,
	type McpCredentialIdentity,
	type McpServerSettings,
	mcpCredentialKey,
	mcpServerFingerprint,
	ProjectTrustStore,
	QueuedTurnBusyError,
	QueuedTurnConflictError,
	type QueuedTurnDraft,
	QueuedTurnLimitError,
	QueuedTurnNotFoundError,
	RequestIdReusedError,
	readThreadGoal,
	reduceRuntimeJournal,
	removeSessionAttachment,
	resolveMcpServerSettings,
	SCHEDULE_MAIN_PROMPT,
	type ScheduleManager,
	SessionManager,
	SettingsManager,
	type Skill,
	type SubagentSummary,
	splitSessionAttachmentPrompt,
} from "@metis/coding-agent";
import type { CredentialCoordinator } from "./credential-coordinator.ts";
import {
	type DurableSessionMutation,
	type PreparedSessionMutation,
	prepareSessionMutation,
} from "./durable-mutation.ts";
import type { InteractionBroker } from "./interactions.ts";
import {
	opaqueId,
	projectAllDeliveredFiles,
	projectAssistantOutputTokens,
	projectDeliveredFileFromToolResult,
	projectGoal,
	projectLatestTasks,
	projectLiveMessage as projectLiveItemMessage,
	projectMessageEntry,
	projectSessionEntry,
	projectTasksFromToolResult,
	timestamp,
} from "./item-projection.ts";
import { inspectMcpImport as inspectMcpImportSource, resolveMcpImport } from "./mcp-import.ts";
import {
	hasMatchingMcpCredential,
	inputMcpServer,
	mcpDefinitionAtScope,
	mcpRevision,
	publicMcpDetail,
	publicMcpServers,
} from "./mcp-projection.ts";
import { openDeliveredFile as openDeliveredFileOnDisk } from "./open-delivered-file.ts";
import { SessionProjection } from "./projection/session-projection.ts";
import { readDeliveredFile as readDeliveredFileOnDisk } from "./read-delivered-file.ts";
import {
	AppServerError,
	type OpenedSessionRuntime,
	type SessionEventListener,
	type SessionRef,
	type SessionRuntimeHost,
} from "./session-runtime-host.ts";
import {
	importSkills,
	inspectSkillImport,
	publicSkills,
	readSkillDetail,
	trashSkill,
	writeSkill,
} from "./skill-files.ts";
import { SubagentLiveProjector } from "./subagent-live-projector.ts";

const MAX_TURNS = 200;
type McpMutationRunner = <T>(mutation: () => Promise<T>) => Promise<T>;

function queuedTurnView(draft: QueuedTurnDraft): QueuedTurnView {
	const { text, attachments } = splitSessionAttachmentPrompt(draft.input.text);
	return {
		queueItemId: opaqueId(draft.queueItemId, "queue"),
		revision: opaqueId(draft.revision, "entry"),
		state: draft.state,
		text,
		attachments: attachments.map(({ name, size }) => ({ name, byteLength: size })),
	};
}

function throwQueuedTurnError(error: unknown, input: { sessionId: string; requestId: string }): never {
	const context = { sessionId: input.sessionId, requestId: input.requestId };
	if (error instanceof QueuedTurnNotFoundError) throw new AppServerError("NOT_FOUND", context);
	if (error instanceof QueuedTurnConflictError) throw new AppServerError("CONFLICT", context);
	if (error instanceof QueuedTurnBusyError) throw new AppServerError("BUSY", context);
	if (error instanceof QueuedTurnLimitError) throw new AppServerError("OVERLOADED", context);
	if (error instanceof RequestIdReusedError) throw new AppServerError("REQUEST_ID_REUSED", context);
	throw new AppServerError("OPERATION_FAILED", context);
}

function mcpCredentialIdentity(scope: "user" | "project", name: string, cwd: string): McpCredentialIdentity {
	return scope === "user" ? { scope, name } : { scope, name, cwd };
}

export interface McpDefinitionChange {
	readonly next: McpServerSettings | undefined;
	readonly previous: McpServerSettings | undefined;
	readonly credential?: McpCredentialInput;
}

async function flushMcpSettings(settingsManager: SettingsManager): Promise<void> {
	await settingsManager.flush();
	const failure = settingsManager.drainErrors()[0];
	if (failure) throw failure.error;
}

export async function persistMcpChanges(options: {
	readonly settingsManager: SettingsManager;
	readonly authStorage?: AuthStorage;
	readonly cwd: string;
	readonly scope: "user" | "project";
	readonly changes: ReadonlyMap<string, McpDefinitionChange>;
	readonly reload?: () => Promise<void>;
}): Promise<void> {
	const { settingsManager, authStorage, cwd, scope, changes, reload } = options;
	const settingsScope = scope === "user" ? "global" : "project";
	const definitionChanges = new Map([...changes].map(([name, change]) => [name, change.next]));
	const rollbackDefinitions = new Map([...changes].map(([name, change]) => [name, change.previous]));
	const authChanges: AuthStorageChange[] = [];
	const rollbackCredentials: AuthStorageChange[] = [];
	const pendingSettingsFailure = settingsManager.drainErrors()[0];
	if (pendingSettingsFailure) throw pendingSettingsFailure.error;

	for (const [name, change] of changes) {
		const identity = mcpCredentialIdentity(scope, name, cwd);
		const key = mcpCredentialKey(identity);
		const previousCredential = authStorage?.get(key);
		let nextCredential: AuthCredential | undefined;
		if (change.next && change.credential) {
			if (!authStorage || (change.credential.bearerToken && typeof change.next.url !== "string")) {
				throw new Error("Invalid MCP credential for server transport");
			}
			nextCredential = {
				type: "mcp_secret",
				...(change.credential.bearerToken ? { bearerToken: change.credential.bearerToken } : {}),
				...(change.credential.environment ? { env: { ...change.credential.environment } } : {}),
				serverFingerprint: mcpServerFingerprint(
					resolveMcpServerSettings(name, change.next, cwd, process.env, identity),
				),
			};
		} else if (change.next && previousCredential?.type === "mcp_secret") {
			const fingerprint = mcpServerFingerprint(
				resolveMcpServerSettings(name, change.next, cwd, process.env, identity),
			);
			if (previousCredential.serverFingerprint === fingerprint) continue;
		}
		if (previousCredential === undefined && nextCredential === undefined) continue;
		authChanges.push({ provider: key, credential: nextCredential });
		rollbackCredentials.push({
			provider: key,
			credential: previousCredential && structuredClone(previousCredential),
		});
	}

	try {
		settingsManager.applyMcpServerChanges(settingsScope, definitionChanges);
		await flushMcpSettings(settingsManager);
		if (authChanges.length) authStorage!.applyChanges(authChanges);
		await reload?.();
	} catch (error) {
		try {
			settingsManager.applyMcpServerChanges(settingsScope, rollbackDefinitions);
			await flushMcpSettings(settingsManager);
			if (rollbackCredentials.length) authStorage?.applyChanges(rollbackCredentials);
			await reload?.();
		} catch {
			// Preserve the initiating failure; recovery is best effort.
		}
		throw error;
	}
}

export interface AgentSessionRuntimeHostOptions {
	readonly agentDir: string;
	readonly interactions?: InteractionBroker;
	readonly credentials?: CredentialCoordinator;
	readonly scheduleManager?: ScheduleManager;
}

function name(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 256);
	return normalized.length > 0 ? normalized : fallback;
}

function optionalName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 256);
	return normalized.length > 0 ? normalized : undefined;
}

function completedTurnHasVisibleAssistantText(journal: readonly unknown[], turnId: string): boolean {
	for (const candidate of journal) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const entry = candidate as Record<string, unknown>;
		if (entry.type !== "message" || entry.turnId !== turnId || typeof entry.message !== "object" || !entry.message) {
			continue;
		}
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string" && message.content.trim()) return true;
		if (
			Array.isArray(message.content) &&
			message.content.some(
				(block) =>
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string" &&
					(block as { text: string }).text.trim().length > 0,
			)
		) {
			return true;
		}
	}
	return false;
}

function subagentView(summary: SubagentSummary): SessionSnapshot["subagents"][number] {
	const { configuration, ...rest } = summary;
	if (summary.status === "closed") {
		return {
			agentId: summary.agentId,
			name: summary.name,
			status: "closed",
			taskSummary: summary.taskSummary,
			...(summary.finalSummary ? { finalSummary: summary.finalSummary } : {}),
			createdAt: summary.createdAt,
			updatedAt: summary.updatedAt,
		};
	}
	if (!configuration) throw new Error(`Active subagent is missing configuration: ${summary.agentId}`);
	return {
		...rest,
		configuration: {
			...configuration,
			tools: [...configuration.tools],
		},
	};
}

function mapRuntimeTurns(
	journal: readonly unknown[],
	reduced: ReturnType<typeof reduceRuntimeJournal>,
	sessionId: string,
	fallbackTimestamp: string,
): TurnView[] {
	const times = new Map<string, { startedAt: string; completedAt?: string }>();
	for (const entry of journal) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "runtime_turn" || typeof record.turnId !== "string") continue;
		const at = timestamp(record.timestamp, fallbackTimestamp);
		const current = times.get(record.turnId) ?? { startedAt: at };
		if (record.state === "completed" || record.state === "interrupted") current.completedAt = at;
		times.set(record.turnId, current);
	}
	return reduced.turns.slice(-MAX_TURNS).map((turn) => {
		const at = times.get(turn.turnId) ?? { startedAt: fallbackTimestamp };
		return {
			turnId: opaqueId(turn.turnId, "turn"),
			sessionId,
			operationIds: [...new Set(turn.operationIds.map((id) => opaqueId(id, "operation")))].slice(-256),
			state: turn.state === "active" ? "running" : turn.state,
			startedAt: at.startedAt,
			...(at.completedAt === undefined ? {} : { completedAt: at.completedAt }),
		};
	});
}

class OpenedAgentSessionRuntime implements OpenedSessionRuntime {
	private readonly listeners = new Set<SessionEventListener>();
	private readonly runtime: AgentSessionRuntime;
	private session: AgentSession;
	private readonly ref: SessionRef;
	private readonly projection: SessionProjection;
	private readonly subagentLive: SubagentLiveProjector;
	private readonly liveItemIds = new WeakMap<object, string>();
	private readonly liveMessagesByItemId = new Map<string, object>();
	private liveAssistantItemId?: string;
	private readonly projectedTurnStates = new Map<string, TurnView["state"]>();
	private liveItemSequence = 0;
	private unsubscribeAgent?: () => void;
	private unsubscribeSubagents?: () => void;
	private unsubscribeQueuedTurns?: () => void;
	private closed = false;
	private closePromise?: Promise<void>;
	private readonly interactions?: InteractionBroker;
	private readonly agentDir: string;
	private readonly authStorage?: AuthStorage;
	private readonly mutateMcp: McpMutationRunner;
	private unread: boolean;
	private readonly notifiedQueueFailureRevisions = new Set<string>();
	private deliveredFiles: SessionDeliveredFileView[];

	constructor(
		runtime: AgentSessionRuntime,
		ref: SessionRef,
		agentDir: string,
		interactions?: InteractionBroker,
		authStorage?: AuthStorage,
		mutateMcp: McpMutationRunner = (mutation) => mutation(),
	) {
		this.runtime = runtime;
		this.session = runtime.session;
		this.ref = ref;
		this.agentDir = agentDir;
		this.interactions = interactions;
		this.authStorage = authStorage;
		this.mutateMcp = mutateMcp;
		this.unread = ref.summary.unread;
		const journal = this.journal();
		const reduced = reduceRuntimeJournal(journal);
		const items = this.itemsFromJournal(journal, reduced);
		const turns = this.turnsFromJournal(journal, reduced);
		for (const turn of turns) this.projectedTurnStates.set(turn.turnId, turn.state);
		const queuedTurns = this.runtime.queuedTurns;
		for (const turn of queuedTurns) {
			if (turn.state === "paused" && turn.reason === "delivery_failed") {
				this.notifiedQueueFailureRevisions.add(turn.revision);
			}
		}
		this.deliveredFiles = projectAllDeliveredFiles(this.session.sessionManager.getBranch());
		this.projection = new SessionProjection({
			session: this.summaryFromRuntime(journal, reduced),
			turns,
			items,
			tasks: projectLatestTasks(this.session.sessionManager.getBranch()),
			deliveredFiles: this.deliveredFiles,
			goal: projectGoal(this.session.getGoal()),
			queuedTurns: queuedTurns.map(queuedTurnView),
		});
		this.subagentLive = new SubagentLiveProjector(
			this.sessionId,
			(event) => this.publish(event),
			this.ref.summary.updatedAt,
		);
		this.bind(this.session);
		this.unsubscribeQueuedTurns = this.runtime.subscribeQueuedTurns((turns) => {
			this.publish({
				type: "turn/queueChanged",
				sessionId: this.sessionId,
				queuedTurns: turns.map(queuedTurnView),
			});
			for (const turn of turns) {
				if (
					turn.state !== "paused" ||
					turn.reason !== "delivery_failed" ||
					this.notifiedQueueFailureRevisions.has(turn.revision)
				)
					continue;
				this.notifiedQueueFailureRevisions.add(turn.revision);
				this.publish({
					type: "interaction/notify",
					notificationId: randomUUID(),
					sessionId: this.sessionId,
					level: "error",
					message: "A queued message could not be started and remains paused.",
					createdAt: new Date().toISOString(),
				});
			}
		});
	}

	async initialize(): Promise<void> {
		await this.bindExtensionUI(this.session);
		this.runtime.setRebindSession(async (session) => {
			this.bind(session);
			await this.bindExtensionUI(session);
		});
	}

	private async bindExtensionUI(session: AgentSession): Promise<void> {
		const uiContext = this.interactions?.createExtensionUIContext(this.sessionId, (event) => this.publish(event));
		if (this.interactions) {
			session.installHostTools(
				[
					createAskUserToolDefinition((request) => this.interactions!.requestUserInput(this.sessionId, request)),
					createDeliverFileToolDefinition(() => ({
						cwd: session.sessionManager.getCwd(),
						agentDir: this.agentDir,
						sessionId: this.sessionId,
						additionalDirectories: session.sessionManager.getAdditionalDirectories(),
						activeDeliveredFileCount: this.deliveredFiles.length,
					})),
				] as never,
				{ automaticPermissionToolNames: ["ask_user", "deliver_file"] },
			);
		}
		session.setPermissionApprovalHandler((request) =>
			this.interactions
				? this.interactions.requestPermissionApproval(this.sessionId, request)
				: Promise.resolve({ decision: "deny", reason: "No interactive session owner is available" }),
		);
		await session.bindExtensions(uiContext ? { uiContext, mode: "rpc" } : {});
	}

	get sessionId(): string {
		return this.ref.summary.sessionId;
	}

	private bind(session: AgentSession): void {
		this.unsubscribeAgent?.();
		this.unsubscribeSubagents?.();
		this.subagentLive.clear();
		this.session = session;
		this.unsubscribeAgent = session.subscribe((event) => this.onAgentEvent(event));
		this.unsubscribeSubagents = this.runtime.subagentManager?.subscribe((event) => {
			if (event.type === "activity") {
				this.subagentLive.apply(event.agentId, event.turnId, event.event);
				return;
			}
			if (event.type !== "updated") return;
			this.publish({ type: "subagent/updated", sessionId: this.sessionId, subagent: subagentView(event.summary) });
			if (
				event.summary.status === "done" ||
				event.summary.status === "failed" ||
				event.summary.status === "stopped" ||
				event.summary.status === "close_failed" ||
				event.summary.status === "closed"
			) {
				this.subagentLive.clear(event.summary.agentId);
				this.publish({
					type: "subagent/itemsChanged",
					sessionId: this.sessionId,
					agentId: event.summary.agentId,
				});
			}
		});
	}

	private publish(event: DomainEvent): void {
		const projected = this.projection.apply(event);
		if (!projected) return;
		for (const listener of this.listeners) {
			try {
				listener(projected);
			} catch {
				// A renderer listener cannot break runtime persistence or other listeners.
			}
		}
	}

	private onAgentEvent(event: AgentSessionEvent): void {
		if (event.type === "message_start") {
			const assistant = event.message.role === "assistant";
			if (assistant) this.liveAssistantItemId = undefined;
			const itemId = this.publishStartedItem(event.message);
			if (assistant) this.liveAssistantItemId = itemId;
			return;
		}
		if (event.type === "message_update") {
			if (
				event.assistantMessageEvent.type === "text_delta" ||
				event.assistantMessageEvent.type === "thinking_delta"
			) {
				const itemId = this.itemIdFor(event.message);
				const outputTokens = projectAssistantOutputTokens(event.message);
				this.publish({
					type: "item/delta",
					sessionId: this.sessionId,
					itemId,
					delta: {
						type: event.assistantMessageEvent.type === "text_delta" ? "text" : "thinking",
						text: event.assistantMessageEvent.delta,
						...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
					},
				});
			}
			return;
		}
		if (event.type === "message_end") {
			this.publishCompletedItem(event.message);
			const tasks = projectTasksFromToolResult(event.message);
			if (tasks !== undefined) {
				this.publish({ type: "session/tasksChanged", sessionId: this.sessionId, tasks });
			}
			const delivered = projectDeliveredFileFromToolResult(event.message);
			if (delivered) {
				this.deliveredFiles = [...this.deliveredFiles, delivered].slice(-MAX_SESSION_DELIVERED_FILES);
				this.publish({
					type: "session/deliveredFilesChanged",
					sessionId: this.sessionId,
					deliveredFiles: this.deliveredFiles,
				});
			}
			if (event.message.role === "assistant") this.liveAssistantItemId = undefined;
			return;
		}
		if (event.type === "goal_changed") {
			this.publish({
				type: "session/goalChanged",
				sessionId: this.sessionId,
				goal: projectGoal(event.goal),
			});
			return;
		}
		if (event.type === "entry_appended") {
			const item = this.projectJournalItem(event.entry as unknown as Record<string, unknown>);
			if (item) this.publish({ type: "item/completed", item });
			return;
		}
		if (event.type === "agent_start" || event.type === "turn_start") {
			this.refreshLifecycleProjection();
			return;
		}
		if (event.type === "agent_settled") {
			const journal = this.journal();
			const lastTurn = reduceRuntimeJournal(journal).turns.at(-1);
			if (
				lastTurn?.state === "interrupted" ||
				(lastTurn?.state === "completed" && completedTurnHasVisibleAssistantText(journal, lastTurn.turnId))
			) {
				try {
					this.session.sessionManager.setSessionUnread(true);
					this.unread = true;
				} catch {
					// Unread persistence must not break agent settlement.
				}
			}
			this.refreshLifecycleProjection();
			return;
		}
		if (event.type === "session_info_changed") {
			this.refreshLifecycleProjection();
		}
		if (event.type === "compaction_end") {
			// Only a completed compaction appends a journal entry; a cancelled or
			// empty-session compaction (result === undefined) leaves the journal
			// unchanged and needs no projection refresh.
			if (event.result === undefined) return;
			// A compaction appends a new journal entry without emitting
			// `entry_appended`, so project the entry here and refresh the
			// session summary (updatedAt) through the normal lifecycle path.
			const entry = [...this.journal()]
				.reverse()
				.find(
					(candidate) =>
						typeof candidate === "object" &&
						candidate !== null &&
						(candidate as { type?: unknown }).type === "compaction",
				);
			if (entry) {
				const item = this.projectJournalItem(entry as Record<string, unknown>);
				if (item) this.publish({ type: "item/completed", item });
			}
			this.refreshLifecycleProjection();
			return;
		}
		if (event.type === "thinking_selection_changed") {
			this.publish({
				type: "session/thinkingSelectionChanged",
				sessionId: this.sessionId,
				thinkingSelection: event.selection,
				actualThinkingLevel: event.actualThinkingLevel,
				availableThinkingSelections: this.session.getAvailableThinkingSelections(),
			});
		}
	}

	private itemIdFor(message: object): string {
		const record = message as Record<string, unknown>;
		if (record.role === "assistant" && this.liveAssistantItemId) {
			this.liveItemIds.set(message, this.liveAssistantItemId);
			this.liveMessagesByItemId.set(this.liveAssistantItemId, message);
			return this.liveAssistantItemId;
		}
		const existing = this.liveItemIds.get(message);
		if (existing) return existing;
		this.liveItemSequence += 1;
		const value = `${this.sessionId}:${record.role}:${String(record.timestamp)}:${this.liveItemSequence}`;
		const itemId = opaqueId(`live:${createHash("sha256").update(value).digest("hex")}`, "item");
		this.liveItemIds.set(message, itemId);
		this.liveMessagesByItemId.set(itemId, message);
		return itemId;
	}

	private currentTurnId(): string | undefined {
		const turnId = this.session.activeDurableTurnId;
		return turnId === undefined ? undefined : opaqueId(turnId, "turn");
	}

	private projectLiveMessage(message: object, state: ItemView["state"]): ItemView | undefined {
		const turnId = this.currentTurnId();
		return projectLiveItemMessage({
			itemId: this.itemIdFor(message),
			sessionId: this.sessionId,
			...(turnId === undefined ? {} : { turnId }),
			message,
			state,
			fallbackTimestamp: this.ref.summary.updatedAt,
		});
	}

	private publishStartedItem(message: object): string | undefined {
		const item = this.projectLiveMessage(message, "streaming");
		if (!item) return undefined;
		this.publish({ type: "item/started", item });
		return item.itemId;
	}

	private publishCompletedItem(message: object): void {
		const record = message as Record<string, unknown>;
		const interrupted =
			record.role === "assistant" && (record.stopReason === "aborted" || record.stopReason === "error");
		const item = this.projectLiveMessage(message, interrupted ? "interrupted" : "completed");
		if (!item) return;
		this.publish({ type: "item/completed", item });
	}

	private journal(): readonly unknown[] {
		return this.session.sessionManager.getDurableJournalSnapshot();
	}

	private reduced() {
		return reduceRuntimeJournal(this.journal());
	}

	private projectJournalItem(entry: Record<string, unknown>): ItemView | undefined {
		const reduced = this.reduced();
		return projectSessionEntry({
			entry,
			sessionId: this.sessionId,
			turnStates: new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state])),
			toolStates: new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state])),
			fallbackTimestamp: this.ref.summary.createdAt,
		});
	}

	private itemsFromJournal(
		journal: readonly unknown[] = this.journal(),
		reduced: ReturnType<typeof reduceRuntimeJournal> = reduceRuntimeJournal(journal),
	): ItemView[] {
		const turnStates = new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state]));
		const toolStates = new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state]));
		return journal
			.map((entry) =>
				projectSessionEntry({
					entry: entry as unknown as Record<string, unknown>,
					sessionId: this.sessionId,
					turnStates,
					toolStates,
					fallbackTimestamp: this.ref.summary.createdAt,
				}),
			)
			.filter((item): item is ItemView => item !== undefined);
	}

	private turnsFromJournal(
		journal: readonly unknown[] = this.journal(),
		reduced: ReturnType<typeof reduceRuntimeJournal> = reduceRuntimeJournal(journal),
	): TurnView[] {
		return mapRuntimeTurns(journal, reduced, this.sessionId, this.ref.summary.createdAt);
	}

	private publishCurrentTurn(
		journal: readonly unknown[] = this.journal(),
		reduced: ReturnType<typeof reduceRuntimeJournal> = reduceRuntimeJournal(journal),
	): void {
		const activeTurnId = this.currentTurnId();
		const turns = this.turnsFromJournal(journal, reduced);
		const turn =
			(activeTurnId === undefined ? undefined : turns.find((candidate) => candidate.turnId === activeTurnId)) ??
			turns.at(-1);
		if (!turn || this.projectedTurnStates.get(turn.turnId) === turn.state) return;
		this.projectedTurnStates.set(turn.turnId, turn.state);
		this.publish({
			type:
				turn.state === "running"
					? "turn/started"
					: turn.state === "interrupted"
						? "turn/interrupted"
						: "turn/completed",
			turn,
		});
	}

	private refreshLifecycleProjection(): void {
		const journal = this.journal();
		const reduced = reduceRuntimeJournal(journal);
		this.publishCurrentTurn(journal, reduced);
		const next = this.summaryFromRuntime(journal, reduced);
		if (JSON.stringify(next) !== JSON.stringify(this.projection.getSummary())) {
			this.publish({ type: "session/updated", session: next });
		}
	}

	isActive(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.activeDurableTurnId !== undefined;
	}

	hasPendingInteractions(): boolean {
		return this.interactions?.hasPending(this.sessionId) ?? false;
	}

	getSummary(): SessionSummary {
		return this.projection.getSummary();
	}

	async markRead(): Promise<SessionSummary> {
		if (!this.unread) return this.getSummary();
		try {
			this.session.sessionManager.setSessionUnread(false);
		} catch {
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId });
		}
		this.unread = false;
		this.refreshLifecycleProjection();
		return this.getSummary();
	}

	async renameSession(value: string): Promise<SessionSummary> {
		const next = optionalName(value);
		if (!next) throw new AppServerError("INVALID_REQUEST", { sessionId: this.sessionId });
		this.session.setSessionName(next);
		this.refreshLifecycleProjection();
		return this.getSummary();
	}

	async fork(input: { entryId: string; name: string }): Promise<string> {
		// Create an independent branch file rooted at the reply (inclusive).
		// The current runtime stays on the original session; the caller opens
		// the forked session as its own runtime. We deliberately do not call
		// runtime.fork() — it swaps the active session in place, which would
		// desync this host's ref/sessionId from its bound session.
		const manager = this.session.sessionManager;
		// Live-streamed replies carry a hashed itemId (live:<sha256>) rather than
		// their durable journal entry id. Resolve only the exact message object
		// that produced that live item; stale or unknown ids must not fork from
		// a different reply.
		let entryId = input.entryId;
		if (manager.getEntry(entryId) === undefined) {
			const message = this.liveMessagesByItemId.get(entryId);
			const persistedEntryId = message ? manager.getMessageEntryId(message) : undefined;
			if (!persistedEntryId) throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
			entryId = persistedEntryId;
		}
		const branched = manager.createBranchedSessionManager(entryId);
		try {
			const next = optionalName(input.name);
			if (next) branched.appendSessionInfo(next);
			const forkedSessionId = branched.getSessionId();
			copySessionDeliveredFiles({
				agentDir: this.agentDir,
				sourceSessionId: this.sessionId,
				targetSessionId: forkedSessionId,
				fileIds: projectAllDeliveredFiles(branched.getBranch()).map((file) => file.fileId),
			});
			return forkedSessionId;
		} finally {
			branched.close();
		}
	}

	async listSkills(): Promise<ClientResult<"skill/list">> {
		try {
			return publicSkills((await this.session.refreshSkills()).skills);
		} catch {
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId });
		}
	}

	private mcpCwd(): string {
		return this.session.sessionManager.getCwd();
	}

	private assertMcpSession(input: object): asserts input is { sessionId: string } {
		if (!("sessionId" in input) || input.sessionId !== this.sessionId) {
			throw new AppServerError("INVALID_REQUEST", { sessionId: this.sessionId });
		}
	}

	private mcpRows(): ClientResult<"mcp/list"> {
		return {
			servers: publicMcpServers(this.session.settingsManager, {
				statuses: this.session.getMcpStatus(),
				credentialConfigured: (scope, name, server) =>
					hasMatchingMcpCredential(this.authStorage, this.mcpCwd(), scope, name, server),
			}),
		};
	}

	private mcpRow(scope: "user" | "project", name: string) {
		const row = this.mcpRows().servers.find((server) => server.scope === scope && server.name === name);
		if (!row) throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
		return row;
	}

	private assertProjectMcpWrite(scope: "user" | "project", requestId: string): void {
		if (scope === "project" && !this.session.settingsManager.isProjectTrusted()) {
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId });
		}
	}

	private currentMcpDefinition(
		scope: "user" | "project",
		name: string,
		expectedRevision: string,
		requestId: string,
	): McpServerSettings {
		const current = mcpDefinitionAtScope(this.session.settingsManager, scope, name);
		if (!current || mcpRevision(scope, name, current) !== expectedRevision) {
			throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId });
		}
		return current;
	}

	private mutateMcpWhileIdle<T>(requestId: string, mutation: () => Promise<T>): Promise<T> {
		return this.mutateMcp(async () => {
			if (this.isActive() || this.hasPendingInteractions()) {
				throw new AppServerError("BUSY", { sessionId: this.sessionId, requestId });
			}
			return mutation();
		});
	}

	private async persistMcpDefinition(
		scope: "user" | "project",
		name: string,
		next: McpServerSettings | undefined,
		previous: McpServerSettings | undefined,
		requestId: string,
		credential?: McpCredentialInput,
	): Promise<void> {
		try {
			await persistMcpChanges({
				settingsManager: this.session.settingsManager,
				authStorage: this.authStorage,
				cwd: this.mcpCwd(),
				scope,
				changes: new Map([[name, { next, previous, ...(credential ? { credential } : {}) }]]),
				reload: () => this.session.reloadMcpServers(),
			});
		} catch {
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId });
		}
	}

	async listMcpServers(): Promise<ClientResult<"mcp/list">> {
		return this.mcpRows();
	}

	async inspectMcpImport(input: ClientParams<"mcp/import/inspect">): Promise<ClientResult<"mcp/import/inspect">> {
		this.assertMcpSession(input);
		this.assertProjectMcpWrite(input.scope, "inspect");
		const settings =
			input.scope === "user"
				? this.session.settingsManager.getGlobalSettings()
				: this.session.settingsManager.getProjectSettings();
		const existing = new Map(
			Object.entries(settings.mcpServers ?? {}).map(([name, server]) => [
				name,
				mcpRevision(input.scope, name, server),
			]),
		);
		try {
			return inspectMcpImportSource({ scope: input.scope, cwd: this.mcpCwd(), text: input.text }, existing);
		} catch {
			throw new AppServerError("INVALID_REQUEST", { sessionId: this.sessionId });
		}
	}

	async importMcpServers(input: ClientParams<"mcp/import">): Promise<ClientResult<"mcp/import">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			this.assertProjectMcpWrite(input.scope, input.requestId);
			let resolved: ReturnType<typeof resolveMcpImport>;
			try {
				resolved = resolveMcpImport(
					{ scope: input.scope, cwd: this.mcpCwd(), text: input.text },
					input.candidates,
					input.sourceRevision,
				);
			} catch {
				throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId: input.requestId });
			}
			const changes = new Map<string, McpDefinitionChange>();
			for (const entry of resolved.entries) {
				const current = mcpDefinitionAtScope(this.session.settingsManager, input.scope, entry.name);
				if (
					entry.expectedRevision === null
						? current !== undefined
						: !current || mcpRevision(input.scope, entry.name, current) !== entry.expectedRevision
				) {
					throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId: input.requestId });
				}
				changes.set(entry.name, {
					next: inputMcpServer(entry.server, current, this.mcpCwd()),
					previous: current,
					...(entry.credential ? { credential: entry.credential } : {}),
				});
			}
			try {
				await persistMcpChanges({
					settingsManager: this.session.settingsManager,
					authStorage: this.authStorage,
					cwd: this.mcpCwd(),
					scope: input.scope,
					changes,
					reload: () => this.session.reloadMcpServers(),
				});
				return this.mcpRows();
			} catch {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
		});
	}

	async getMcpServer(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">> {
		this.assertMcpSession(input);
		const server = this.mcpRow(input.scope, input.name);
		return publicMcpDetail(server, server.effective ? this.session.getMcpCatalog(input.name) : undefined);
	}

	async getMcpCatalogItem(input: ClientParams<"mcp/catalog/get">): Promise<ClientResult<"mcp/catalog/get">> {
		this.assertMcpSession(input);
		try {
			return this.session.getMcpCatalogItem(input.server, input.kind, input.id);
		} catch {
			throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
		}
	}

	async upsertMcpServer(input: ClientParams<"mcp/upsert">): Promise<ClientResult<"mcp/upsert">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			this.assertProjectMcpWrite(input.scope, input.requestId);
			const current = mcpDefinitionAtScope(this.session.settingsManager, input.scope, input.name);
			if (
				input.expectedRevision === null
					? current !== undefined
					: !current || mcpRevision(input.scope, input.name, current) !== input.expectedRevision
			) {
				throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId: input.requestId });
			}
			let next: McpServerSettings;
			try {
				next = inputMcpServer(input.server, current, this.mcpCwd());
			} catch {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			await this.persistMcpDefinition(input.scope, input.name, next, current, input.requestId, input.credential);
			return this.mcpRows();
		});
	}

	async removeMcpServer(input: ClientParams<"mcp/remove">): Promise<ClientResult<"mcp/remove">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			this.assertProjectMcpWrite(input.scope, input.requestId);
			const current = this.currentMcpDefinition(input.scope, input.name, input.expectedRevision, input.requestId);
			await this.persistMcpDefinition(input.scope, input.name, undefined, current, input.requestId);
			return this.mcpRows();
		});
	}

	private effectiveMcpDefinition(input: {
		scope: "user" | "project";
		name: string;
		expectedRevision: string;
		requestId: string;
	}): McpServerSettings {
		const current = this.currentMcpDefinition(input.scope, input.name, input.expectedRevision, input.requestId);
		if (!this.mcpRow(input.scope, input.name).effective) {
			throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId: input.requestId });
		}
		return current;
	}

	async restartMcpServer(input: ClientParams<"mcp/restart">): Promise<ClientResult<"mcp/restart">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			this.effectiveMcpDefinition(input);
			try {
				await this.session.restartMcpServers(input.name);
			} catch {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			return await this.getMcpServer(input);
		});
	}

	async setMcpCredential(input: ClientParams<"mcp/credential/set">): Promise<ClientResult<"mcp/credential/set">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			const current = this.effectiveMcpDefinition(input);
			if (input.credential.bearerToken && typeof current.url !== "string") {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			try {
				await this.session.setMcpSecret(input.name, {
					...(input.credential.bearerToken ? { bearerToken: input.credential.bearerToken } : {}),
					...(input.credential.environment ? { env: input.credential.environment } : {}),
				});
			} catch {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			return await this.getMcpServer(input);
		});
	}

	async clearMcpCredential(
		input: ClientParams<"mcp/credential/clear">,
	): Promise<ClientResult<"mcp/credential/clear">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			this.effectiveMcpDefinition(input);
			try {
				await this.session.logoutMcpServer(input.name);
			} catch {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			return await this.getMcpServer(input);
		});
	}

	private summaryFromRuntime(
		journal: readonly unknown[] = this.journal(),
		reduced: ReturnType<typeof reduceRuntimeJournal> = reduceRuntimeJournal(journal),
	): SessionSummary {
		const manager = this.session.sessionManager;
		const lastTurn = reduced.turns.at(-1);
		const lastTerminalTurn = [...reduced.turns].reverse().find((turn) => turn.state !== "active");
		const lastEntry = journal.at(-1) as Record<string, unknown> | undefined;
		const sessionName = optionalName(manager.getSessionName());
		const {
			name: _name,
			recoveryNotice: _recoveryNotice,
			lastTurnOutcome: persistedOutcome,
			attentionRequired: _attentionRequired,
			...base
		} = this.ref.summary;
		const lastTurnOutcome = lastTerminalTurn
			? lastTerminalTurn.state === "completed"
				? "completed"
				: "failed"
			: persistedOutcome;
		const recoveryNotice =
			this.runtime.recoverableDrafts.length > 0
				? "Queued work was recovered as a draft and was not replayed automatically."
				: undefined;
		return {
			...base,
			...(sessionName === undefined ? {} : { name: sessionName }),
			updatedAt: timestamp(lastEntry?.timestamp, this.ref.summary.updatedAt),
			state: this.isActive() ? "running" : lastTurn?.state === "interrupted" ? "interrupted" : "idle",
			...(lastTurnOutcome ? { lastTurnOutcome } : {}),
			attentionRequired: this.hasPendingInteractions(),
			unread: this.unread,
			...(recoveryNotice === undefined ? {} : { recoveryNotice }),
		};
	}

	async readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return this.projection.readItems(input);
	}

	async readImage(input: ClientParams<"session/readImage">): Promise<ClientResult<"session/readImage">> {
		try {
			const [image] = this.session.sessionManager.resolveDurableImageRefs([
				{
					type: "image_ref",
					hash: input.image.hash,
					mimeType: input.image.mediaType,
					size: input.image.byteLength,
				},
			]);
			if (!image) throw new Error("unavailable");
			if (Buffer.byteLength(image.data, "utf8") > MAX_READ_IMAGE_DATA_UTF8_BYTES) {
				throw new Error("too large for envelope");
			}
			return { data: image.data, mediaType: input.image.mediaType };
		} catch {
			throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
		}
	}

	async openDeliveredFile(
		input: ClientParams<"session/openDeliveredFile">,
	): Promise<ClientResult<"session/openDeliveredFile">> {
		try {
			await openDeliveredFileOnDisk({
				agentDir: this.agentDir,
				sessionId: input.sessionId,
				fileId: input.fileId,
				action: input.action,
			});
			return {};
		} catch (error) {
			if (error instanceof Error && error.message === "Delivered file was not found") {
				throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
			}
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId });
		}
	}

	async readDeliveredFile(
		input: ClientParams<"session/readDeliveredFile">,
	): Promise<ClientResult<"session/readDeliveredFile">> {
		try {
			return await readDeliveredFileOnDisk({
				agentDir: this.agentDir,
				sessionId: input.sessionId,
				fileId: input.fileId,
			});
		} catch (error) {
			if (error instanceof Error && error.message === "Delivered file was not found") {
				throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
			}
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId });
		}
	}

	async getStatus(input: ClientParams<"session/status">): Promise<ClientResult<"session/status">> {
		const stats = this.session.getSessionStats();
		const context = stats.contextUsage;
		return {
			sessionId: input.sessionId,
			mode: stats.mode,
			contextTokens: context?.tokens ?? null,
			contextWindow: context?.contextWindow ?? null,
			remainingPercent: context?.percent == null ? null : Math.max(0, Math.min(100, 100 - context.percent)),
			cacheHitPercent: getLatestCacheHitPercent(this.session.sessionManager.getEntries()) ?? null,
		};
	}

	async compact(input: ClientParams<"session/compact">): Promise<ClientResult<"session/compact">> {
		if (this.isActive() || this.hasPendingInteractions() || this.session.isCompacting) {
			throw new AppServerError("BUSY", { sessionId: input.sessionId, requestId: input.requestId });
		}
		try {
			const result = await this.session.compact();
			return {
				sessionId: input.sessionId,
				tokensBefore: result.tokensBefore,
				estimatedTokensAfter: result.estimatedTokensAfter ?? null,
			};
		} catch (error) {
			// The runtime reports "nothing to do" and user cancellation as thrown
			// errors. Surface those as informational notices instead of a generic
			// failure so the desktop can show the real reason.
			const message = error instanceof Error ? error.message : String(error);
			if (
				message === "Nothing to compact (session too small)" ||
				message === "Already compacted" ||
				message === "Compaction cancelled"
			) {
				return { sessionId: input.sessionId, tokensBefore: 0, estimatedTokensAfter: null, message };
			}
			throw new AppServerError("OPERATION_FAILED", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
	}

	async getGoal(input: ClientParams<"session/goal/get">): Promise<ClientResult<"session/goal/get">> {
		return { sessionId: input.sessionId, goal: projectGoal(this.session.getGoal()) };
	}

	async setGoal(input: ClientParams<"session/goal/set">): Promise<ClientResult<"session/goal/set">> {
		try {
			const goal = this.session.setGoalFromUser({
				...(input.objective === undefined ? {} : { objective: input.objective }),
				...(input.status === undefined ? {} : { status: input.status }),
			});
			return { sessionId: input.sessionId, goal: projectGoal(goal)! };
		} catch {
			throw new AppServerError("INVALID_REQUEST", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
	}

	async clearGoal(input: ClientParams<"session/goal/clear">): Promise<ClientResult<"session/goal/clear">> {
		const cleared = this.session.clearGoal();
		return { sessionId: input.sessionId, cleared };
	}

	async readSubagentItems(input: ClientParams<"subagent/readItems">): Promise<ClientResult<"subagent/readItems">> {
		const manager = this.runtime.subagentManager;
		if (!manager) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
		const journal = await manager.readJournal(input.agentId);
		const reduced = reduceRuntimeJournal(journal);
		const turns = new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state]));
		const tools = new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state]));
		const items = journal
			.map((entry) =>
				projectMessageEntry({
					entry: entry as unknown as Record<string, unknown>,
					sessionId: input.agentId,
					turnStates: turns,
					toolStates: tools,
					fallbackTimestamp: this.ref.summary.createdAt,
				}),
			)
			.filter((item): item is ItemView => item !== undefined)
			.concat(this.subagentLive.currentItems(input.agentId));
		const end = input.beforeItemId ? items.findIndex((item) => item.itemId === input.beforeItemId) : items.length;
		if (input.beforeItemId && end < 0) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
		const start = Math.max(0, end - input.limit);
		return { items: items.slice(start, end), nextBeforeItemId: start > 0 ? items[start]!.itemId : null };
	}

	async interruptSubagent(input: ClientParams<"subagent/interrupt">): Promise<ClientResult<"subagent/interrupt">> {
		const manager = this.runtime.subagentManager;
		if (!manager) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
		return { subagent: subagentView(await manager.interrupt(input.agentId)) };
	}

	async setThinkingSelection(
		input: ClientParams<"session/setThinkingSelection">,
	): Promise<ClientResult<"session/setThinkingSelection">> {
		this.session.setThinkingSelection(input.selection);
		return {
			thinkingSelection: this.session.getThinkingSelection(),
			actualThinkingLevel: this.session.thinkingLevel,
			availableThinkingSelections: this.session.getAvailableThinkingSelections(),
		};
	}

	async setPermissionMode(
		input: ClientParams<"session/setPermissionMode">,
	): Promise<ClientResult<"session/setPermissionMode">> {
		if (this.isActive() || this.hasPendingInteractions()) {
			throw new AppServerError("BUSY", { sessionId: input.sessionId, requestId: input.requestId });
		}
		try {
			await this.session.setPermissionMode(input.permissionMode);
		} catch {
			const permissionMode = this.session.sessionManager.getPermissionSettings().mode;
			this.publish({ type: "session/permissionModeChanged", sessionId: this.sessionId, permissionMode });
			throw new AppServerError("OPERATION_FAILED", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
		const permissionMode = this.session.sessionManager.getPermissionSettings().mode;
		this.publish({ type: "session/permissionModeChanged", sessionId: this.sessionId, permissionMode });
		return { permissionMode };
	}

	async refreshWebSearchSettings(): Promise<void> {
		await this.session.refreshWebSearchSettings();
	}

	async setModel(input: ClientParams<"session/setModel">): Promise<ClientResult<"session/setModel">> {
		this.session.modelRegistry.refresh();
		const model = this.session.modelRegistry.find(input.provider, input.modelId);
		if (!model || !this.session.modelRegistry.hasConfiguredAuth(model)) {
			throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
		}
		await this.session.setModel(model);
		const result = {
			model: { provider: model.provider, modelId: model.id },
			thinkingSelection: this.session.getThinkingSelection(),
			actualThinkingLevel: this.session.thinkingLevel,
			availableThinkingSelections: this.session.getAvailableThinkingSelections(),
		} satisfies ClientResult<"session/setModel">;
		this.publish({ type: "session/modelChanged", sessionId: this.sessionId, ...result });
		return result;
	}

	async snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot> {
		this.refreshLifecycleProjection();
		return this.projection.snapshot(serverEpoch, currentCursor(), {
			permissionMode: this.session.sessionManager.getPermissionSettings().mode,
			...(this.session.model
				? { model: { provider: this.session.model.provider, modelId: this.session.model.id } }
				: {}),
			availableModels: this.session.modelRegistry
				.getAvailable()
				.slice(0, 512)
				.map((model) => ({
					provider: model.provider,
					modelId: model.id,
					name: name(model.name, model.id),
				})),
			thinkingSelection: this.session.getThinkingSelection(),
			actualThinkingLevel: this.session.thinkingLevel,
			availableThinkingSelections: this.session.getAvailableThinkingSelections(),
			subagents: [...(this.runtime.subagentManager?.listSummaries() ?? [])].map(subagentView),
		});
	}

	async startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">> {
		const attachments = input.attachments?.length
			? importSessionAttachments({
					agentDir: this.agentDir,
					sessionId: this.sessionId,
					cwd: this.runtime.cwd,
					attachments: input.attachments,
					key: input.requestId,
				})
			: [];
		return await this.runtime.submitPrompt({
			requestId: input.requestId,
			text: formatSessionAttachments(input.text, attachments),
			...(input.images === undefined ? {} : { images: input.images.map(toRuntimeImage) }),
		});
	}

	async steer(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">> {
		const attachments = input.attachments?.length
			? importSessionAttachments({
					agentDir: this.agentDir,
					sessionId: this.sessionId,
					cwd: this.runtime.cwd,
					attachments: input.attachments,
					key: input.requestId,
				})
			: [];
		return await this.runtime.submitPrompt({
			requestId: input.requestId,
			text: formatSessionAttachments(input.text, attachments),
			...(input.images === undefined ? {} : { images: input.images.map(toRuntimeImage) }),
			streamingBehavior: input.delivery === "follow_up" ? "followUp" : "steer",
		});
	}

	async queueTurn(input: ClientParams<"turn/queue">): Promise<ClientResult<"turn/queue">> {
		const attachments = input.attachments?.length
			? importSessionAttachments({
					agentDir: this.agentDir,
					sessionId: this.sessionId,
					cwd: this.runtime.cwd,
					attachments: input.attachments,
					key: input.requestId,
				})
			: [];
		try {
			const queuedTurn = this.runtime.enqueueQueuedTurn({
				requestId: input.requestId,
				text: formatSessionAttachments(input.text, attachments),
				...(input.images === undefined ? {} : { images: input.images.map(toRuntimeImage) }),
			});
			return { queuedTurn: queuedTurnView(queuedTurn) };
		} catch (error) {
			for (const attachment of attachments) {
				removeSessionAttachment(this.agentDir, this.sessionId, attachment.path);
			}
			throwQueuedTurnError(error, input);
		}
	}

	async updateQueuedTurn(input: ClientParams<"turn/queue/update">): Promise<ClientResult<"turn/queue/update">> {
		try {
			return {
				queuedTurn: queuedTurnView(
					this.runtime.updateQueuedTurn({
						queueItemId: input.queueItemId,
						expectedRevision: input.expectedRevision,
						text: input.text,
					}),
				),
			};
		} catch (error) {
			throwQueuedTurnError(error, input);
		}
	}

	async deleteQueuedTurn(input: ClientParams<"turn/queue/delete">): Promise<ClientResult<"turn/queue/delete">> {
		const current = this.runtime.queuedTurns.find((turn) => turn.queueItemId === input.queueItemId);
		try {
			this.runtime.deleteQueuedTurn({
				queueItemId: input.queueItemId,
				expectedRevision: input.expectedRevision,
			});
		} catch (error) {
			throwQueuedTurnError(error, input);
		}
		if (current) {
			for (const attachment of splitSessionAttachmentPrompt(current.input.text).attachments) {
				removeSessionAttachment(this.agentDir, this.sessionId, attachment.path);
			}
		}
		return { queueItemId: input.queueItemId, deleted: true };
	}

	async sendQueuedTurn(input: ClientParams<"turn/queue/send">): Promise<ClientResult<"turn/queue/send">> {
		try {
			return await this.runtime.sendQueuedTurn({
				queueItemId: input.queueItemId,
				expectedRevision: input.expectedRevision,
				delivery: input.delivery,
			});
		} catch (error) {
			throwQueuedTurnError(error, input);
		}
	}

	async interrupt(input: ClientParams<"turn/interrupt">): Promise<ClientResult<"turn/interrupt">> {
		const result = await this.runtime.interrupt({ requestId: input.requestId });
		this.refreshLifecycleProjection();
		return result;
	}

	async prepareMutation(input: DurableSessionMutation): Promise<PreparedSessionMutation> {
		return prepareSessionMutation(this.session.sessionManager, input);
	}

	subscribe(listener: SessionEventListener): () => void {
		if (this.closed || this.closePromise) throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		if (!this.closePromise) {
			this.closePromise = this.runtime
				.dispose()
				.then(() => {
					this.runtime.setRebindSession(undefined);
					this.unsubscribeAgent?.();
					this.unsubscribeAgent = undefined;
					this.unsubscribeSubagents?.();
					this.unsubscribeSubagents = undefined;
					this.unsubscribeQueuedTurns?.();
					this.unsubscribeQueuedTurns = undefined;
					this.subagentLive.clear();
					this.listeners.clear();
					this.closed = true;
				})
				.finally(() => {
					if (!this.closed) this.closePromise = undefined;
				});
		}
		await this.closePromise;
	}
}

class ReadonlyScheduledSessionRuntime implements OpenedSessionRuntime {
	readonly sessionId: string;
	private readonly agentDir: string;
	private readonly projection: SessionProjection;
	private readonly mcpServers: ClientResult<"mcp/list">;

	constructor(ref: SessionRef, agentDir: string, mcpServers: ClientResult<"mcp/list"> = { servers: [] }) {
		this.sessionId = ref.summary.sessionId;
		this.agentDir = agentDir;
		this.mcpServers = mcpServers;
		let manager: ReturnType<typeof SessionManager.openReadOnly>;
		try {
			manager = SessionManager.openReadOnly(ref.path);
			const header = manager.getHeader();
			if (
				header?.id !== this.sessionId ||
				header.scheduled?.taskId !== ref.scheduled?.taskId ||
				header.scheduled?.runId !== ref.scheduled?.runId ||
				header.mode !== ref.summary.mode ||
				header.cwdOrigin !== ref.summary.cwdOrigin ||
				(header.cwd || null) !== ref.summary.cwd ||
				header.timestamp !== ref.summary.createdAt
			) {
				throw new Error("Scheduled session identity changed");
			}
		} catch {
			throw new AppServerError("SESSION_CORRUPT", { sessionId: this.sessionId });
		}
		const journal = manager.getDurableJournalSnapshot();
		const reduced = reduceRuntimeJournal(journal);
		const legacyTurnId =
			reduced.turns.length === 0 ? opaqueId(`scheduled-turn:${ref.scheduled!.runId}`, "turn") : undefined;
		const turns =
			legacyTurnId === undefined
				? mapRuntimeTurns(journal, reduced, this.sessionId, ref.summary.createdAt)
				: [
						{
							turnId: legacyTurnId,
							sessionId: this.sessionId,
							operationIds: [opaqueId(`scheduled-operation:${ref.scheduled!.runId}`, "operation")],
							state: "completed" as const,
							startedAt: ref.summary.createdAt,
							completedAt: ref.summary.updatedAt,
						},
					];
		const turnStates = new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state]));
		if (legacyTurnId !== undefined) turnStates.set(legacyTurnId, "completed");
		const toolStates = new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state]));
		const items = journal
			.map((entry) => {
				const record = entry as unknown as Record<string, unknown>;
				return projectSessionEntry({
					entry:
						legacyTurnId !== undefined && record.type === "message" && record.turnId === undefined
							? { ...record, turnId: legacyTurnId }
							: record,
					sessionId: this.sessionId,
					turnStates,
					toolStates,
					fallbackTimestamp: ref.summary.createdAt,
				});
			})
			.filter((item): item is ItemView => item !== undefined);
		this.projection = new SessionProjection({
			session: ref.summary,
			turns,
			items,
			tasks: projectLatestTasks(manager.getBranch()),
			deliveredFiles: projectAllDeliveredFiles(manager.getBranch()),
			goal: projectGoal(readThreadGoal(manager)),
		});
	}

	isActive(): boolean {
		return false;
	}

	hasPendingInteractions(): boolean {
		return false;
	}

	getSummary(): SessionSummary {
		return this.projection.getSummary();
	}

	async markRead(): Promise<SessionSummary> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async renameSession(): Promise<SessionSummary> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async fork(): Promise<string> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async listSkills(): Promise<ClientResult<"skill/list">> {
		return { skills: [] };
	}

	async listMcpServers(): Promise<ClientResult<"mcp/list">> {
		return this.mcpServers;
	}

	async getMcpServer(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">> {
		if (!("sessionId" in input) || input.sessionId !== this.sessionId) {
			throw new AppServerError("INVALID_REQUEST", { sessionId: this.sessionId });
		}
		const server = this.mcpServers.servers.find((row) => row.scope === input.scope && row.name === input.name);
		if (!server) throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
		return publicMcpDetail(server);
	}

	async getMcpCatalogItem(): Promise<ClientResult<"mcp/catalog/get">> {
		throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
	}

	async upsertMcpServer(): Promise<ClientResult<"mcp/upsert">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async inspectMcpImport(): Promise<ClientResult<"mcp/import/inspect">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async importMcpServers(): Promise<ClientResult<"mcp/import">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async removeMcpServer(): Promise<ClientResult<"mcp/remove">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async restartMcpServer(): Promise<ClientResult<"mcp/restart">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async setMcpCredential(): Promise<ClientResult<"mcp/credential/set">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async clearMcpCredential(): Promise<ClientResult<"mcp/credential/clear">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return this.projection.readItems(input);
	}

	async readImage(): Promise<ClientResult<"session/readImage">> {
		throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
	}

	async openDeliveredFile(
		input: ClientParams<"session/openDeliveredFile">,
	): Promise<ClientResult<"session/openDeliveredFile">> {
		try {
			await openDeliveredFileOnDisk({
				agentDir: this.agentDir,
				sessionId: input.sessionId,
				fileId: input.fileId,
				action: input.action,
			});
			return {};
		} catch (error) {
			if (error instanceof Error && error.message === "Delivered file was not found") {
				throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
			}
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId });
		}
	}

	async readDeliveredFile(
		input: ClientParams<"session/readDeliveredFile">,
	): Promise<ClientResult<"session/readDeliveredFile">> {
		try {
			return await readDeliveredFileOnDisk({
				agentDir: this.agentDir,
				sessionId: input.sessionId,
				fileId: input.fileId,
			});
		} catch (error) {
			if (error instanceof Error && error.message === "Delivered file was not found") {
				throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
			}
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId });
		}
	}

	async getStatus(input: ClientParams<"session/status">): Promise<ClientResult<"session/status">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: input.sessionId });
	}

	async compact(input: ClientParams<"session/compact">): Promise<ClientResult<"session/compact">> {
		throw new AppServerError("READ_ONLY_SESSION", {
			sessionId: input.sessionId,
			requestId: input.requestId,
		});
	}

	async getGoal(input: ClientParams<"session/goal/get">): Promise<ClientResult<"session/goal/get">> {
		return { sessionId: input.sessionId, goal: this.projection.snapshot("", 0).goal };
	}

	async setGoal(input: ClientParams<"session/goal/set">): Promise<ClientResult<"session/goal/set">> {
		throw new AppServerError("READ_ONLY_SESSION", {
			sessionId: input.sessionId,
			requestId: input.requestId,
		});
	}

	async clearGoal(input: ClientParams<"session/goal/clear">): Promise<ClientResult<"session/goal/clear">> {
		throw new AppServerError("READ_ONLY_SESSION", {
			sessionId: input.sessionId,
			requestId: input.requestId,
		});
	}

	async readSubagentItems(): Promise<ClientResult<"subagent/readItems">> {
		throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
	}

	async interruptSubagent(): Promise<ClientResult<"subagent/interrupt">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async setThinkingSelection(): Promise<ClientResult<"session/setThinkingSelection">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async setPermissionMode(): Promise<ClientResult<"session/setPermissionMode">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async setModel(): Promise<ClientResult<"session/setModel">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot> {
		return this.projection.snapshot(serverEpoch, currentCursor());
	}

	async startTurn(): Promise<ClientResult<"turn/start">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async steer(): Promise<ClientResult<"turn/steer">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async queueTurn(input: ClientParams<"turn/queue">): Promise<ClientResult<"turn/queue">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: input.sessionId, requestId: input.requestId });
	}

	async updateQueuedTurn(input: ClientParams<"turn/queue/update">): Promise<ClientResult<"turn/queue/update">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: input.sessionId, requestId: input.requestId });
	}

	async deleteQueuedTurn(input: ClientParams<"turn/queue/delete">): Promise<ClientResult<"turn/queue/delete">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: input.sessionId, requestId: input.requestId });
	}

	async sendQueuedTurn(input: ClientParams<"turn/queue/send">): Promise<ClientResult<"turn/queue/send">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: input.sessionId, requestId: input.requestId });
	}

	async interrupt(): Promise<ClientResult<"turn/interrupt">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async prepareMutation(): Promise<PreparedSessionMutation> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	subscribe(): () => void {
		return () => {};
	}

	async close(): Promise<void> {}
}

function toRuntimeImage(image: DurableImageRefView) {
	return { type: "image_ref" as const, hash: image.hash, mimeType: image.mediaType, size: image.byteLength };
}

export class AgentSessionRuntimeHost implements SessionRuntimeHost {
	private readonly agentDir: string;
	private readonly options: AgentSessionRuntimeHostOptions;
	private readonly trustStore: ProjectTrustStore;
	private readonly authStorage?: AuthStorage;
	private skillMutationTail: Promise<void> = Promise.resolve();
	private mcpMutationTail: Promise<void> = Promise.resolve();

	constructor(options: AgentSessionRuntimeHostOptions) {
		this.options = options;
		this.agentDir = options.agentDir;
		this.trustStore = new ProjectTrustStore(options.agentDir);
		this.authStorage = options.credentials?.createView();
	}

	private async mutateMcp<T>(mutation: () => Promise<T>): Promise<T> {
		const previous = this.mcpMutationTail;
		let release!: () => void;
		this.mcpMutationTail = new Promise<void>((resolveMutation) => {
			release = resolveMutation;
		});
		await previous;
		try {
			return await mutation();
		} finally {
			release();
		}
	}

	private async mutateSkill<T>(mutation: () => Promise<T>): Promise<T> {
		const previous = this.skillMutationTail;
		let release!: () => void;
		this.skillMutationTail = new Promise<void>((resolveMutation) => {
			release = resolveMutation;
		});
		await previous;
		try {
			return await mutation();
		} finally {
			release();
		}
	}

	private draftSettings(cwd: string | null): { cwd: string; settingsManager: SettingsManager } {
		const effectiveCwd = cwd ?? this.agentDir;
		const storedTrust = cwd === null ? null : this.trustStore.get(effectiveCwd);
		const projectTrusted =
			cwd !== null &&
			(storedTrust === true || (storedTrust === null && !hasTrustRequiringProjectResources(effectiveCwd)));
		return {
			cwd: effectiveCwd,
			settingsManager: SettingsManager.create(effectiveCwd, this.agentDir, { projectTrusted }),
		};
	}

	private async resolveProjectTrust(cwd: string, sessionId: string): Promise<boolean> {
		if (!hasTrustRequiringProjectResources(cwd)) return true;
		const stored = this.trustStore.get(cwd);
		if (stored !== null) return stored;
		const globalSettings = SettingsManager.create(cwd, this.agentDir, { projectTrusted: false });
		const defaultTrust = globalSettings.getDefaultProjectTrust();
		if (defaultTrust === "always") return true;
		if (defaultTrust === "never") return false;
		const choices = getProjectTrustOptions(cwd, { includeSessionOnly: true });
		const selected = await this.options.interactions?.requestProjectTrust(sessionId, cwd, choices);
		if (!selected) return false;
		if (selected.updates.length > 0) this.trustStore.setMany(selected.updates);
		return selected.trusted;
	}

	private readonly createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		if (options.childConfig && !options.permissionModeCeiling) {
			throw new Error("Child runtime is missing its permission ceiling");
		}
		const projectTrusted = await this.resolveProjectTrust(options.cwd, options.sessionManager.getSessionId());
		const settingsManager = SettingsManager.create(options.cwd, this.agentDir, { projectTrusted });
		const child = options.childConfig;
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: this.agentDir,
			settingsManager,
			...(this.options.credentials ? { authStorage: this.options.credentials.createView() } : {}),
			...(child
				? {
						resourceLoaderOptions: {
							noSkills: true,
							noPromptTemplates: true,
							noThemes: true,
							systemPromptOverride: () => undefined,
							appendSystemPromptOverride: () => [],
						},
					}
				: {}),
		});
		try {
			const childModel = child ? services.modelRegistry.find(child.model.provider, child.model.modelId) : undefined;
			if (child?.mode !== undefined && child.mode !== "code")
				throw new Error("Legacy Chat subagents are cleanup-only and cannot start a runtime");
			if (child && (!childModel || !services.modelRegistry.hasConfiguredAuth(childModel)))
				throw new Error(`Child model is unavailable: ${child.model.provider}/${child.model.modelId}`);
			const scheduleEligible =
				!child && this.options.scheduleManager !== undefined && isScheduleSessionEligible(options.sessionManager);
			const result = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				ultraAvailable: options.ultraAvailable,
				backgroundOptionalMcpStartup: !child,
				...(child
					? {
							model: childModel!,
							thinkingLevel: child.thinkingLevel,
							tools: [...child.tools],
							additionalSystemPrompt: buildChildSystemPrompt(child),
							includeAutoMemory: false,
							permissionModeCeiling: options.permissionModeCeiling,
						}
					: scheduleEligible
						? { additionalSystemPrompt: SCHEDULE_MAIN_PROMPT }
						: {}),
			});
			if (scheduleEligible) {
				installScheduleHost({
					session: result.session,
					manager: this.options.scheduleManager!,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				});
			}
			return { ...result, services, diagnostics: services.diagnostics };
		} catch (error) {
			services.resourceLoader.dispose?.();
			throw error;
		}
	};

	private async draftSkills(cwd: string | null, settingsContext = this.draftSettings(cwd)): Promise<readonly Skill[]> {
		const { cwd: effectiveCwd, settingsManager } = settingsContext;
		const loader = new DefaultResourceLoader({
			cwd: effectiveCwd,
			agentDir: this.agentDir,
			settingsManager,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		try {
			await loader.reload();
			return loader.getSkills().skills;
		} finally {
			loader.dispose();
		}
	}

	async listSkills(cwd: string | null): Promise<ClientResult<"skill/list">> {
		return publicSkills(await this.draftSkills(cwd));
	}

	async getSkill(input: ClientParams<"skill/get">): Promise<ClientResult<"skill/get">> {
		return await readSkillDetail(await this.draftSkills(input.cwd), input);
	}

	async upsertSkill(input: ClientParams<"skill/upsert">): Promise<ClientResult<"skill/upsert">> {
		return await this.mutateSkill(async () => {
			const settingsContext = this.draftSettings(input.cwd);
			if (input.source === "project" && !settingsContext.settingsManager.isProjectTrusted()) {
				throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			}
			const context = {
				agentDir: this.agentDir,
				cwd: input.cwd,
				skills: await this.draftSkills(input.cwd, settingsContext),
			};
			await writeSkill(context, input);
			return await readSkillDetail(await this.draftSkills(input.cwd, settingsContext), input);
		});
	}

	async removeSkill(input: ClientParams<"skill/remove">): Promise<ClientResult<"skill/remove">> {
		return await this.mutateSkill(async () => {
			const settingsContext = this.draftSettings(input.cwd);
			if (input.source === "project" && !settingsContext.settingsManager.isProjectTrusted()) {
				throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			}
			const context = {
				agentDir: this.agentDir,
				cwd: input.cwd,
				skills: await this.draftSkills(input.cwd, settingsContext),
			};
			await trashSkill(context, input);
			return publicSkills(await this.draftSkills(input.cwd, settingsContext));
		});
	}

	async inspectSkillImport(
		input: ClientParams<"skill/import/inspect">,
	): Promise<ClientResult<"skill/import/inspect">> {
		const settingsContext = this.draftSettings(input.cwd);
		if (input.source === "project" && !settingsContext.settingsManager.isProjectTrusted()) {
			throw new AppServerError("OPERATION_FAILED");
		}
		return await inspectSkillImport(
			{
				agentDir: this.agentDir,
				cwd: input.cwd,
				skills: await this.draftSkills(input.cwd, settingsContext),
			},
			input,
		);
	}

	async importSkills(input: ClientParams<"skill/import">): Promise<ClientResult<"skill/import">> {
		return await this.mutateSkill(async () => {
			const settingsContext = this.draftSettings(input.cwd);
			if (input.source === "project" && !settingsContext.settingsManager.isProjectTrusted()) {
				throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			}
			await importSkills(
				{
					agentDir: this.agentDir,
					cwd: input.cwd,
					skills: await this.draftSkills(input.cwd, settingsContext),
				},
				input,
			);
			return publicSkills(await this.draftSkills(input.cwd, settingsContext));
		});
	}

	private draftMcpRows(cwd: string | null, settingsManager?: SettingsManager): ClientResult<"mcp/list"> {
		const context = settingsManager ? { cwd: cwd ?? this.agentDir, settingsManager } : this.draftSettings(cwd);
		return {
			servers: publicMcpServers(context.settingsManager, {
				credentialConfigured: (scope, name, server) =>
					hasMatchingMcpCredential(this.authStorage, context.cwd, scope, name, server),
			}),
		};
	}

	async listMcpServers(cwd: string | null): Promise<ClientResult<"mcp/list">> {
		return this.draftMcpRows(cwd);
	}

	async inspectMcpImport(input: ClientParams<"mcp/import/inspect">): Promise<ClientResult<"mcp/import/inspect">> {
		const context = this.draftMcpContext(input);
		const settings =
			input.scope === "user"
				? context.settingsManager.getGlobalSettings()
				: context.settingsManager.getProjectSettings();
		const existing = new Map(
			Object.entries(settings.mcpServers ?? {}).map(([name, server]) => [
				name,
				mcpRevision(input.scope, name, server),
			]),
		);
		try {
			return inspectMcpImportSource({ scope: input.scope, cwd: context.cwd, text: input.text }, existing);
		} catch {
			throw new AppServerError("INVALID_REQUEST");
		}
	}

	async importMcpServers(input: ClientParams<"mcp/import">): Promise<ClientResult<"mcp/import">> {
		return this.mutateMcp(async () => {
			const context = this.draftMcpContext(input);
			let resolved: ReturnType<typeof resolveMcpImport>;
			try {
				resolved = resolveMcpImport(
					{ scope: input.scope, cwd: context.cwd, text: input.text },
					input.candidates,
					input.sourceRevision,
				);
			} catch {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			const changes = new Map<string, McpDefinitionChange>();
			for (const entry of resolved.entries) {
				const current = mcpDefinitionAtScope(context.settingsManager, input.scope, entry.name);
				if (
					entry.expectedRevision === null
						? current !== undefined
						: !current || mcpRevision(input.scope, entry.name, current) !== entry.expectedRevision
				) {
					throw new AppServerError("CONFLICT", { requestId: input.requestId });
				}
				changes.set(entry.name, {
					next: inputMcpServer(entry.server, current, context.cwd),
					previous: current,
					...(entry.credential ? { credential: entry.credential } : {}),
				});
			}
			try {
				await persistMcpChanges({
					settingsManager: context.settingsManager,
					authStorage: this.authStorage,
					cwd: context.cwd,
					scope: input.scope,
					changes,
				});
				return this.draftMcpRows(context.targetCwd, context.settingsManager);
			} catch {
				throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			}
		});
	}

	private draftMcpContext(input: { cwd?: string | null; scope: "user" | "project"; requestId?: string }) {
		if (!("cwd" in input)) throw new AppServerError("INVALID_REQUEST", { requestId: input.requestId });
		if (input.scope === "project" && input.cwd === null) {
			throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		}
		const context = this.draftSettings(input.cwd ?? null);
		if (input.scope === "project" && !context.settingsManager.isProjectTrusted()) {
			throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		}
		return { ...context, targetCwd: input.cwd ?? null };
	}

	async getMcpServer(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">> {
		const context = this.draftMcpContext(input);
		const server = this.draftMcpRows(context.targetCwd, context.settingsManager).servers.find(
			(row) => row.scope === input.scope && row.name === input.name,
		);
		if (!server) throw new AppServerError("NOT_FOUND");
		return publicMcpDetail(server);
	}

	async upsertMcpServer(input: ClientParams<"mcp/upsert">): Promise<ClientResult<"mcp/upsert">> {
		return this.mutateMcp(async () => {
			const context = this.draftMcpContext(input);
			const current = mcpDefinitionAtScope(context.settingsManager, input.scope, input.name);
			if (
				input.expectedRevision === null
					? current !== undefined
					: !current || mcpRevision(input.scope, input.name, current) !== input.expectedRevision
			) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			try {
				const next = inputMcpServer(input.server, current, context.cwd);
				await persistMcpChanges({
					settingsManager: context.settingsManager,
					authStorage: this.authStorage,
					cwd: context.cwd,
					scope: input.scope,
					changes: new Map([
						[
							input.name,
							{ next, previous: current, ...(input.credential ? { credential: input.credential } : {}) },
						],
					]),
				});
				return this.draftMcpRows(context.targetCwd, context.settingsManager);
			} catch (error) {
				if (error instanceof AppServerError) throw error;
				throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			}
		});
	}

	async removeMcpServer(input: ClientParams<"mcp/remove">): Promise<ClientResult<"mcp/remove">> {
		return this.mutateMcp(async () => {
			const context = this.draftMcpContext(input);
			const current = mcpDefinitionAtScope(context.settingsManager, input.scope, input.name);
			if (!current || mcpRevision(input.scope, input.name, current) !== input.expectedRevision) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			try {
				await persistMcpChanges({
					settingsManager: context.settingsManager,
					authStorage: this.authStorage,
					cwd: context.cwd,
					scope: input.scope,
					changes: new Map([[input.name, { next: undefined, previous: current }]]),
				});
				return this.draftMcpRows(context.targetCwd, context.settingsManager);
			} catch (error) {
				if (error instanceof AppServerError) throw error;
				throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			}
		});
	}

	async open(ref: SessionRef): Promise<OpenedSessionRuntime> {
		if (ref.summary.archived) throw new AppServerError("NOT_FOUND", { sessionId: ref.summary.sessionId });
		if (ref.scheduled)
			return new ReadonlyScheduledSessionRuntime(ref, this.agentDir, await this.listMcpServers(ref.summary.cwd));
		let manager: SessionManager;
		try {
			manager = SessionManager.open(ref.path);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
			if (code === "ENOENT") throw new AppServerError("NOT_FOUND", { sessionId: ref.summary.sessionId });
			if (error instanceof Error && error.name === "SessionLeaseError") {
				throw new AppServerError("SESSION_IN_USE", { sessionId: ref.summary.sessionId });
			}
			if (error instanceof Error && /^(CorruptSessionError|SessionJournalPoisonedError)$/.test(error.name)) {
				throw new AppServerError("SESSION_CORRUPT", { sessionId: ref.summary.sessionId });
			}
			throw new AppServerError("OPERATION_FAILED", { sessionId: ref.summary.sessionId });
		}
		try {
			const runtime = await createAgentSessionRuntime(this.createRuntime, {
				cwd: manager.getCwd(),
				agentDir: this.agentDir,
				sessionManager: manager,
			});
			try {
				const opened = new OpenedAgentSessionRuntime(
					runtime,
					ref,
					this.agentDir,
					this.options.interactions,
					this.authStorage,
					(mutation) => this.mutateMcp(mutation),
				);
				await opened.initialize();
				return opened;
			} catch (error) {
				await runtime.dispose().catch(() => undefined);
				throw error;
			}
		} catch (error) {
			manager.close();
			if (error instanceof AppServerError) throw error;
			throw new AppServerError("OPERATION_FAILED", { sessionId: ref.summary.sessionId });
		}
	}
}
