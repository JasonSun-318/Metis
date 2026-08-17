import type {
	ClientParams,
	ClientResult,
	DomainEvent,
	InteractionView,
	ItemView,
	QueuedTurnView,
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

export interface SessionProjectionSeed {
	readonly session: SessionSummary;
	readonly turns?: readonly TurnView[];
	readonly items?: readonly ItemView[];
	readonly pendingInteractions?: readonly InteractionView[];
	readonly tasks?: readonly SessionTaskView[];
	readonly goal?: SessionGoalView | null;
	readonly queuedTurns?: readonly QueuedTurnView[];
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/** Incremental, normalized state for one open session. */
export class SessionProjection {
	private session: SessionSummary;
	private readonly turnsById = new Map<string, TurnView>();
	private readonly turnOrder: string[] = [];
	private readonly itemsById = new Map<string, ItemView>();
	private readonly itemOrder: string[] = [];
	private readonly itemIndexById = new Map<string, number>();
	private pendingInteractions: InteractionView[];
	private tasks: SessionTaskView[];
	private goal: SessionGoalView | null;
	private queuedTurns: QueuedTurnView[];

	constructor(seed: SessionProjectionSeed) {
		this.session = clone(seed.session);
		for (const turn of seed.turns ?? []) this.upsertTurn(turn);
		for (const item of seed.items ?? []) this.upsertItem(item);
		this.pendingInteractions = clone([...(seed.pendingInteractions ?? [])]);
		this.tasks = clone([...(seed.tasks ?? [])]);
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
			case "server/state":
			case "interaction/notify":
				return clone(event);
			case "session/permissionModeChanged":
			case "session/thinkingSelectionChanged":
			case "session/modelChanged":
			case "subagent/updated":
			case "subagent/item/started":
			case "subagent/item/delta":
			case "subagent/item/completed":
			case "subagent/itemsChanged":
				this.assertSession(event.sessionId);
				return clone(event);
			case "session/tasksChanged":
				this.assertSession(event.sessionId);
				this.tasks = clone(event.tasks);
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

	readItems(input: ClientParams<"session/readItems">): ClientResult<"session/readItems"> {
		this.assertSession(input.sessionId);
		let end = this.itemOrder.length;
		if (input.beforeItemId) {
			const index = this.itemIndexById.get(input.beforeItemId);
			if (index === undefined) throw new AppServerError("NOT_FOUND", { sessionId: this.session.sessionId });
			end = index;
		}
		const start = Math.max(0, end - input.limit);
		return {
			items: this.itemOrder.slice(start, end).map((itemId) => clone(this.itemsById.get(itemId)!)),
			nextBeforeItemId: start > 0 ? this.itemOrder[start]! : null,
		};
	}

	snapshot(
		serverEpoch: string,
		cursor: number,
		runtime: Pick<
			SessionSnapshot,
			| "thinkingSelection"
			| "permissionMode"
			| "actualThinkingLevel"
			| "availableThinkingSelections"
			| "subagents"
			| "model"
			| "availableModels"
		> = {
			permissionMode: "auto",
			thinkingSelection: "off",
			actualThinkingLevel: "off",
			availableThinkingSelections: ["off"],
			subagents: [],
		},
	): SessionSnapshot {
		const recentItemIds = this.itemOrder.slice(-MAX_SNAPSHOT_ITEMS);
		const turns = this.turnOrder.slice(-MAX_SNAPSHOT_TURNS).map((turnId) => clone(this.turnsById.get(turnId)!));
		return {
			session: this.getSummary(),
			turns,
			recentItems: recentItemIds.map((itemId) => clone(this.itemsById.get(itemId)!)),
			nextBeforeItemId:
				this.itemOrder.length > recentItemIds.length && recentItemIds.length > 0 ? recentItemIds[0]! : null,
			activeTurnId: [...turns].reverse().find((turn) => turn.state === "running")?.turnId ?? null,
			pendingInteractions: clone(this.pendingInteractions),
			queuedTurns: clone(this.queuedTurns),
			tasks: clone(this.tasks),
			goal: clone(this.goal),
			...clone(runtime),
			serverEpoch,
			cursor,
		};
	}
}
