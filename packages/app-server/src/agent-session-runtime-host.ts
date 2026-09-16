import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
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
	AgentError,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type AgentSummary,
	AuthStorage,
	agentTaskWindow,
	buildChildSystemPrompt,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createAskUserToolDefinition,
	DefaultResourceLoader,
	formatSessionAttachments,
	formatSessionFileSelections,
	getLatestCacheHitPercent,
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	importSessionAttachments,
	installScheduleHost,
	isScheduleSessionEligible,
	loadAgentTypeDefinitions,
	McpConfigurationConflictError,
	McpConfigurationCoordinator,
	type McpCredentialChange,
	type McpServerSettings,
	mcpCredentialState,
	mcpCredentialStatus,
	type PluginSnapshot,
	ProjectTrustStore,
	QueuedTurnBusyError,
	QueuedTurnConflictError,
	type QueuedTurnDraft,
	QueuedTurnLimitError,
	QueuedTurnNotFoundError,
	RequestIdReusedError,
	readCustomAgentTypes,
	readPluginSnapshot,
	readThreadGoal,
	reducePlanState,
	reduceRuntimeJournal,
	removeCustomAgentType,
	removeSessionAttachment,
	resolveMcpServerSettings,
	resolvePluginMcpSettings,
	SCHEDULE_MAIN_PROMPT,
	type ScheduleManager,
	SessionDeliveredArtifacts,
	SessionManager,
	SettingsManager,
	type Skill,
	splitSessionAttachmentPrompt,
	storePluginMcpCredential,
	upsertCustomAgentType,
} from "@metis/coding-agent/host";
import { AgentLiveProjector } from "./agent-live-projector.ts";
import { createBrowserPermissionAudit } from "./browser-permission-audit.ts";
import { BROWSER_TOOL_NAMES, browserToolCall, createBrowserToolDefinitions } from "./browser-tools.ts";
import type { CredentialCoordinator } from "./credential-coordinator.ts";
import {
	type DurableSessionMutation,
	type PreparedSessionMutation,
	prepareSessionMutation,
} from "./durable-mutation.ts";
import { resolveFileSelections } from "./file-selection-context.ts";
import type { InteractionBroker } from "./interactions.ts";
import {
	opaqueId,
	projectAssistantOutputTokens,
	projectGoal,
	projectLatestTasks,
	projectLiveMessage as projectLiveItemMessage,
	projectMessageEntry,
	projectPlanEntry,
	projectPlanView,
	projectSessionEntry,
	projectTasksFromToolResult,
	timestamp,
} from "./item-projection.ts";
import { inspectMcpImport as inspectMcpImportSource, resolveMcpImport } from "./mcp-import.ts";
import {
	inputMcpServer,
	mcpDefinitionAtScope,
	mcpRevision,
	publicMcpDetail,
	publicMcpServers,
} from "./mcp-projection.ts";
import { openDeliveredFile as openDeliveredFileOnDisk } from "./open-delivered-file.ts";
import { ProcessProjector } from "./process-projector.ts";
import { SessionProjection } from "./projection/session-projection.ts";
import { readDeliveredFile as readDeliveredFileOnDisk } from "./read-delivered-file.ts";
import {
	AppServerError,
	type OpenedSessionRuntime,
	type PluginRuntimeStatus,
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

const MAX_TURNS = 200;

function mcpCredentialChange(input?: McpCredentialInput): McpCredentialChange {
	return input
		? {
				action: "replace",
				...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
				...(input.environment ? { environment: input.environment } : {}),
			}
		: { action: "preserve" };
}

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

function throwAgentError(error: unknown, input: { sessionId: string; requestId?: string }): never {
	if (error instanceof AppServerError) throw error;
	if (error instanceof AgentError) {
		if (error.code === "UNKNOWN_AGENT" || error.code === "NOT_DESCENDANT") {
			throw new AppServerError("NOT_FOUND", input);
		}
		if (error.code === "UNKNOWN_CURSOR") throw new AppServerError("INVALID_CURSOR", input);
		if (error.code === "INVALID_INPUT" || error.code === "UNKNOWN_TASK") {
			throw new AppServerError("INVALID_PARAMS", input);
		}
		if (error.code === "INVALID_STATE") throw new AppServerError("BUSY", input);
		if (error.code === "QUEUE_FULL") throw new AppServerError("OVERLOADED", input);
	}
	throw new AppServerError("OPERATION_FAILED", input);
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

function agentTaskView(
	task: NonNullable<AgentSummary["currentTask"]>,
	includeResult = true,
): NonNullable<SessionSnapshot["agents"][number]["currentTask"]> {
	return {
		taskId: task.taskId,
		status: task.status,
		taskSummary: task.taskSummary,
		...(includeResult && task.finalMessage ? { finalMessage: task.finalMessage } : {}),
		...(includeResult && task.error ? { error: task.error } : {}),
		...(task.usage ? { usage: { ...task.usage, model: { ...task.usage.model } } } : {}),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
}

function agentSummaryView(summary: AgentSummary): SessionSnapshot["agents"][number] {
	return {
		agentId: summary.agentId,
		name: summary.name,
		agentType: summary.agentType,
		depth: summary.depth,
		status: summary.status,
		archived: summary.archived,
		parentSessionId: summary.parentSessionId,
		rootSessionId: summary.rootSessionId,
		agentPath: [...summary.agentPath],
		tasks: summary.tasks.map((task) => agentTaskView(task, false)),
		...(summary.currentTask ? { currentTask: agentTaskView(summary.currentTask) } : {}),
		...(summary.latestTask ? { latestTask: agentTaskView(summary.latestTask) } : {}),
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
	};
}

const MAX_AGENT_COLLECTION_UTF8_BYTES = 1024 * 1024;

function boundedAgentSummaryViews(
	summaries: readonly AgentSummary[],
	limit: number,
): SessionSnapshot["agents"][number][] {
	const views: SessionSnapshot["agents"][number][] = [];
	let bytes = 2;
	for (const summary of summaries) {
		if (views.length >= limit) break;
		const view = agentSummaryView(summary);
		const viewBytes = Buffer.byteLength(JSON.stringify(view), "utf8") + (views.length > 0 ? 1 : 0);
		if (views.length > 0 && bytes + viewBytes > MAX_AGENT_COLLECTION_UTF8_BYTES) break;
		views.push(view);
		bytes += viewBytes;
	}
	return views;
}

function mapRuntimeTurns(
	journal: readonly unknown[],
	reduced: ReturnType<typeof reduceRuntimeJournal>,
	sessionId: string,
	fallbackTimestamp: string,
): TurnView[] {
	const times = new Map<string, { startedAt: string; completedAt?: string }>();
	const operations = new Map(reduced.operations.map((operation) => [operation.operationId, operation]));
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
		const operationError = turn.operationIds
			.map((operationId) => operations.get(operationId)?.error)
			.find((error) => error !== undefined);
		const errorName =
			operationError && /^[A-Z][A-Z0-9_]{0,63}$/u.test(operationError.code)
				? operationError.code
				: operationError
					? "RUNTIME_INTERRUPTED"
					: undefined;
		return {
			turnId: opaqueId(turn.turnId, "turn"),
			sessionId,
			operationIds: [...new Set(turn.operationIds.map((id) => opaqueId(id, "operation")))].slice(-256),
			state: turn.state === "active" ? "running" : turn.state,
			startedAt: at.startedAt,
			...(at.completedAt === undefined ? {} : { completedAt: at.completedAt }),
			...(errorName === undefined
				? {}
				: {
						error: {
							name: errorName,
							retryable: ![
								"MODEL_ENDPOINT_NOT_FOUND",
								"MODEL_AUTHENTICATION_FAILED",
								"MODEL_ACCESS_DENIED",
							].includes(errorName),
						},
					}),
		};
	});
}

class OpenedAgentSessionRuntime implements OpenedSessionRuntime {
	private readonly listeners = new Set<SessionEventListener>();
	private readonly runtime: AgentSessionRuntime;
	private session: AgentSession;
	private readonly ref: SessionRef;
	private readonly processProjector = new ProcessProjector();
	private readonly projection: SessionProjection;
	private readonly agentLive: AgentLiveProjector;
	private readonly liveItemIds = new WeakMap<object, string>();
	private readonly liveMessagesByItemId = new Map<string, object>();
	private readonly durableEntryIdsByLiveItemId = new Map<string, string>();
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
	private readonly mcpConfiguration: McpConfigurationCoordinator;
	private unread: boolean;
	private readonly notifiedQueueFailureRevisions = new Set<string>();
	private appliedPluginFingerprint?: string;
	private pluginReloadError?: string;
	private pluginReloadPromise?: Promise<void>;

	constructor(
		runtime: AgentSessionRuntime,
		ref: SessionRef,
		agentDir: string,
		interactions?: InteractionBroker,
		authStorage?: AuthStorage,
		mcpConfiguration?: McpConfigurationCoordinator,
	) {
		this.runtime = runtime;
		this.session = runtime.session;
		this.ref = ref;
		this.agentDir = agentDir;
		this.interactions = interactions;
		this.authStorage = authStorage;
		if (!mcpConfiguration) throw new Error("Opened MCP session requires a configuration coordinator");
		this.mcpConfiguration = mcpConfiguration;
		this.unread = ref.summary.unread;
		try {
			this.appliedPluginFingerprint = readPluginSnapshot(agentDir).fingerprint;
		} catch (error) {
			this.appliedPluginFingerprint = undefined;
			this.pluginReloadError = error instanceof Error ? error.message : String(error);
		}
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
		const deliveredFiles = this.deliveredFileViews();
		this.projection = new SessionProjection({
			session: this.summaryFromRuntime(journal, reduced),
			turns,
			items,
			tasks: projectLatestTasks(this.session.sessionManager.getBranch()),
			deliveredFiles,
			goal: projectGoal(this.session.getGoal()),
			queuedTurns: queuedTurns.map(queuedTurnView),
		});
		this.agentLive = new AgentLiveProjector(
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
		this.runtime.setBeforeTurnAdmission(async () => {
			await this.ensurePluginsCurrent();
		});
	}

	async ensurePluginsCurrent(): Promise<void> {
		if (this.closed || this.isActive()) {
			return;
		}
		if (this.pluginReloadPromise) {
			await this.pluginReloadPromise;
			return;
		}
		let snapshot: PluginSnapshot;
		try {
			snapshot = readPluginSnapshot(this.agentDir);
		} catch (error) {
			this.pluginReloadError = error instanceof Error ? error.message : String(error);
			return;
		}
		if (snapshot.fingerprint === this.appliedPluginFingerprint) {
			return;
		}
		this.pluginReloadPromise = (async () => {
			try {
				if (this.isActive()) return;
				await this.session.reload({ pluginSnapshot: snapshot });
				this.appliedPluginFingerprint = snapshot.fingerprint;
				this.pluginReloadError = undefined;
			} catch (error) {
				this.pluginReloadError = error instanceof Error ? error.message : String(error);
				// Retain existing session runtime so user turns and queues are not lost if reload fails
			} finally {
				this.pluginReloadPromise = undefined;
			}
		})();
		await this.pluginReloadPromise;
	}

	getPluginRuntimeStatus(): PluginRuntimeStatus {
		return {
			sessionId: this.sessionId,
			...(this.appliedPluginFingerprint ? { appliedFingerprint: this.appliedPluginFingerprint } : {}),
			...(this.pluginReloadError ? { error: this.pluginReloadError } : {}),
		};
	}

	private async bindExtensionUI(session: AgentSession): Promise<void> {
		const uiContext = this.interactions?.createExtensionUIContext(this.sessionId, (event) => this.publish(event));
		if (this.interactions) {
			const deliveredArtifacts = session.deliveredArtifacts;
			if (!deliveredArtifacts) throw new Error("Interactive session is missing delivered artifact storage");
			const browserTools = createBrowserToolDefinitions(
				(request) =>
					this.interactions!.requestBrowserTool(
						this.sessionId,
						request.toolCallId,
						browserToolCall(request),
						request.signal,
					),
				createBrowserPermissionAudit({
					sessionId: this.sessionId,
					sink: {
						append: async (event) => {
							await session.appendPermissionAuditEvent(event);
						},
					},
				}),
			);
			session.installHostTools(
				[
					createAskUserToolDefinition((request) => this.interactions!.requestUserInput(this.sessionId, request)),
					...browserTools,
					deliveredArtifacts.createToolDefinition(),
				],
				{
					automaticPermissionToolNames: ["ask_user", ...BROWSER_TOOL_NAMES],
				},
			);
		}
		session.setPermissionApprovalHandler((request) =>
			this.interactions
				? this.interactions.requestPermissionApproval(this.sessionId, request)
				: Promise.resolve({ decision: "deny", reason: "No interactive session owner is available" }),
		);
		await session.bindExtensions({
			...(uiContext ? { uiContext, mode: "rpc" } : {}),
			onError: (error) => {
				if (uiContext) {
					uiContext.notify(`[${error.event}] ${error.error}`, "error");
				}
			},
		});
	}

	get sessionId(): string {
		return this.ref.summary.sessionId;
	}

	private bind(session: AgentSession): void {
		this.unsubscribeAgent?.();
		this.unsubscribeSubagents?.();
		this.agentLive.clear();
		this.session = session;
		this.unsubscribeAgent = session.subscribe((event) => this.onAgentEvent(event));
		this.unsubscribeSubagents = this.runtime.subagentManager?.subscribe((event) => {
			if (event.type === "activity") {
				this.publishProcess(event.event, event.agentId);
				this.agentLive.apply(event.agentId, event.taskId, event.event);
				return;
			}
			if (event.type === "deleted") {
				for (let index = 0; index < event.deletedAgentIds.length; index += 256) {
					this.publish({
						type: "agent/deleted",
						sessionId: this.sessionId,
						agentId: event.agentId,
						deletedAgentIds: event.deletedAgentIds.slice(index, index + 256),
					});
				}
				for (const agentId of event.deletedAgentIds) this.agentLive.clear(agentId);
				return;
			}
			if (event.type !== "updated") return;
			this.publish({
				type: "agent/updated",
				sessionId: this.sessionId,
				agent: agentSummaryView(event.summary),
			});
			if (
				event.summary.status === "done" ||
				event.summary.status === "failed" ||
				event.summary.status === "stopped" ||
				event.summary.archived
			) {
				this.agentLive.clear(event.summary.agentId);
				const taskId = event.summary.currentTask?.taskId ?? event.summary.latestTask?.taskId;
				if (taskId) {
					this.publish({
						type: "agent/itemsChanged",
						sessionId: this.sessionId,
						agentId: event.summary.agentId,
						taskId,
					});
				}
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

	private deliveredFileViews(): SessionDeliveredFileView[] {
		return this.session.deliveredArtifacts?.list() ?? [];
	}

	private deliveredFileMap(): ReadonlyMap<string, SessionDeliveredFileView> {
		return new Map(this.deliveredFileViews().map((file) => [file.fileId, file]));
	}

	private publishProcess(event: AgentSessionEvent, agentId?: string): void {
		const process = this.processProjector.apply(event, agentId);
		if (process) this.publish({ type: "session/processChanged", sessionId: this.sessionId, process });
	}

	private onAgentEvent(event: AgentSessionEvent): void {
		this.publishProcess(event);
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
			if (
				event.message.role === "toolResult" &&
				event.message.toolName === "deliver_file" &&
				event.message.isError === false
			) {
				this.publish({
					type: "session/deliveredFilesChanged",
					sessionId: this.sessionId,
					deliveredFiles: this.deliveredFileViews(),
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
		if (event.type === "plan_changed") {
			const journal = this.journal();
			for (const entryId of event.entryIds) {
				const entry = journal.find(
					(candidate) =>
						typeof candidate === "object" &&
						candidate !== null &&
						(candidate as { type?: unknown }).type === "session_plan_proposal" &&
						(candidate as { id?: unknown }).id === entryId,
				) as Record<string, unknown> | undefined;
				if (!entry) continue;
				const item = this.projectJournalItem(entry);
				if (item) this.publish({ type: "item/completed", item });
			}
			return;
		}
		if (event.type === "collaboration_mode_changed") {
			this.publish({
				type: "session/collaborationModeChanged",
				sessionId: this.sessionId,
				collaborationMode: event.collaborationMode,
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
		if (event.type === "agent_end") {
			this.releasePersistedLiveMessages();
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
			return;
		}
		if (event.type === "sandbox_health_changed") {
			this.publishPermissionPresetChanged();
			return;
		}
		if (event.type === "permission_review_started") {
			this.publish({
				type: "session/permissionReviewStarted",
				sessionId: this.sessionId,
				actionId: event.actionId,
				reviewer: event.reviewer,
				riskLevel: event.riskLevel,
			});
			return;
		}
		if (event.type === "permission_review_completed") {
			this.publish({
				type: "session/permissionReviewCompleted",
				sessionId: this.sessionId,
				actionId: event.actionId,
				reviewer: event.reviewer,
				outcome: event.outcome,
				riskLevel: event.riskLevel,
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

	private releasePersistedLiveMessages(): void {
		for (const [itemId, message] of this.liveMessagesByItemId) {
			const entryId = this.session.sessionManager.getMessageEntryId(message);
			if (entryId) this.durableEntryIdsByLiveItemId.set(itemId, entryId);
			this.liveMessagesByItemId.delete(itemId);
		}
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
			deliveredFiles: this.deliveredFileMap(),
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
		if (entry.type === "session_plan_proposal") {
			const plan = this.session.sessionManager
				.getPlanState()
				.plans.find((candidate) => candidate.entryId === entry.id);
			if (!plan) return undefined;
			return projectPlanEntry({
				entry: { id: String(entry.id), timestamp: String(entry.timestamp ?? "") },
				plan,
				sessionId: this.sessionId,
				fallbackTimestamp: this.ref.summary.createdAt,
			});
		}
		const reduced = this.reduced();
		return projectSessionEntry({
			entry,
			sessionId: this.sessionId,
			turnStates: new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state])),
			toolStates: new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state])),
			deliveredFiles: this.deliveredFileMap(),
			fallbackTimestamp: this.ref.summary.createdAt,
		});
	}

	private itemsFromJournal(
		journal: readonly unknown[] = this.journal(),
		reduced: ReturnType<typeof reduceRuntimeJournal> = reduceRuntimeJournal(journal),
	): ItemView[] {
		const activeBranchIds = new Set(this.session.sessionManager.getBranch().map(({ id }) => id));
		const planState = reducePlanState(journal, activeBranchIds);
		const planByEntryId = new Map(planState.plans.map((plan) => [plan.entryId, plan]));
		const turnStates = new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state]));
		const toolStates = new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state]));
		const deliveredFiles = this.deliveredFileMap();
		return journal
			.map((entry) => {
				const record = entry as Record<string, unknown>;
				if (record.type === "session_plan_proposal") {
					const plan = planByEntryId.get(String(record.id));
					if (!plan) return undefined;
					return projectPlanEntry({
						entry: { id: String(record.id), timestamp: String(record.timestamp ?? "") },
						plan,
						sessionId: this.sessionId,
						fallbackTimestamp: this.ref.summary.createdAt,
					});
				}
				return projectSessionEntry({
					entry: record,
					sessionId: this.sessionId,
					turnStates,
					toolStates,
					deliveredFiles,
					fallbackTimestamp: this.ref.summary.createdAt,
				});
			})
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

	async fork(input: { entryId: string; name: string; requestId: string; targetSessionId: string }): Promise<string> {
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
			const persistedEntryId =
				this.durableEntryIdsByLiveItemId.get(entryId) ?? (message ? manager.getMessageEntryId(message) : undefined);
			if (!persistedEntryId) throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
			entryId = persistedEntryId;
		}
		const branched = manager.createBranchedSessionManager(entryId, {
			id: input.targetSessionId,
			initialName: optionalName(input.name),
			managedWorkspaceRecoveryKey: input.requestId,
			initialCustomEntries: [
				{
					customType: "metis.app-server.session-fork.v1",
					data: {
						requestId: input.requestId,
						sourceSessionId: this.sessionId,
						entryId: input.entryId,
					},
				},
			],
		});
		try {
			const forkedSessionId = branched.getSessionId();
			this.session.deliveredArtifacts?.copyTo(branched);
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
				statuses: this.session.mcp?.getStatus() ?? [],
				serverConfigs: this.session.mcp?.getServerConfigs() ?? [],
				credentialStatus: (scope, name, server) =>
					mcpCredentialStatus(this.authStorage, this.mcpCwd(), scope, name, server),
			}),
		};
	}

	private mcpRow(scope: "user" | "project" | "plugin", name: string) {
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
		const credentialState = current
			? mcpCredentialState(this.authStorage, this.mcpCwd(), scope, name, current)
			: undefined;
		if (!current || mcpRevision(scope, name, current, credentialState) !== expectedRevision) {
			throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId });
		}
		return current;
	}

	private mutateMcpWhileIdle<T>(requestId: string, mutation: () => Promise<T>): Promise<T> {
		return (async () => {
			if (this.isActive() || this.hasPendingInteractions()) {
				throw new AppServerError("BUSY", { sessionId: this.sessionId, requestId });
			}
			await this.session.mcp?.ensureCurrent();
			return await mutation();
		})();
	}

	private async persistMcpDefinition(
		scope: "user" | "project",
		name: string,
		next: McpServerSettings | undefined,
		expectedRevision: string | null,
		requestId: string,
		credential?: McpCredentialInput | null,
	): Promise<void> {
		try {
			await this.mcpConfiguration.mutate({
				settingsManager: this.session.settingsManager,
				cwd: this.mcpCwd(),
				scope,
				changes: [
					{
						name,
						expectedRevision,
						next,
						credential:
							credential === null
								? { action: "remove" }
								: credential
									? {
											action: "replace",
											...(credential.bearerToken ? { bearerToken: credential.bearerToken } : {}),
											...(credential.environment ? { environment: credential.environment } : {}),
										}
									: { action: next ? "preserve" : "remove" },
					},
				],
			});
		} catch (error) {
			if (error instanceof McpConfigurationConflictError) {
				throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId });
			}
			throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId });
		}
	}

	async listMcpServers(): Promise<ClientResult<"mcp/list">> {
		await this.session.mcp?.ensureCurrent();
		return this.mcpRows();
	}

	async inspectMcpImport(input: ClientParams<"mcp/import/inspect">): Promise<ClientResult<"mcp/import/inspect">> {
		this.assertMcpSession(input);
		this.assertProjectMcpWrite(input.scope, "inspect");
		await this.session.mcp?.ensureCurrent();
		const settings =
			input.scope === "user"
				? this.session.settingsManager.getGlobalSettings()
				: this.session.settingsManager.getProjectSettings();
		const existing = new Map(
			Object.entries(settings.mcpServers ?? {}).map(([name, server]) => [
				name,
				mcpRevision(
					input.scope,
					name,
					server,
					mcpCredentialState(this.authStorage, this.mcpCwd(), input.scope, name, server),
				),
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
			await this.session.settingsManager.reload();
			const changes = resolved.entries.map((entry) => {
				const current = mcpDefinitionAtScope(this.session.settingsManager, input.scope, entry.name);
				return {
					name: entry.name,
					expectedRevision: entry.expectedRevision,
					next: inputMcpServer(entry.server, current, this.mcpCwd()),
					credential: entry.credential
						? {
								action: "replace" as const,
								...(entry.credential.bearerToken ? { bearerToken: entry.credential.bearerToken } : {}),
								...(entry.credential.environment ? { environment: entry.credential.environment } : {}),
							}
						: ({ action: "preserve" } as const),
				};
			});
			try {
				await this.mcpConfiguration.mutate({
					settingsManager: this.session.settingsManager,
					cwd: this.mcpCwd(),
					scope: input.scope,
					changes,
				});
				return this.mcpRows();
			} catch (error) {
				if (error instanceof McpConfigurationConflictError) {
					throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId: input.requestId });
				}
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
		});
	}

	async getMcpServer(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">> {
		this.assertMcpSession(input);
		await this.session.mcp?.ensureCurrent();
		const server = this.mcpRow(input.scope, input.name);
		return publicMcpDetail(server, server.effective ? this.session.mcp?.getCatalog(input.name) : undefined);
	}

	async getMcpCatalogItem(input: ClientParams<"mcp/catalog/get">): Promise<ClientResult<"mcp/catalog/get">> {
		this.assertMcpSession(input);
		try {
			await this.session.mcp?.ensureCurrent();
			if (!this.session.mcp) throw new Error("MCP unavailable");
			return this.session.mcp.getCatalogItem(input.server, input.kind, input.id);
		} catch {
			throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
		}
	}

	async upsertMcpServer(input: ClientParams<"mcp/upsert">): Promise<ClientResult<"mcp/upsert">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			this.assertProjectMcpWrite(input.scope, input.requestId);
			await this.session.settingsManager.reload();
			const current = mcpDefinitionAtScope(this.session.settingsManager, input.scope, input.name);
			let next: McpServerSettings;
			try {
				next = inputMcpServer(input.server, current, this.mcpCwd());
			} catch {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			await this.persistMcpDefinition(
				input.scope,
				input.name,
				next,
				input.expectedRevision,
				input.requestId,
				input.credential,
			);
			return this.mcpRows();
		});
	}

	async removeMcpServer(input: ClientParams<"mcp/remove">): Promise<ClientResult<"mcp/remove">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			if (input.scope === "plugin") {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			this.assertProjectMcpWrite(input.scope, input.requestId);
			await this.persistMcpDefinition(input.scope, input.name, undefined, input.expectedRevision, input.requestId);
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
			if (input.scope === "plugin") {
				const row = this.mcpRow("plugin", input.name);
				if (row.revision !== input.expectedRevision) {
					throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId: input.requestId });
				}
				try {
					if (!this.session.mcp) throw new Error("MCP unavailable");
					await this.session.mcp.restart(input.name);
				} catch {
					throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
				}
				return await this.getMcpServer(input);
			}
			const scope = input.scope as "user" | "project";
			this.effectiveMcpDefinition({ ...input, scope });
			try {
				if (!this.session.mcp) throw new Error("MCP unavailable");
				await this.session.mcp.restart(input.name);
			} catch {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			return await this.getMcpServer(input);
		});
	}

	async setMcpCredential(input: ClientParams<"mcp/credential/set">): Promise<ClientResult<"mcp/credential/set">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			if (input.scope === "plugin") {
				if (!this.authStorage) {
					throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
				}
				const row = this.mcpRow("plugin", input.name);
				if (row.revision !== input.expectedRevision) {
					throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId: input.requestId });
				}
				if (input.credential.bearerToken && row.transport !== "http") {
					throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
				}
				let config = this.session.mcp?.getServerConfig(input.name);
				if (!config) {
					const snapshot = readPluginSnapshot(this.agentDir);
					const comp = snapshot.mcp.find((c) => c.name === input.name);
					if (!comp)
						throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId, requestId: input.requestId });
					const instantiated = resolvePluginMcpSettings(comp, this.mcpCwd());
					config = resolveMcpServerSettings(
						comp.name,
						instantiated,
						this.mcpCwd(),
						process.env,
						{ scope: "user", name: comp.name },
						{ pluginOwner: comp.owner, originalName: comp.originalName },
					);
				}
				storePluginMcpCredential(this.authStorage, config, {
					action: "replace",
					...(input.credential.bearerToken ? { bearerToken: input.credential.bearerToken } : {}),
					...(input.credential.environment ? { environment: input.credential.environment } : {}),
				});
				await this.session.mcp?.ensureCurrent();
				return await this.getMcpServer(input);
			}
			const scope = input.scope as "user" | "project";
			const current = this.effectiveMcpDefinition({ ...input, scope });
			if (input.credential.bearerToken && typeof current.url !== "string") {
				throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
			}
			await this.persistMcpDefinition(
				scope,
				input.name,
				current,
				input.expectedRevision,
				input.requestId,
				input.credential,
			);
			return await this.getMcpServer(input);
		});
	}

	async clearMcpCredential(
		input: ClientParams<"mcp/credential/clear">,
	): Promise<ClientResult<"mcp/credential/clear">> {
		return this.mutateMcpWhileIdle(input.requestId, async () => {
			this.assertMcpSession(input);
			if (input.scope === "plugin") {
				if (!this.authStorage) {
					throw new AppServerError("OPERATION_FAILED", { sessionId: this.sessionId, requestId: input.requestId });
				}
				const row = this.mcpRow("plugin", input.name);
				if (row.revision !== input.expectedRevision) {
					throw new AppServerError("CONFLICT", { sessionId: this.sessionId, requestId: input.requestId });
				}
				let config = this.session.mcp?.getServerConfig(input.name);
				if (!config) {
					const snapshot = readPluginSnapshot(this.agentDir);
					const comp = snapshot.mcp.find((c) => c.name === input.name);
					if (!comp)
						throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId, requestId: input.requestId });
					const instantiated = resolvePluginMcpSettings(comp, this.mcpCwd());
					config = resolveMcpServerSettings(
						comp.name,
						instantiated,
						this.mcpCwd(),
						process.env,
						{ scope: "user", name: comp.name },
						{ pluginOwner: comp.owner, originalName: comp.originalName },
					);
				}
				storePluginMcpCredential(this.authStorage, config, { action: "remove" });
				await this.session.mcp?.ensureCurrent();
				return await this.getMcpServer(input);
			}
			const scope = input.scope as "user" | "project";
			const current = this.effectiveMcpDefinition({ ...input, scope });
			await this.persistMcpDefinition(scope, input.name, current, input.expectedRevision, input.requestId, null);
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
			const resolved = this.session.deliveredArtifacts?.resolve(input.fileId);
			if (!resolved) throw new Error("Delivered file was not found");
			await openDeliveredFileOnDisk({
				path: resolved.path,
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
			const resolved = this.session.deliveredArtifacts?.resolve(input.fileId);
			if (!resolved) throw new Error("Delivered file was not found");
			return await readDeliveredFileOnDisk(resolved);
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
		const contextBasis =
			context?.tokens == null
				? "unavailable"
				: context.basis === "reported_total"
					? "reported_total"
					: "estimated_total";
		let contextBreakdown: ClientResult<"session/status">["contextBreakdown"] =
			context?.tokens == null ? null : context.tokens === 0 ? [] : null;
		if (context?.tokens != null && context.breakdown) {
			const categories = context.breakdown.map((item) => item.category);
			const sum = context.breakdown.reduce((total, item) => total + item.tokens, 0);
			if (new Set(categories).size === categories.length && sum === context.tokens) {
				contextBreakdown = [...context.breakdown];
			}
		}
		return {
			sessionId: input.sessionId,
			mode: stats.mode,
			contextTokens: context?.tokens ?? null,
			contextWindow: context?.contextWindow ?? null,
			contextBasis,
			contextBreakdown,
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

	async listAgents(input: ClientParams<"agent/list">): Promise<ClientResult<"agent/list">> {
		const manager = this.runtime.subagentManager;
		if (!manager) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
		const agents = manager.listSummaries(this.sessionId, input.includeArchived ?? false);
		const limit = input.limit ?? 20;
		let start = 0;
		if (input.afterAgentId) {
			const cursor = agents.findIndex((agent) => agent.agentId === input.afterAgentId);
			if (cursor < 0) throw new AppServerError("INVALID_CURSOR", { sessionId: input.sessionId });
			start = cursor + 1;
		}
		const candidates = agents.slice(start, start + limit);
		const views = boundedAgentSummaryViews(candidates, limit);
		const page = candidates.slice(0, views.length);
		return {
			agents: views,
			nextAfterAgentId: start + page.length < agents.length ? (page.at(-1)?.agentId ?? null) : null,
		};
	}

	async readAgentItems(input: ClientParams<"agent/readItems">): Promise<ClientResult<"agent/readItems">> {
		const manager = this.runtime.subagentManager;
		if (!manager) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
		const completeJournal = await manager
			.readJournal(this.sessionId, input.agentId)
			.catch((error: unknown) => throwAgentError(error, input));
		let journal = completeJournal;
		if (input.taskId) {
			const window = agentTaskWindow(completeJournal, input.taskId);
			if (!window) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
			const scoped = completeJournal.slice(window.start, window.end + 1);
			journal = completeJournal[0] ? [completeJournal[0], ...scoped] : scoped;
		}
		const reduced = reduceRuntimeJournal(journal);
		const turns = new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state]));
		const tools = new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state]));
		const selected = manager.listSummaries(this.sessionId, true).find((agent) => agent.agentId === input.agentId);
		const includeLive = !input.taskId || selected?.currentTask?.taskId === input.taskId;
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
			.concat(includeLive ? this.agentLive.currentItems(input.agentId) : []);
		const end = input.beforeItemId ? items.findIndex((item) => item.itemId === input.beforeItemId) : items.length;
		if (input.beforeItemId && end < 0) {
			throw new AppServerError("INVALID_CURSOR", { sessionId: input.sessionId });
		}
		const start = Math.max(0, end - input.limit);
		return { items: items.slice(start, end), nextBeforeItemId: start > 0 ? items[start]!.itemId : null };
	}

	async interruptAgent(input: ClientParams<"agent/interrupt">): Promise<ClientResult<"agent/interrupt">> {
		const manager = this.runtime.subagentManager;
		if (!manager) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
		try {
			await manager.interrupt(this.sessionId, input.agentId);
		} catch (error) {
			throwAgentError(error, input);
		}
		const summary = manager.listSummaries(this.sessionId, true).find((entry) => entry.agentId === input.agentId);
		if (!summary) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
		return { agent: agentSummaryView(summary) };
	}

	async archiveAgent(input: ClientParams<"agent/archive">): Promise<ClientResult<"agent/archive">> {
		const manager = this.runtime.subagentManager;
		if (!manager) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
		try {
			return { agent: agentSummaryView(await manager.setArchived(this.sessionId, input.agentId, input.archived)) };
		} catch (error) {
			throwAgentError(error, input);
		}
	}

	async deleteAgent(input: ClientParams<"agent/delete">): Promise<ClientResult<"agent/delete">> {
		const manager = this.runtime.subagentManager;
		if (!manager) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
		let deleted: Awaited<ReturnType<typeof manager.deleteAgent>>;
		try {
			deleted = await manager.deleteAgent(this.sessionId, input.agentId);
		} catch (error) {
			throwAgentError(error, input);
		}
		if (deleted.status !== "deleted") {
			throw new AppServerError("OPERATION_FAILED", { sessionId: input.sessionId, requestId: input.requestId });
		}
		return { agentId: input.agentId, status: "deleted" };
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

	async setPermissionPreset(
		input: ClientParams<"session/setPermissionPreset">,
	): Promise<ClientResult<"session/setPermissionPreset">> {
		try {
			await this.session.setPermissionPreset(input.permissionPreset);
		} catch {
			this.publishPermissionPresetChanged();
			throw new AppServerError("OPERATION_FAILED", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
		return this.publishPermissionPresetChanged();
	}

	async setCollaborationMode(
		input: ClientParams<"session/setCollaborationMode">,
	): Promise<ClientResult<"session/setCollaborationMode">> {
		if (this.ref.scheduled || this.session.sessionManager.getHeader()?.agent) {
			throw new AppServerError("READ_ONLY_SESSION", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
		if (this.isActive() || this.hasPendingInteractions()) {
			throw new AppServerError("BUSY", { sessionId: input.sessionId, requestId: input.requestId });
		}
		if (input.collaborationMode === "default" && this.session.sessionManager.getPlanState().currentPlan) {
			throw new AppServerError("CONFLICT", { sessionId: input.sessionId, requestId: input.requestId });
		}
		try {
			await this.session.setCollaborationMode(input.collaborationMode);
		} catch {
			throw new AppServerError("OPERATION_FAILED", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
		return { collaborationMode: this.session.sessionManager.getCollaborationMode() };
	}

	async startPlanExecution(input: ClientParams<"plan/startExecution">): Promise<ClientResult<"plan/startExecution">> {
		if (this.ref.scheduled || this.session.sessionManager.getHeader()?.agent) {
			throw new AppServerError("READ_ONLY_SESSION", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
		if (this.isActive() || this.hasPendingInteractions()) {
			throw new AppServerError("BUSY", { sessionId: input.sessionId, requestId: input.requestId });
		}
		const current = this.session.sessionManager.getPlanState().currentPlan;
		if (!current || opaqueId(current.planId, "plan") !== input.planId || current.revision !== input.revision) {
			throw new AppServerError("CONFLICT", { sessionId: input.sessionId, requestId: input.requestId });
		}
		return await this.runtime.submitPrompt({
			requestId: input.requestId,
			text: "Execute the accepted plan.",
			planExecution: { planId: current.planId, revision: current.revision },
		});
	}

	async cancelPlan(input: ClientParams<"plan/cancel">): Promise<ClientResult<"plan/cancel">> {
		if (this.ref.scheduled || this.session.sessionManager.getHeader()?.agent) {
			throw new AppServerError("READ_ONLY_SESSION", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
		if (this.isActive() || this.hasPendingInteractions()) {
			throw new AppServerError("BUSY", { sessionId: input.sessionId, requestId: input.requestId });
		}
		const current = this.session.sessionManager.getPlanState().currentPlan;
		if (!current || opaqueId(current.planId, "plan") !== input.planId || current.revision !== input.revision) {
			throw new AppServerError("CONFLICT", { sessionId: input.sessionId, requestId: input.requestId });
		}
		try {
			const plan = await this.session.cancelPlan({ planId: current.planId, revision: current.revision });
			return { plan: projectPlanView(plan), collaborationMode: "default" };
		} catch {
			throw new AppServerError("OPERATION_FAILED", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
		}
	}

	async refreshWebSearchSettings(): Promise<void> {
		await this.session.refreshWebSearchSettings();
	}

	async refreshPermissionAutoSettings(): Promise<void> {
		await this.session.refreshPermissionAutoSettings();
	}

	async prepareModelServiceSettingsRefresh(): Promise<void> {
		await this.session.prepareModelServiceSettingsRefresh();
	}

	async applyModelServiceSettingsRefresh(): Promise<void> {
		await this.session.applyModelServiceSettingsRefresh();
	}

	notifyPermissionRulesChanged(): void {
		this.session.notifyPermissionRulesChanged();
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

	private permissionProtocolView(): {
		readonly permissionPreset: SessionSnapshot["permissionPreset"];
		readonly effectiveSettings: SessionSnapshot["effectiveSettings"];
		readonly constrainedByParent: boolean;
		readonly sandboxHealth: SessionSnapshot["sandboxHealth"];
	} {
		const view = this.session.permissionView;
		return {
			permissionPreset: view.permissionPreset,
			effectiveSettings: view.effectiveSettings,
			constrainedByParent: view.constrainedByParent,
			sandboxHealth: view.sandboxHealth,
		};
	}

	private publishPermissionPresetChanged(): ClientResult<"session/setPermissionPreset"> {
		const result = this.permissionProtocolView();
		this.publish({ type: "session/permissionPresetChanged", sessionId: this.sessionId, ...result });
		return result;
	}

	async snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot> {
		await this.session.refreshSandboxHealth(true);
		this.refreshLifecycleProjection();
		const agentSummaries = this.runtime.subagentManager?.listSummaries(this.sessionId, false) ?? [];
		const agents = boundedAgentSummaryViews(agentSummaries, 100);
		return this.projection.snapshot(serverEpoch, currentCursor(), {
			collaborationMode: this.session.sessionManager.getCollaborationMode(),
			...this.permissionProtocolView(),
			...(this.session.permissionView.activeReview
				? { activeReview: this.session.permissionView.activeReview }
				: {}),
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
			agents,
			nextAgentAfterId:
				agents.length < agentSummaries.length ? (agentSummaries[agents.length - 1]?.agentId ?? null) : null,
		});
	}

	async startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">> {
		const selections = await resolveFileSelections(input.fileSelections ?? [], {
			cwd: this.runtime.cwd,
			resolveDelivered: (id) => {
				const resolved = this.session.deliveredArtifacts?.resolve(id);
				return resolved ? { name: resolved.artifact.name, path: resolved.path } : undefined;
			},
		});
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
			text: formatSessionAttachments(formatSessionFileSelections(input.text, selections), attachments),
			...(input.images === undefined ? {} : { images: input.images.map(toRuntimeImage) }),
		});
	}

	async steer(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">> {
		const selections = await resolveFileSelections(input.fileSelections ?? [], {
			cwd: this.runtime.cwd,
			resolveDelivered: (id) => {
				const resolved = this.session.deliveredArtifacts?.resolve(id);
				return resolved ? { name: resolved.artifact.name, path: resolved.path } : undefined;
			},
		});
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
			text: formatSessionAttachments(formatSessionFileSelections(input.text, selections), attachments),
			...(input.images === undefined ? {} : { images: input.images.map(toRuntimeImage) }),
			streamingBehavior: input.delivery === "follow_up" ? "followUp" : "steer",
		});
	}

	async queueTurn(input: ClientParams<"turn/queue">): Promise<ClientResult<"turn/queue">> {
		const selections = await resolveFileSelections(input.fileSelections ?? [], {
			cwd: this.runtime.cwd,
			resolveDelivered: (id) => {
				const resolved = this.session.deliveredArtifacts?.resolve(id);
				return resolved ? { name: resolved.artifact.name, path: resolved.path } : undefined;
			},
		});
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
				text: formatSessionAttachments(formatSessionFileSelections(input.text, selections), attachments),
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
					this.agentLive.clear();
					this.liveMessagesByItemId.clear();
					this.durableEntryIdsByLiveItemId.clear();
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
	private readonly deliveredArtifacts: SessionDeliveredArtifacts;
	private readonly projection: SessionProjection;
	private readonly mcpServers: ClientResult<"mcp/list">;

	constructor(ref: SessionRef, agentDir: string, mcpServers: ClientResult<"mcp/list"> = { servers: [] }) {
		this.sessionId = ref.summary.sessionId;
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
		this.deliveredArtifacts = new SessionDeliveredArtifacts(agentDir, manager);
		const deliveredFiles = this.deliveredArtifacts.list();
		const deliveredFileMap = new Map(deliveredFiles.map((file) => [file.fileId, file]));
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
					deliveredFiles: deliveredFileMap,
					fallbackTimestamp: ref.summary.createdAt,
				});
			})
			.filter((item): item is ItemView => item !== undefined);
		this.projection = new SessionProjection({
			session: ref.summary,
			turns,
			items,
			tasks: projectLatestTasks(manager.getBranch()),
			deliveredFiles,
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
			const resolved = this.deliveredArtifacts.resolve(input.fileId);
			if (!resolved) throw new Error("Delivered file was not found");
			await openDeliveredFileOnDisk({
				path: resolved.path,
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
			const resolved = this.deliveredArtifacts.resolve(input.fileId);
			if (!resolved) throw new Error("Delivered file was not found");
			return await readDeliveredFileOnDisk(resolved);
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

	async readAgentItems(): Promise<ClientResult<"agent/readItems">> {
		throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
	}

	async listAgents(): Promise<ClientResult<"agent/list">> {
		throw new AppServerError("NOT_FOUND", { sessionId: this.sessionId });
	}

	async interruptAgent(): Promise<ClientResult<"agent/interrupt">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async archiveAgent(): Promise<ClientResult<"agent/archive">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async deleteAgent(): Promise<ClientResult<"agent/delete">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async setThinkingSelection(): Promise<ClientResult<"session/setThinkingSelection">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async setPermissionPreset(): Promise<ClientResult<"session/setPermissionPreset">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async setCollaborationMode(): Promise<ClientResult<"session/setCollaborationMode">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async startPlanExecution(): Promise<ClientResult<"plan/startExecution">> {
		throw new AppServerError("READ_ONLY_SESSION", { sessionId: this.sessionId });
	}

	async cancelPlan(): Promise<ClientResult<"plan/cancel">> {
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
	private readonly authStorage: AuthStorage;
	private readonly mcpConfigurationCoordinator: McpConfigurationCoordinator;
	private skillMutationTail: Promise<void> = Promise.resolve();

	constructor(options: AgentSessionRuntimeHostOptions) {
		this.options = options;
		this.agentDir = options.agentDir;
		this.trustStore = new ProjectTrustStore(options.agentDir);
		this.authStorage = options.credentials?.createView() ?? AuthStorage.create(join(options.agentDir, "auth.json"));
		this.mcpConfigurationCoordinator = new McpConfigurationCoordinator({ authStorage: this.authStorage });
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
		if (options.childConfig && !options.permissionSettingsCeiling) {
			throw new Error("Child runtime is missing its permission ceiling");
		}
		const projectTrusted = await this.resolveProjectTrust(options.cwd, options.sessionManager.getSessionId());
		const settingsManager = SettingsManager.create(options.cwd, this.agentDir, { projectTrusted });
		const child = options.childConfig;
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: this.agentDir,
			isolatedChild: child?.writePolicy === "deny",
			settingsManager,
			mcpConfigurationCoordinator: this.mcpConfigurationCoordinator,
			...(this.options.credentials ? { authStorage: this.options.credentials.createView() } : {}),
			...(child
				? {
						resourceLoaderOptions: {
							noExtensions: child.writePolicy === "deny",
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
			if (child && (!childModel || !services.modelRegistry.hasConfiguredAuth(childModel)))
				throw new Error(`Child model is unavailable: ${child.model.provider}/${child.model.modelId}`);
			const scheduleEligible =
				!child && this.options.scheduleManager !== undefined && isScheduleSessionEligible(options.sessionManager);
			const result = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				backgroundOptionalMcpStartup: !child,
				...(child
					? {
							model: childModel!,
							thinkingLevel: child.thinkingLevel,
							tools: [...child.tools],
							additionalSystemPrompt: buildChildSystemPrompt(child),
							includeAutoMemory: false,
							permissionSettingsCeiling: options.permissionSettingsCeiling,
							workspaceWritePolicy: child.writePolicy,
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

	async listAgentTypes(): Promise<ClientResult<"agentType/list">> {
		const definitions = loadAgentTypeDefinitions(this.agentDir);
		const customs = new Map(readCustomAgentTypes(this.agentDir).map((entry) => [entry.id, entry]));
		return {
			types: Object.keys(definitions).map((id) => {
				const custom = customs.get(id);
				if (custom) return { ...custom, allowedTools: [...custom.allowedTools], builtIn: false };
				const profile = definitions[id]!;
				return {
					id,
					displayName: id,
					description: profile.purpose,
					allowedTools: [...(profile.allowedTools ?? [])],
					systemPrompt: profile.systemPrompt ?? "",
					writePolicy: profile.writePolicy,
					mayDelegate: profile.mayDelegate,
					builtIn: true,
				};
			}),
		};
	}

	async upsertAgentType(input: ClientParams<"agentType/upsert">): Promise<ClientResult<"agentType/upsert">> {
		try {
			upsertCustomAgentType(this.agentDir, { ...input.type });
		} catch (cause) {
			const failure = new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			failure.cause = cause;
			throw failure;
		}
		return { type: { ...input.type, builtIn: false } };
	}

	async removeAgentType(input: ClientParams<"agentType/remove">): Promise<ClientResult<"agentType/remove">> {
		try {
			removeCustomAgentType(this.agentDir, input.id);
		} catch (cause) {
			const failure = new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
			failure.cause = cause;
			throw failure;
		}
		return { id: input.id };
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

	private draftMcpReadContext(cwd: string | null) {
		const context = this.draftSettings(cwd);
		this.authStorage.reload();
		return context;
	}

	private draftMcpRows(context: {
		readonly cwd: string;
		readonly settingsManager: SettingsManager;
	}): ClientResult<"mcp/list"> {
		const snapshot = readPluginSnapshot(this.agentDir);
		const serverConfigs = snapshot.mcp.map((comp) => {
			const instantiated = resolvePluginMcpSettings(comp, context.cwd);
			return resolveMcpServerSettings(
				comp.name,
				instantiated,
				context.cwd,
				process.env,
				{ scope: "user", name: comp.name },
				{ pluginOwner: comp.owner, originalName: comp.originalName },
			);
		});
		const pluginMcpStatuses = serverConfigs.map((config) => ({
			name: config.name,
			originalName: config.originalName,
			pluginOwner: config.pluginOwner,
			state: "connected" as const,
			transport: config.transport,
			required: config.required,
			toolCount: 0,
			resourceCount: 0,
			resourceTemplateCount: 0,
			promptCount: 0,
			capabilities: ["tools"],
		}));
		return {
			servers: publicMcpServers(context.settingsManager, {
				statuses: pluginMcpStatuses,
				serverConfigs,
				credentialStatus: (scope, name, server) =>
					mcpCredentialStatus(this.authStorage, context.cwd, scope, name, server),
			}),
		};
	}

	async listMcpServers(cwd: string | null): Promise<ClientResult<"mcp/list">> {
		return this.draftMcpRows(this.draftMcpReadContext(cwd));
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
				mcpRevision(
					input.scope,
					name,
					server,
					mcpCredentialState(this.authStorage, context.cwd, input.scope, name, server),
				),
			]),
		);
		try {
			return inspectMcpImportSource({ scope: input.scope, cwd: context.cwd, text: input.text }, existing);
		} catch {
			throw new AppServerError("INVALID_REQUEST");
		}
	}

	async importMcpServers(input: ClientParams<"mcp/import">): Promise<ClientResult<"mcp/import">> {
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
		const changes = resolved.entries.map((entry) => {
			const current = mcpDefinitionAtScope(context.settingsManager, input.scope, entry.name);
			return {
				name: entry.name,
				expectedRevision: entry.expectedRevision,
				next: inputMcpServer(entry.server, current, context.cwd),
				credential: mcpCredentialChange(entry.credential),
			};
		});
		try {
			await this.mcpConfigurationCoordinator.mutate({
				settingsManager: context.settingsManager,
				cwd: context.cwd,
				scope: input.scope,
				changes,
			});
			return this.draftMcpRows(context);
		} catch (error) {
			if (error instanceof McpConfigurationConflictError) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		}
	}

	private draftMcpContext(input: { cwd?: string | null; scope: "user" | "project" | "plugin"; requestId?: string }): {
		settingsManager: SettingsManager;
		cwd: string;
		targetCwd: string | null;
		scope: "user" | "project";
	} {
		if (input.scope === "plugin") throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		if (!("cwd" in input)) throw new AppServerError("INVALID_REQUEST", { requestId: input.requestId });
		if (input.scope === "project" && input.cwd === null) {
			throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		}
		const context = this.draftMcpReadContext(input.cwd ?? null);
		if (input.scope === "project" && !context.settingsManager.isProjectTrusted()) {
			throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		}
		return { ...context, targetCwd: input.cwd ?? null, scope: input.scope };
	}

	async getMcpServer(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">> {
		const context = this.draftMcpContext(input);
		const server = this.draftMcpRows(context).servers.find(
			(row) => row.scope === input.scope && row.name === input.name,
		);
		if (!server) throw new AppServerError("NOT_FOUND");
		return publicMcpDetail(server);
	}

	async upsertMcpServer(input: ClientParams<"mcp/upsert">): Promise<ClientResult<"mcp/upsert">> {
		const context = this.draftMcpContext(input);
		const current = mcpDefinitionAtScope(context.settingsManager, context.scope, input.name);
		try {
			const next = inputMcpServer(input.server, current, context.cwd);
			await this.mcpConfigurationCoordinator.mutate({
				settingsManager: context.settingsManager,
				cwd: context.cwd,
				scope: context.scope,
				changes: [
					{
						name: input.name,
						expectedRevision: input.expectedRevision,
						next,
						credential: mcpCredentialChange(input.credential),
					},
				],
			});
			return this.draftMcpRows(context);
		} catch (error) {
			if (error instanceof McpConfigurationConflictError) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			if (error instanceof AppServerError) throw error;
			throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		}
	}

	async removeMcpServer(input: ClientParams<"mcp/remove">): Promise<ClientResult<"mcp/remove">> {
		const context = this.draftMcpContext(input);
		try {
			await this.mcpConfigurationCoordinator.mutate({
				settingsManager: context.settingsManager,
				cwd: context.cwd,
				scope: context.scope,
				changes: [
					{
						name: input.name,
						expectedRevision: input.expectedRevision,
						next: undefined,
						credential: { action: "remove" },
					},
				],
			});
			return this.draftMcpRows(context);
		} catch (error) {
			if (error instanceof McpConfigurationConflictError) {
				throw new AppServerError("CONFLICT", { requestId: input.requestId });
			}
			if (error instanceof AppServerError) throw error;
			throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		}
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
					this.mcpConfigurationCoordinator,
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
