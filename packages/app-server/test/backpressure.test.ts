import {
	type DomainEvent,
	type ItemView,
	ProtocolValidationError,
	type ServerRpcNotification,
} from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { type OutboundEnvelope, OutboundQueue } from "../src/outbound-queue.ts";

const EPOCH = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "session-backpressure";
const CREATED_AT = "2026-07-16T00:00:00.000Z";

function delta(text: string, outputTokens?: number): DomainEvent {
	return {
		type: "item/delta",
		sessionId: SESSION_ID,
		itemId: "item-stream",
		delta: { type: "text", text, ...(outputTokens === undefined ? {} : { outputTokens }) },
	};
}

function childDelta(agentId: string, text: string, type: "text" | "thinking" = "text"): DomainEvent {
	return {
		type: "agent/item/delta",
		sessionId: SESSION_ID,
		agentId,
		itemId: "child-item-stream",
		delta: { type, text },
	};
}

function completedItem(itemId = "item-stream"): ItemView {
	return {
		itemId,
		sessionId: SESSION_ID,
		role: "assistant",
		state: "completed",
		content: [{ type: "text", text: "done" }],
		createdAt: CREATED_AT,
		completedAt: CREATED_AT,
	};
}

function notifications(messages: readonly OutboundEnvelope[]): ServerRpcNotification<"connection/events">[] {
	return messages.filter((message): message is ServerRpcNotification<"connection/events"> => "method" in message);
}

describe("OutboundQueue backpressure", () => {
	it("does not misclassify an invalid internal event as connection overload", () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		const invalid = {
			type: "agent/updated",
			agent: { agentId: "agent-invalid" },
		} as unknown as DomainEvent;

		expect(() => queue.enqueue(1, invalid)).toThrow(ProtocolValidationError);
		expect(queue.getStats()).toMatchObject({ unacknowledgedEvents: 0, overloaded: false });
		expect(queue.enqueue(1, { type: "server/state", state: "ready" })).toBe(true);
	});

	it("coalesces only adjacent unsent deltas for the same item", async () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		const sent: OutboundEnvelope[] = [];
		expect(queue.enqueue(1, delta("hello"))).toBe(true);
		expect(queue.enqueue(2, delta(" world"))).toBe(true);
		expect(queue.getStats().unacknowledgedEvents).toBe(1);

		queue.setSender((message) => {
			sent.push(message);
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			method: "connection/events",
			params: {
				fromCursor: 2,
				toCursor: 2,
				events: [{ type: "item/delta", delta: { text: "hello world" } }],
			},
		});

		expect(queue.acknowledge(EPOCH, 2)).toBe(2);
		expect(queue.getStats()).toMatchObject({ unacknowledgedBytes: 0, unacknowledgedEvents: 0 });
	});

	it("keeps the newest usage when coalescing deltas", async () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		const sent: OutboundEnvelope[] = [];
		queue.enqueue(1, delta("hello", 7));
		queue.enqueue(2, delta(" world", 12));
		queue.setSender((message) => {
			sent.push(message);
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			params: {
				events: [{ type: "item/delta", delta: { text: "hello world", outputTokens: 12 } }],
			},
		});
	});

	it("does not coalesce across a terminal item event", async () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		const sent: OutboundEnvelope[] = [];
		queue.enqueue(1, delta("a"));
		queue.enqueue(2, { type: "item/completed", item: completedItem() });
		queue.enqueue(3, delta("b"));
		expect(queue.getStats().unacknowledgedEvents).toBe(3);
		queue.setSender((message) => {
			sent.push(message);
		});

		await vi.waitFor(() => expect(notifications(sent)).toHaveLength(1));
		expect(notifications(sent)[0]?.params.events.map((event) => event.type)).toEqual([
			"item/delta",
			"item/completed",
			"item/delta",
		]);
	});

	it("coalesces child deltas only for the same child and preserves thinking", async () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		const sent: OutboundEnvelope[] = [];
		queue.enqueue(1, childDelta("child-a", "one", "thinking"));
		queue.enqueue(2, childDelta("child-a", " two", "thinking"));
		queue.enqueue(3, childDelta("child-b", "three", "thinking"));
		expect(queue.getStats().unacknowledgedEvents).toBe(2);

		queue.setSender((message) => {
			sent.push(message);
		});
		await vi.waitFor(() => expect(notifications(sent)).toHaveLength(1));
		expect(notifications(sent)[0]).toMatchObject({
			params: {
				fromCursor: 2,
				toCursor: 3,
				events: [
					{
						type: "agent/item/delta",
						agentId: "child-a",
						delta: { type: "thinking", text: "one two" },
					},
					{ type: "agent/item/delta", agentId: "child-b" },
				],
			},
		});
	});

	it("preserves 500 child delta fragments while keeping one unsent record", async () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		for (let cursor = 1; cursor <= 500; cursor += 1) {
			queue.enqueue(cursor, childDelta("child-a", String(cursor % 10)));
		}
		expect(queue.getStats().unacknowledgedEvents).toBe(1);

		const sent: OutboundEnvelope[] = [];
		queue.setSender((message) => {
			sent.push(message);
		});
		await vi.waitFor(() => expect(notifications(sent)).toHaveLength(1));
		const event = notifications(sent)[0]?.params.events[0];
		expect(event).toMatchObject({ type: "agent/item/delta", agentId: "child-a" });
		if (event?.type !== "agent/item/delta") throw new TypeError("Expected child delta");
		expect(event.delta.text).toBe(Array.from({ length: 500 }, (_, index) => String((index + 1) % 10)).join(""));
	});

	it("coalesces adjacent child journal notices without crossing child scope", async () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		for (let cursor = 1; cursor <= 50; cursor += 1) {
			queue.enqueue(cursor, {
				type: "agent/itemsChanged",
				sessionId: SESSION_ID,
				agentId: "child-a",
				taskId: "task-a",
			});
		}
		queue.enqueue(51, {
			type: "agent/itemsChanged",
			sessionId: SESSION_ID,
			agentId: "child-b",
			taskId: "task-b",
		});
		expect(queue.getStats().unacknowledgedEvents).toBe(2);

		const sent: OutboundEnvelope[] = [];
		queue.setSender((message) => {
			sent.push(message);
		});
		await vi.waitFor(() => expect(notifications(sent)).toHaveLength(1));
		expect(notifications(sent)[0]).toMatchObject({
			params: {
				fromCursor: 50,
				toCursor: 51,
				events: [
					{ type: "agent/itemsChanged", agentId: "child-a", taskId: "task-a" },
					{ type: "agent/itemsChanged", agentId: "child-b", taskId: "task-b" },
				],
			},
		});
	});

	it("bounds snapshot staging and retains only the post-snapshot delta suffix", async () => {
		const queue = new OutboundQueue({
			serverEpoch: EPOCH,
			maxUnacknowledgedEvents: 2,
			maxUnacknowledgedBytes: 1024,
		});
		const stage = queue.createStage();
		expect(stage.enqueue(1, delta("a"))).toBe(true);
		expect(stage.enqueue(2, delta("b"))).toBe(true);
		expect(stage.enqueue(3, delta("c"))).toBe(true);
		expect(queue.getStats()).toMatchObject({ unacknowledgedEvents: 1, overloaded: false });

		stage.commit(2);
		const sent: OutboundEnvelope[] = [];
		queue.setSender((message) => {
			sent.push(message);
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			method: "connection/events",
			params: {
				fromCursor: 3,
				toCursor: 3,
				events: [{ type: "item/delta", delta: { text: "c" } }],
			},
		});
	});

	it("keeps a paused sender within its cap and terminates with OVERLOADED", async () => {
		let release!: () => void;
		let started!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deliveryStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const sent: OutboundEnvelope[] = [];
		const terminal = vi.fn();
		const queue = new OutboundQueue({
			serverEpoch: EPOCH,
			maxUnacknowledgedBytes: 1024 * 1024,
			maxUnacknowledgedEvents: 2,
			onTerminal: terminal,
		});
		queue.setSender(async (message) => {
			sent.push(message);
			if ("method" in message) {
				started();
				await blocked;
			}
		});

		expect(queue.enqueue(1, { type: "server/state", state: "ready" })).toBe(true);
		await deliveryStarted;
		expect(queue.enqueue(2, { type: "item/completed", item: completedItem("item-terminal") })).toBe(true);
		expect(queue.enqueue(3, { type: "server/state", state: "restarting" })).toBe(false);
		expect(queue.getStats()).toMatchObject({ unacknowledgedEvents: 2, overloaded: true });
		expect(queue.getStats().unacknowledgedBytes).toBeLessThanOrEqual(1024 * 1024);
		expect(queue.getTerminalError()).toMatchObject({ error: { data: { name: "OVERLOADED" } } });

		release();
		await vi.waitFor(() => expect(terminal).toHaveBeenCalledWith("overloaded"));
		expect(sent.at(-1)).toMatchObject({ error: { data: { name: "OVERLOADED" } } });
	});

	it("splits cursor gaps into valid batches and releases all acknowledged events", async () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		const sent: OutboundEnvelope[] = [];
		queue.enqueue(1, { type: "server/state", state: "starting" });
		queue.enqueue(2, { type: "server/state", state: "ready" });
		queue.enqueue(4, { type: "server/state", state: "restarting" });
		queue.setSender((message) => {
			sent.push(message);
		});

		await vi.waitFor(() => expect(notifications(sent)).toHaveLength(2));
		expect(notifications(sent).map((message) => [message.params.fromCursor, message.params.toCursor])).toEqual([
			[1, 2],
			[4, 4],
		]);
		expect(queue.acknowledge(EPOCH, 4)).toBe(4);
		expect(queue.getStats().unacknowledgedEvents).toBe(0);
	});

	it("rejects acknowledgement beyond the last delivered cursor", () => {
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		expect(() => queue.acknowledge(EPOCH, 1)).toThrowError();
		expect(() => queue.acknowledge("00000000-0000-4000-8000-000000000002", 0)).toThrowError();
	});

	it("accepts an acknowledgement while a slow transport is draining the delivered batch", async () => {
		let release!: () => void;
		let started!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deliveryStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const queue = new OutboundQueue({ serverEpoch: EPOCH });
		queue.setSender(async () => {
			started();
			await blocked;
		});
		queue.enqueue(1, { type: "server/state", state: "ready" });

		await deliveryStarted;
		expect(queue.acknowledge(EPOCH, 1)).toBe(1);
		expect(queue.getStats().unacknowledgedEvents).toBe(0);
		release();
	});
});
