import type {
	ClientParams,
	ClientResult,
	DomainEvent,
	InteractionView,
	ItemView,
	PermissionDecisionView,
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
import type { SessionItemHistory } from "./journal-item-history.ts";

export { MAX_PROJECTED_THINKING_BYTES, MAX_PROJECTED_VISIBLE_TEXT_BYTES };
const MAX_SNAPSHOT_ITEMS = 200;
const MAX_SNAPSHOT_TURNS = 200;
const MAX_PROJECTED_ITEM_PAGE_UTF8_BYTES = 6 * 1024 * 1024;

export interface SessionProjectionSeed {
	readonly session: SessionSummary;
	readonly turns?: readonly TurnView[];
	readonly items?: readonly ItemView[];
	readonly history?: SessionItemHistory;
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
	private readonly history?: SessionItemHistory;
	private pendingInteractions: InteractionView[];
	private tasks: SessionTaskView[];
	private deliveredFiles: SessionDeliveredFileView[];
	private goal: SessionGoalView | null;
	private queuedTurns: QueuedTurnView[];

	constructor(seed: SessionProjectionSeed) {
		this.session = clone(seed.session);
		this.history = seed.history;
		for (const itemId of seed.history?.itemIds ?? []) {
			this.itemIndexById.set(itemId, this.itemOrder.length);
			this.itemOrder.push(itemId);
		}
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
		const previousIndex = this.itemIndexById.get(item.itemId);
		if (previousIndex !== undefined && !this.itemsById.has(item.itemId) && !this.history?.readItem(item.itemId)) {
			// Hidden journal metadata did not occupy a display row in the eager
			// projection. If a live event reveals it, retain the original append order.
			this.itemOrder.splice(previousIndex, 1);
			this.itemIndexById.delete(item.itemId);
			for (let index = previousIndex; index < this.itemOrder.length; index += 1) {
				this.itemIndexById.set(this.itemOrder[index]!, index);
			}
		}
		if (!this.itemIndexById.has(item.itemId)) {
			this.itemIndexById.set(item.itemId, this.itemOrder.length);
			this.itemOrder.push(item.itemId);
		}
		this.itemsById.set(item.itemId, clone(item));
	}

	/** Update existing tool rows through the same item events used by reconnect snapshots. */
	setPermissionDecision(
		actionId: string,
		source: "rule" | "model" | "user" | "full",
		details: Omit<PermissionDecisionView, "source"> = {},
	): readonly ItemView[] {
		const updated: ItemView[] = [];
		const candidates = new Set([...(this.history?.toolCallItemIds(actionId) ?? []), ...this.itemsById.keys()]);
		for (const itemId of candidates) {
			const item = this.getItem(itemId);
			if (!item) continue;
			if (!item.content.some((block) => block.type === "tool_call" && block.toolCallId === actionId)) continue;
			const next = {
				...item,
				content: item.content.map((block) =>
					block.type === "tool_call" && block.toolCallId === actionId
						? { ...block, permissionDecision: { source, ...details } }
						: block,
				),
			};
			this.itemsById.set(itemId, next);
			updated.push(clone(next));
		}
		return updated;
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
				const item = this.getItem(event.itemId);
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

	private getItem(itemId: string): ItemView | undefined {
		return this.itemsById.get(itemId) ?? this.history?.readItem(itemId);
	}

	private itemPage(end: number, limit: number): ClientResult<"session/readItems"> {
		const items: ItemView[] = [];
		let bytes = 2;
		let startIndex = end;
		for (let index = end - 1; index >= 0 && items.length < limit; index -= 1) {
			const itemId = this.itemOrder[index]!;
			const item = this.getItem(itemId);
			if (!item) continue;
			const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
			if (items.length > 0 && bytes + itemBytes > MAX_PROJECTED_ITEM_PAGE_UTF8_BYTES) break;
			items.push(item);
			startIndex = index;
			bytes += itemBytes;
		}
		let hasEarlier = false;
		for (let index = startIndex - 1; items.length > 0 && index >= 0; index -= 1) {
			if (!this.getItem(this.itemOrder[index]!)) continue;
			hasEarlier = true;
			break;
		}
		items.reverse();
		return { items: items.map(clone), nextBeforeItemId: hasEarlier ? items[0]!.itemId : null };
	}

	readItems(input: ClientParams<"session/readItems">): ClientResult<"session/readItems"> {
		this.assertSession(input.sessionId);
		let end = this.itemOrder.length;
		if (input.beforeItemId) {
			const index = this.itemIndexById.get(input.beforeItemId);
			if (index === undefined || !this.getItem(input.beforeItemId))
				throw new AppServerError("NOT_FOUND", { sessionId: this.session.sessionId });
			end = index;
		}
		return this.itemPage(end, input.limit);
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
		const recent = this.itemPage(this.itemOrder.length, MAX_SNAPSHOT_ITEMS);
		const turns = this.turnOrder.slice(-MAX_SNAPSHOT_TURNS).map((turnId) => clone(this.turnsById.get(turnId)!));
		return {
			session: this.getSummary(),
			...(this.process ? { process: clone(this.process) } : {}),
			...(this.retry ? { retry: clone(this.retry) } : {}),
			turns,
			recentItems: recent.items,
			nextBeforeItemId: recent.nextBeforeItemId,
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
