import { createHash } from "node:crypto";
import type {
	ClientParams,
	ClientResult,
	DomainEvent,
	DurableImageRefView,
	ItemContentBlockView,
	ItemView,
	SessionSnapshot,
	SessionSummary,
	TurnView,
} from "@arcmind/app-protocol";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	buildChildSystemPrompt,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	reduceRuntimeJournal,
	SessionManager,
	SettingsManager,
	type SubagentSummary,
} from "@arcmind/coding-agent";
import type { CredentialCoordinator } from "./credential-coordinator.ts";
import {
	type DurableSessionMutation,
	type PreparedSessionMutation,
	prepareSessionMutation,
} from "./durable-mutation.ts";
import type { InteractionBroker } from "./interactions.ts";
import { SessionProjection } from "./projection/session-projection.ts";
import {
	AppServerError,
	type OpenedSessionRuntime,
	type SessionEventListener,
	type SessionRef,
	type SessionRuntimeHost,
} from "./session-runtime-host.ts";

const MAX_TURNS = 200;
const MAX_ITEM_BLOCKS = 16;
const MAX_ITEM_TEXT_BYTES = 16 * 1024;

export interface AgentSessionRuntimeHostOptions {
	readonly agentDir: string;
	readonly interactions?: InteractionBroker;
	readonly credentials?: CredentialCoordinator;
}

function boundedText(value: string, maximumBytes: number): string {
	if (maximumBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maximumBytes) return value;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const suffix = maximumBytes >= 3 ? "…" : "";
	let end = maximumBytes - Buffer.byteLength(suffix, "utf8");
	while (end > 0) {
		try {
			return `${decoder.decode(bytes.subarray(0, end))}${suffix}`;
		} catch {
			end -= 1;
		}
	}
	return suffix;
}

function opaqueId(value: unknown, namespace: string): string {
	if (typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
		return value;
	}
	return `${namespace}:${createHash("sha256").update(String(value)).digest("hex")}`;
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

function subagentView(summary: SubagentSummary): SessionSnapshot["subagents"][number] {
	const { configuration, ...rest } = summary;
	return {
		...rest,
		...(configuration ? { configuration: { ...configuration, tools: [...configuration.tools] } } : {}),
	};
}

function timestamp(value: unknown, fallback: string): string {
	return typeof value === "string" &&
		value.length <= 40 &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
		Number.isFinite(Date.parse(value))
		? value
		: fallback;
}

function durableImage(value: Record<string, unknown>): DurableImageRefView | undefined {
	const mediaType = value.mimeType;
	if (
		value.type !== "image_ref" ||
		typeof value.hash !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.hash) ||
		(mediaType !== "image/jpeg" &&
			mediaType !== "image/png" &&
			mediaType !== "image/gif" &&
			mediaType !== "image/webp") ||
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size < 1 ||
		value.size > 32 * 1024 * 1024
	) {
		return undefined;
	}
	return { hash: value.hash, mediaType, byteLength: value.size };
}

interface TextBudget {
	remaining: number;
}

function takeText(value: string, budget: TextBudget): string | undefined {
	if (budget.remaining <= 0) return undefined;
	const text = boundedText(value, budget.remaining);
	budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(text, "utf8"));
	return text;
}

function textBlocks(content: unknown, budget: TextBudget): ItemContentBlockView[] {
	if (typeof content === "string") {
		const text = takeText(content, budget);
		return text === undefined ? [] : [{ type: "text", text }];
	}
	if (!Array.isArray(content)) return [];
	const blocks: ItemContentBlockView[] = [];
	for (const candidate of content.slice(0, 256)) {
		if (blocks.length >= MAX_ITEM_BLOCKS) break;
		if (typeof candidate !== "object" || candidate === null) continue;
		const block = candidate as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			const text = takeText(block.text, budget);
			if (text !== undefined) blocks.push({ type: "text", text });
			continue;
		}
		const image = durableImage(block);
		if (image) blocks.push({ type: "image", image });
	}
	return blocks;
}

function mapMessageEntry(
	entry: Record<string, unknown>,
	sessionId: string,
	turnStates: ReadonlyMap<string, "active" | "completed" | "interrupted">,
	toolStates: ReadonlyMap<string, "active" | "completed" | "interrupted">,
	fallbackTimestamp: string,
): ItemView | undefined {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return undefined;
	const message = entry.message as Record<string, unknown>;
	const itemId = opaqueId(entry.id, "item");
	const turnId = entry.turnId === undefined ? undefined : opaqueId(entry.turnId, "turn");
	const turnState = turnId === undefined ? undefined : turnStates.get(turnId);
	const createdAt = timestamp(entry.timestamp, fallbackTimestamp);
	const state = turnState === "active" ? "streaming" : turnState === "interrupted" ? "interrupted" : "completed";

	if (message.role === "user") {
		const budget = { remaining: MAX_ITEM_TEXT_BYTES };
		return {
			itemId,
			sessionId,
			...(turnId === undefined ? {} : { turnId }),
			role: "user",
			state,
			content: textBlocks(message.content, budget),
			createdAt,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
	}

	if (message.role === "assistant") {
		const budget = { remaining: MAX_ITEM_TEXT_BYTES };
		const content = textBlocks(message.content, budget);
		if (Array.isArray(message.content)) {
			for (const candidate of message.content.slice(0, 256)) {
				if (content.length >= MAX_ITEM_BLOCKS) break;
				if (typeof candidate !== "object" || candidate === null) continue;
				const block = candidate as Record<string, unknown>;
				if (block.type !== "toolCall") continue;
				const toolCallId = opaqueId(block.id, "tool");
				const toolState = toolStates.get(toolCallId) ?? "completed";
				let inputPreview: string | undefined;
				try {
					if (block.arguments !== undefined) {
						const serialized = JSON.stringify(block.arguments);
						if (serialized !== undefined) inputPreview = takeText(serialized, budget);
					}
				} catch {
					// Omit non-JSON tool details rather than leaking or stringifying them.
				}
				content.push({
					type: "tool_call",
					toolCallId,
					name: name(block.name, "tool"),
					state: toolState === "active" ? "running" : toolState,
					...(inputPreview === undefined ? {} : { inputPreview }),
				});
			}
		}
		return {
			itemId,
			sessionId,
			...(turnId === undefined ? {} : { turnId }),
			role: "assistant",
			state,
			content,
			createdAt,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
	}

	if (message.role === "toolResult") {
		const budget = { remaining: MAX_ITEM_TEXT_BYTES };
		const output = textBlocks(message.content, budget)
			.filter((block): block is Extract<ItemContentBlockView, { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return {
			itemId,
			sessionId,
			...(turnId === undefined ? {} : { turnId }),
			role: "tool",
			state,
			content: [
				{
					type: "tool_result",
					toolCallId: opaqueId(message.toolCallId, "tool"),
					name: name(message.toolName, "tool"),
					isError: message.isError === true,
					output: boundedText(output, MAX_ITEM_TEXT_BYTES),
				},
			],
			createdAt,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
	}
}

class OpenedAgentSessionRuntime implements OpenedSessionRuntime {
	private readonly listeners = new Set<SessionEventListener>();
	private readonly runtime: AgentSessionRuntime;
	private session: AgentSession;
	private readonly ref: SessionRef;
	private readonly projection: SessionProjection;
	private readonly liveItemIds = new WeakMap<object, string>();
	private liveAssistantItemId?: string;
	private readonly projectedTurnStates = new Map<string, TurnView["state"]>();
	private liveItemSequence = 0;
	private unsubscribeAgent?: () => void;
	private unsubscribeSubagents?: () => void;
	private closed = false;
	private closePromise?: Promise<void>;
	private readonly interactions?: InteractionBroker;

	constructor(runtime: AgentSessionRuntime, ref: SessionRef, interactions?: InteractionBroker) {
		this.runtime = runtime;
		this.session = runtime.session;
		this.ref = ref;
		this.interactions = interactions;
		const journal = this.journal();
		const reduced = reduceRuntimeJournal(journal);
		const items = this.itemsFromJournal(journal, reduced);
		const turns = this.turnsFromJournal(journal, reduced);
		for (const turn of turns) this.projectedTurnStates.set(turn.turnId, turn.state);
		this.projection = new SessionProjection({
			session: this.summaryFromRuntime(journal, reduced),
			turns,
			items,
		});
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
		this.session = session;
		this.unsubscribeAgent = session.subscribe((event) => this.onAgentEvent(event));
		this.unsubscribeSubagents = this.runtime.subagentManager?.subscribe((event) => {
			this.publish({ type: "subagent/updated", sessionId: this.sessionId, subagent: subagentView(event.summary) });
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
			if (event.assistantMessageEvent.type === "text_delta") {
				const itemId = this.itemIdFor(event.message);
				this.publish({
					type: "item/delta",
					sessionId: this.sessionId,
					itemId,
					delta: { type: "text", text: event.assistantMessageEvent.delta },
				});
			}
			return;
		}
		if (event.type === "message_end") {
			this.publishCompletedItem(event.message);
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
		const record = message as Record<string, unknown>;
		const createdAt =
			typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
				? new Date(record.timestamp).toISOString()
				: this.ref.summary.updatedAt;
		const turnId = this.currentTurnId();
		const item = mapMessageEntry(
			{
				type: "message",
				id: this.itemIdFor(message),
				...(turnId === undefined ? {} : { turnId }),
				timestamp: createdAt,
				message,
			},
			this.sessionId,
			turnId === undefined
				? new Map()
				: new Map([
						[turnId, state === "streaming" ? "active" : state === "interrupted" ? "interrupted" : "completed"],
					]),
			new Map(),
			createdAt,
		);
		if (!item) return undefined;
		return {
			...item,
			state,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
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
		return mapMessageEntry(
			entry,
			this.sessionId,
			new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state])),
			new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state])),
			this.ref.summary.createdAt,
		);
	}

	private itemsFromJournal(
		journal: readonly unknown[] = this.journal(),
		reduced: ReturnType<typeof reduceRuntimeJournal> = reduceRuntimeJournal(journal),
	): ItemView[] {
		const turnStates = new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state]));
		const toolStates = new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state]));
		return journal
			.map((entry) =>
				mapMessageEntry(
					entry as unknown as Record<string, unknown>,
					this.sessionId,
					turnStates,
					toolStates,
					this.ref.summary.createdAt,
				),
			)
			.filter((item): item is ItemView => item !== undefined);
	}

	private turnsFromJournal(
		journal: readonly unknown[] = this.journal(),
		reduced: ReturnType<typeof reduceRuntimeJournal> = reduceRuntimeJournal(journal),
	): TurnView[] {
		const times = new Map<string, { startedAt: string; completedAt?: string }>();
		for (const entry of journal) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			if (record.type !== "runtime_turn" || typeof record.turnId !== "string") continue;
			const at = timestamp(record.timestamp, this.ref.summary.createdAt);
			const current = times.get(record.turnId) ?? { startedAt: at };
			if (record.state === "completed" || record.state === "interrupted") current.completedAt = at;
			times.set(record.turnId, current);
		}
		return reduced.turns.slice(-MAX_TURNS).map((turn) => {
			const at = times.get(turn.turnId) ?? { startedAt: this.ref.summary.createdAt };
			return {
				turnId: opaqueId(turn.turnId, "turn"),
				sessionId: this.sessionId,
				operationIds: [...new Set(turn.operationIds.map((id) => opaqueId(id, "operation")))].slice(-256),
				state: turn.state === "active" ? "running" : turn.state,
				startedAt: at.startedAt,
				...(at.completedAt === undefined ? {} : { completedAt: at.completedAt }),
			};
		});
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
		return this.session.isStreaming || this.session.activeDurableTurnId !== undefined;
	}

	hasPendingInteractions(): boolean {
		return this.interactions?.hasPending(this.sessionId) ?? false;
	}

	getSummary(): SessionSummary {
		return this.projection.getSummary();
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
			cwd: manager.getCwd() || null,
			updatedAt: timestamp(lastEntry?.timestamp, this.ref.summary.updatedAt),
			state: this.isActive() ? "running" : lastTurn?.state === "interrupted" ? "interrupted" : "idle",
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
				mapMessageEntry(
					entry as unknown as Record<string, unknown>,
					input.agentId,
					turns,
					tools,
					this.ref.summary.createdAt,
				),
			)
			.filter((item): item is ItemView => item !== undefined);
		const end = input.beforeItemId ? items.findIndex((item) => item.itemId === input.beforeItemId) : items.length;
		if (input.beforeItemId && end < 0) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
		const start = Math.max(0, end - input.limit);
		return { items: items.slice(start, end), nextBeforeItemId: start > 0 ? items[start]!.itemId : null };
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

	async snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot> {
		this.refreshLifecycleProjection();
		return this.projection.snapshot(serverEpoch, currentCursor(), {
			thinkingSelection: this.session.getThinkingSelection(),
			actualThinkingLevel: this.session.thinkingLevel,
			availableThinkingSelections: this.session.getAvailableThinkingSelections(),
			subagents: [...(this.runtime.subagentManager?.listSummaries() ?? [])].map(subagentView),
		});
	}

	async startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">> {
		return await this.runtime.submitPrompt({
			requestId: input.requestId,
			text: input.text,
			...(input.images === undefined ? {} : { images: input.images.map(toRuntimeImage) }),
		});
	}

	async steer(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">> {
		return await this.runtime.submitPrompt({
			requestId: input.requestId,
			text: input.text,
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

function toRuntimeImage(image: DurableImageRefView) {
	return { type: "image_ref" as const, hash: image.hash, mimeType: image.mediaType, size: image.byteLength };
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
		const projectTrusted = await this.resolveProjectTrust(options.cwd, options.sessionManager.getSessionId());
		const settingsManager = SettingsManager.create(options.cwd, this.agentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: this.agentDir,
			settingsManager,
			...(this.options.credentials ? { authStorage: this.options.credentials.createView() } : {}),
		});
		try {
			const child = options.childConfig;
			const childModel = child ? services.modelRegistry.find(child.model.provider, child.model.modelId) : undefined;
			if (child && !childModel)
				throw new Error(`Child model is unavailable: ${child.model.provider}/${child.model.modelId}`);
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
						}
					: {}),
			});
			return { ...result, services, diagnostics: services.diagnostics };
		} catch (error) {
			services.resourceLoader.dispose?.();
			throw error;
		}
	};

	async open(ref: SessionRef): Promise<OpenedSessionRuntime> {
		if (ref.summary.archived) throw new AppServerError("NOT_FOUND", { sessionId: ref.summary.sessionId });
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
				const opened = new OpenedAgentSessionRuntime(runtime, ref, this.options.interactions);
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
