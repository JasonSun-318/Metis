import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ClientParams,
	ClientResult,
	DomainEvent,
	DurableImageRefView,
	ItemView,
	SessionSnapshot,
	SessionSummary,
	SkillSourceView,
	TurnView,
} from "@metis/app-protocol";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	buildChildSystemPrompt,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createAskUserToolDefinition,
	DefaultResourceLoader,
	formatSessionAttachments,
	getProjectTrustOptions,
	getSkillsDir,
	hasTrustRequiringProjectResources,
	importSessionAttachments,
	installScheduleHost,
	isScheduleSessionEligible,
	ProjectTrustStore,
	reduceRuntimeJournal,
	SCHEDULE_MAIN_PROMPT,
	type ScheduleManager,
	SessionManager,
	SettingsManager,
	type Skill,
	type SubagentSummary,
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
	projectAssistantOutputTokens,
	projectLatestTasks,
	projectLiveMessage as projectLiveItemMessage,
	projectMessageEntry,
	projectTasksFromToolResult,
	timestamp,
} from "./item-projection.ts";
import { SessionProjection } from "./projection/session-projection.ts";
import {
	AppServerError,
	type OpenedSessionRuntime,
	type SessionEventListener,
	type SessionRef,
	type SessionRuntimeHost,
} from "./session-runtime-host.ts";
import { SubagentLiveProjector } from "./subagent-live-projector.ts";

const MAX_TURNS = 200;

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
	private liveAssistantItemId?: string;
	private readonly projectedTurnStates = new Map<string, TurnView["state"]>();
	private liveItemSequence = 0;
	private unsubscribeAgent?: () => void;
	private unsubscribeSubagents?: () => void;
	private closed = false;
	private closePromise?: Promise<void>;
	private readonly interactions?: InteractionBroker;
	private readonly agentDir: string;
	private unread: boolean;

	constructor(runtime: AgentSessionRuntime, ref: SessionRef, agentDir: string, interactions?: InteractionBroker) {
		this.runtime = runtime;
		this.session = runtime.session;
		this.ref = ref;
		this.agentDir = agentDir;
		this.interactions = interactions;
		this.unread = ref.summary.unread;
		const journal = this.journal();
		const reduced = reduceRuntimeJournal(journal);
		const items = this.itemsFromJournal(journal, reduced);
		const turns = this.turnsFromJournal(journal, reduced);
		for (const turn of turns) this.projectedTurnStates.set(turn.turnId, turn.state);
		this.projection = new SessionProjection({
			session: this.summaryFromRuntime(journal, reduced),
			turns,
			items,
			tasks: projectLatestTasks(this.session.sessionManager.getBranch()),
		});
		this.subagentLive = new SubagentLiveProjector(
			this.sessionId,
			(event) => this.publish(event),
			this.ref.summary.updatedAt,
		);
		this.bind(this.session);
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
				] as never,
				{ automaticPermissionToolNames: ["ask_user"] },
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
			if (event.message.role === "assistant") this.liveAssistantItemId = undefined;
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
			if (lastTurn?.state === "completed" && completedTurnHasVisibleAssistantText(journal, lastTurn.turnId)) {
				try {
					this.session.sessionManager.setSessionUnread(true);
					this.unread = true;
				} catch {
					// Unread persistence must not break a completed agent turn.
				}
			}
			this.refreshLifecycleProjection();
			return;
		}
		if (event.type === "session_info_changed") {
			this.refreshLifecycleProjection();
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
		if (record.role === "assistant" && this.liveAssistantItemId) return this.liveAssistantItemId;
		const existing = this.liveItemIds.get(message);
		if (existing) return existing;
		this.liveItemSequence += 1;
		const value = `${this.sessionId}:${record.role}:${String(record.timestamp)}:${this.liveItemSequence}`;
		const itemId = opaqueId(`live:${createHash("sha256").update(value).digest("hex")}`, "item");
		this.liveItemIds.set(message, itemId);
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
		return projectMessageEntry({
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
				projectMessageEntry({
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

	async listSkills(): Promise<ClientResult<"skill/list">> {
		return publicSkills(this.session.resourceLoader.getSkills().skills);
	}

	private summaryFromRuntime(
		journal: readonly unknown[] = this.journal(),
		reduced: ReturnType<typeof reduceRuntimeJournal> = reduceRuntimeJournal(journal),
	): SessionSummary {
		const manager = this.session.sessionManager;
		const lastTurn = reduced.turns.at(-1);
		const lastEntry = journal.at(-1) as Record<string, unknown> | undefined;
		const sessionName = optionalName(manager.getSessionName());
		const { name: _name, recoveryNotice: _recoveryNotice, ...base } = this.ref.summary;
		const recoveryNotice =
			this.runtime.recoverableDrafts.length > 0
				? "Queued work was recovered as a draft and was not replayed automatically."
				: undefined;
		return {
			...base,
			...(sessionName === undefined ? {} : { name: sessionName }),
			updatedAt: timestamp(lastEntry?.timestamp, this.ref.summary.updatedAt),
			state: this.isActive() ? "running" : lastTurn?.state === "interrupted" ? "interrupted" : "idle",
			unread: this.unread,
			...(recoveryNotice === undefined ? {} : { recoveryNotice }),
		};
	}

	async readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return this.projection.readItems(input);
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
			this.session.sessionManager.setPermissionSettings({ mode: input.permissionMode });
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
	private readonly projection: SessionProjection;

	constructor(ref: SessionRef) {
		this.sessionId = ref.summary.sessionId;
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
				return projectMessageEntry({
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

	async listSkills(): Promise<ClientResult<"skill/list">> {
		return { skills: [] };
	}

	async readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return this.projection.readItems(input);
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

function pathIsInside(root: string, target: string): boolean {
	const relativePath = relative(resolve(root), resolve(target));
	return (
		relativePath === "" ||
		(!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
	);
}

function publicSkillSource(skill: Skill): SkillSourceView | undefined {
	if (pathIsInside(getSkillsDir(), skill.filePath)) return "system";
	return skill.sourceInfo.scope === "user" || skill.sourceInfo.scope === "project"
		? skill.sourceInfo.scope
		: undefined;
}

function publicSkills(skills: readonly Skill[]): ClientResult<"skill/list"> {
	return {
		skills: skills.slice(0, 256).map((skill) => {
			const source = publicSkillSource(skill);
			return { name: skill.name, description: skill.description, ...(source ? { source } : {}) };
		}),
	};
}

export class AgentSessionRuntimeHost implements SessionRuntimeHost {
	private readonly agentDir: string;
	private readonly options: AgentSessionRuntimeHostOptions;
	private readonly trustStore: ProjectTrustStore;

	constructor(options: AgentSessionRuntimeHostOptions) {
		this.options = options;
		this.agentDir = options.agentDir;
		this.trustStore = new ProjectTrustStore(options.agentDir);
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

	async listSkills(cwd: string | null): Promise<ClientResult<"skill/list">> {
		const effectiveCwd = cwd ?? this.agentDir;
		const settingsManager = SettingsManager.create(effectiveCwd, this.agentDir, {
			projectTrusted: cwd !== null && this.trustStore.get(effectiveCwd) === true,
		});
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
			return publicSkills(loader.getSkills().skills);
		} finally {
			loader.dispose();
		}
	}

	async open(ref: SessionRef): Promise<OpenedSessionRuntime> {
		if (ref.summary.archived) throw new AppServerError("NOT_FOUND", { sessionId: ref.summary.sessionId });
		if (ref.scheduled) return new ReadonlyScheduledSessionRuntime(ref);
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
				const opened = new OpenedAgentSessionRuntime(runtime, ref, this.agentDir, this.options.interactions);
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
