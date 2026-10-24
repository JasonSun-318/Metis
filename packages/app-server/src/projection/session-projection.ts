import type {
	ClientParams,
	ClientResult,
	DomainEvent,
	InteractionView,
	ItemView,
	QueuedTurnView,
	SessionDeliveredFileView,
	SessionGoalView,
	SessionSnapshot,
	SessionSummary,
	SessionTaskView,
	TurnView,
} from "@metis/app-protocol";
import {
	appendProjectedDelta,
	MAX_PROJECTED_THINKING_BYTES,
	MAX_PROJECTED_VISIBLE_TEXT_BYTES,
} from "../item-projection.ts";
import { AppServerError } from "../session-runtime-host.ts";

export { MAX_PROJECTED_THINKING_BYTES, MAX_PROJECTED_VISIBLE_TEXT_BYTES };
const MAX_SNAPSHOT_ITEMS = 200;
const MAX_SNAPSHOT_TURNS = 200;
const MAX_PROJECTED_ITEM_PAGE_UTF8_BYTES = 6 * 1024 * 1024;

export interface SessionProjectionSeed {
	readonly session: SessionSummary;
	readonly turns?: readonly TurnView[];
	readonly items?: readonly ItemView[];
	readonly pendingInteractions?: readonly InteractionView[];
	readonly tasks?: readonly SessionTaskView[];
	readonly deliveredFiles?: readonly SessionDeliveredFileView[];
	readonly goal?: SessionGoalView | null;
	readonly queuedTurns?: readonly QueuedTurnView[];
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/** Incremental, normalized state for one open session. */
export class SessionProjection {
	private session: SessionSummary;
	private process: SessionSnapshot["process"];
	private retry: SessionSnapshot["retry"];
	private readonly turnsById = new Map<string, TurnView>();
	private readonly turnOrder: string[] = [];
	private readonly itemsById = new Map<string, ItemView>();
	private readonly itemOrder: string[] = [];
	private readonly itemIndexById = new Map<string, number>();
	private pendingInteractions: InteractionView[];
	private tasks: SessionTaskView[];
	private deliveredFiles: SessionDeliveredFileView[];
	private goal: SessionGoalView | null;
	private queuedTurns: QueuedTurnView[];

	constructor(seed: SessionProjectionSeed) {
		this.session = clone(seed.session);
		for (const turn of seed.turns ?? []) this.upsertTurn(turn);
		for (const item of seed.items ?? []) this.upsertItem(item);
		this.pendingInteractions = clone([...(seed.pendingInteractions ?? [])]);
		this.tasks = clone([...(seed.tasks ?? [])]);
		this.deliveredFiles = clone([...(seed.deliveredFiles ?? [])]);
		this.goal = seed.goal === undefined ? null : clone(seed.goal);
		this.queuedTurns = clone([...(seed.queuedTurns ?? [])]);
	}

	private assertSession(sessionId: string): void {
		if (sessionId !== this.session.sessionId) {
			throw new TypeError(`Projection for ${this.session.sessionId} cannot apply data for ${sessionId}`);
		}
	}

	private upsertTurn(turn: TurnView): void {
		this.assertSession(turn.sessionId);
		if (!this.turnsById.has(turn.turnId)) this.turnOrder.push(turn.turnId);
		this.turnsById.set(turn.turnId, clone(turn));
	}

	private upsertItem(item: ItemView): void {
		this.assertSession(item.sessionId);
		if (!this.itemsById.has(item.itemId)) {
			this.itemIndexById.set(item.itemId, this.itemOrder.length);
			this.itemOrder.push(item.itemId);
		}
		this.itemsById.set(item.itemId, clone(item));
	}

	/** Applies one event and returns the exact event clients should observe. */
	apply(event: DomainEvent): DomainEvent | undefined {
		switch (event.type) {
			case "session/retryChanged":
				this.assertSession(event.sessionId);
				this.retry = event.retry === null ? undefined : clone(event.retry);
				return clone(event);
			case "session/processChanged":
				this.assertSession(event.sessionId);
				this.process = clone(event.process);
				return clone(event);
			case "server/state":
			case "interaction/notify":
				return clone(event);
			case "session/permissionPresetChanged":
			case "session/permissionReviewStarted":
			case "session/permissionReviewCompleted":
			case "session/collaborationModeChanged":
			case "session/thinkingSelectionChanged":
			case "session/modelChanged":
			case "agent/updated":
			case "agent/deleted":
			case "agent/item/started":
			case "agent/item/delta":
			case "agent/item/completed":
			case "agent/itemsChanged":
				this.assertSession(event.sessionId);
				return clone(event);
			case "session/tasksChanged":
				this.assertSession(event.sessionId);
				this.tasks = clone(event.tasks);
				return clone(event);
			case "session/deliveredFilesChanged":
				this.assertSession(event.sessionId);
				this.deliveredFiles = clone(event.deliveredFiles);
				return clone(event);
			case "session/goalChanged":
				this.assertSession(event.sessionId);
				this.goal = clone(event.goal);
				return clone(event);
			case "turn/queueChanged":
				this.assertSession(event.sessionId);
				this.queuedTurns = clone(event.queuedTurns);
				return clone(event);
			case "session/updated":
				this.assertSession(event.session.sessionId);
				this.session = clone(event.session);
				return clone(event);
			case "turn/started":
			case "turn/completed":
			case "turn/interrupted":
				this.upsertTurn(event.turn);
				return clone(event);
			case "item/started":
			case "item/completed":
				this.upsertItem(event.item);
				return clone(event);
			case "item/delta": {
				this.assertSession(event.sessionId);
				const item = this.itemsById.get(event.itemId);
				if (!item || item.state !== "streaming") return undefined;
				const projected = appendProjectedDelta(item, event.delta);
				if (!projected) return undefined;
				this.itemsById.set(event.itemId, projected.item);
				return { ...event, delta: projected.delta };
			}
		}
	}

	getSummary(): SessionSummary {
		return clone(this.session);
	}

	private itemPage(end: number, limit: number): readonly string[] {
		const itemIds: string[] = [];
		let bytes = 2;
		for (let index = end - 1; index >= 0 && itemIds.length < limit; index -= 1) {
			const itemId = this.itemOrder[index]!;
			const itemBytes = Buffer.byteLength(JSON.stringify(this.itemsById.get(itemId)!), "utf8") + 1;
			if (itemIds.length > 0 && bytes + itemBytes > MAX_PROJECTED_ITEM_PAGE_UTF8_BYTES) break;
			itemIds.unshift(itemId);
			bytes += itemBytes;
		}
		if (itemIds.length === 0 && end > 0) {
			itemIds.push(this.itemOrder[end - 1]!);
		}
		return itemIds;
	}

	readItems(input: ClientParams<"session/readItems">): ClientResult<"session/readItems"> {
		this.assertSession(input.sessionId);
		let end = this.itemOrder.length;
		if (input.beforeItemId) {
			const index = this.itemIndexById.get(input.beforeItemId);
			if (index === undefined) throw new AppServerError("NOT_FOUND", { sessionId: this.session.sessionId });
			end = index;
		}
		const itemIds = this.itemPage(end, input.limit);
		const startIndex = itemIds.length > 0 ? this.itemIndexById.get(itemIds[0]!)! : 0;
		return {
			items: itemIds.map((itemId) => clone(this.itemsById.get(itemId)!)),
			nextBeforeItemId: startIndex > 0 ? itemIds[0]! : null,
		};
	}

	snapshot(
		serverEpoch: string,
		cursor: number,
		runtime: Pick<
			SessionSnapshot,
			| "collaborationMode"
			| "thinkingSelection"
			| "permissionPreset"
			| "effectiveSettings"
			| "constrainedByParent"
			| "sandboxHealth"
			| "activeReview"
			| "actualThinkingLevel"
			| "availableThinkingSelections"
			| "agents"
			| "nextAgentAfterId"
			| "model"
			| "availableModels"
		> = {
			collaborationMode: "default",
			permissionPreset: "auto",
			effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
			constrainedByParent: false,
			sandboxHealth: "healthy",
			thinkingSelection: "off",
			actualThinkingLevel: "off",
			availableThinkingSelections: ["off"],
			agents: [],
			nextAgentAfterId: null,
		},
	): SessionSnapshot {
		const recentItemIds = this.itemPage(this.itemOrder.length, MAX_SNAPSHOT_ITEMS);
		const turns = this.turnOrder.slice(-MAX_SNAPSHOT_TURNS).map((turnId) => clone(this.turnsById.get(turnId)!));
		const startIndex = recentItemIds.length > 0 ? this.itemIndexById.get(recentItemIds[0]!)! : 0;
		return {
			session: this.getSummary(),
			...(this.process ? { process: clone(this.process) } : {}),
			...(this.retry ? { retry: clone(this.retry) } : {}),
			turns,
			recentItems: recentItemIds.map((itemId) => clone(this.itemsById.get(itemId)!)),
			nextBeforeItemId: startIndex > 0 ? recentItemIds[0]! : null,
			activeTurnId: [...turns].reverse().find((turn) => turn.state === "running")?.turnId ?? null,
			pendingInteractions: clone(this.pendingInteractions),
			queuedTurns: clone(this.queuedTurns),
			tasks: clone(this.tasks),
			deliveredFiles: clone(this.deliveredFiles),
			goal: clone(this.goal),
			...clone(runtime),
			serverEpoch,
			cursor,
		};
	}
}
