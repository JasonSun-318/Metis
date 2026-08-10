import { createHash } from "node:crypto";
import type { DomainEvent, ItemView } from "@metis/app-protocol";
import type { SubagentVisibleActivity } from "@metis/coding-agent";
import { appendProjectedDelta, opaqueId, projectLiveMessage } from "./item-projection.ts";

interface ChildLiveState {
	readonly items: Map<string, ItemView>;
	readonly itemIds: WeakMap<object, string>;
	sequence: number;
	assistantItemId?: string;
}

/** Projects one child at a time without retaining durable transcript history. */
export class SubagentLiveProjector {
	private readonly children = new Map<string, ChildLiveState>();
	private readonly parentSessionId: string;
	private readonly publish: (event: DomainEvent) => void;
	private readonly fallbackTimestamp: string;

	constructor(parentSessionId: string, publish: (event: DomainEvent) => void, fallbackTimestamp: string) {
		this.parentSessionId = parentSessionId;
		this.publish = publish;
		this.fallbackTimestamp = fallbackTimestamp;
	}

	private state(agentId: string): ChildLiveState {
		const existing = this.children.get(agentId);
		if (existing) return existing;
		const created: ChildLiveState = { items: new Map(), itemIds: new WeakMap(), sequence: 0 };
		this.children.set(agentId, created);
		return created;
	}

	private itemId(agentId: string, turnId: string | undefined, message: object): string {
		const state = this.state(agentId);
		const role = (message as Record<string, unknown>).role;
		if (role === "assistant" && state.assistantItemId) return state.assistantItemId;
		const existing = state.itemIds.get(message);
		if (existing) return existing;
		state.sequence += 1;
		const timestamp = (message as Record<string, unknown>).timestamp;
		const itemId = opaqueId(
			`subagent-live:${createHash("sha256")
				.update(`${agentId}:${turnId ?? "none"}:${String(role)}:${String(timestamp)}:${state.sequence}`)
				.digest("hex")}`,
			"item",
		);
		state.itemIds.set(message, itemId);
		if (role === "assistant") state.assistantItemId = itemId;
		return itemId;
	}

	apply(agentId: string, turnId: string | undefined, event: SubagentVisibleActivity): void {
		const role = event.message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") return;
		const itemId = this.itemId(agentId, turnId, event.message);
		const state = this.state(agentId);

		if (event.type === "message_start") {
			const item = projectLiveMessage({
				itemId,
				sessionId: agentId,
				...(turnId ? { turnId: opaqueId(turnId, "turn") } : {}),
				message: event.message,
				state: "streaming",
				fallbackTimestamp: this.fallbackTimestamp,
			});
			if (!item) return;
			state.items.set(itemId, item);
			this.publish({ type: "subagent/item/started", sessionId: this.parentSessionId, agentId, item });
			return;
		}

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
			const item = state.items.get(itemId);
			if (!item) return;
			const projected = appendProjectedDelta(item, {
				type: update.type === "text_delta" ? "text" : "thinking",
				text: update.delta,
			});
			if (!projected) return;
			state.items.set(itemId, projected.item);
			this.publish({
				type: "subagent/item/delta",
				sessionId: this.parentSessionId,
				agentId,
				itemId,
				delta: projected.delta,
			});
			return;
		}

		const record = event.message as unknown as Record<string, unknown>;
		const interrupted = role === "assistant" && (record.stopReason === "aborted" || record.stopReason === "error");
		const item = projectLiveMessage({
			itemId,
			sessionId: agentId,
			...(turnId ? { turnId: opaqueId(turnId, "turn") } : {}),
			message: event.message,
			state: interrupted ? "interrupted" : "completed",
			fallbackTimestamp: this.fallbackTimestamp,
		});
		if (item) {
			this.publish({ type: "subagent/item/completed", sessionId: this.parentSessionId, agentId, item });
		}
		state.items.delete(itemId);
		if (role === "assistant") state.assistantItemId = undefined;
	}

	currentItems(agentId: string): readonly ItemView[] {
		return [...(this.children.get(agentId)?.items.values() ?? [])].map((item) => structuredClone(item));
	}

	clear(agentId?: string): void {
		if (agentId) this.children.delete(agentId);
		else this.children.clear();
	}
}
