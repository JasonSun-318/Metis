import type { FileEntry } from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import { projectAgentItems } from "../src/agent-catalog.ts";
import { latestAgentInputs, projectAgentMailboxItem } from "../src/agent-conversation-projection.ts";

const time = "2026-10-23T12:00:00.000Z";
const root = "00000000-0000-4000-8000-000000000001";
const child = "00000000-0000-4000-8000-000000000002";
type Input = Extract<FileEntry, { type: "agent_input" }>;
function input(messageId: string, state: Input["state"], origin: Input["origin"]): Input {
	return {
		type: "agent_input",
		id: `${messageId}-${state}`,
		parentId: null,
		timestamp: time,
		agentId: child,
		taskId: "task-1",
		messageId,
		requestId: messageId,
		delivery: "steer",
		state,
		instructionRevision: messageId === "m1" ? 1 : 2,
		input: { text: "Same text" },
		origin,
		requestHash: "a".repeat(64),
	};
}
function read(journal: FileEntry[]) {
	return projectAgentItems(journal, { sessionId: root, agentId: child, limit: 100 }, time).items;
}

describe("agent conversation provenance", () => {
	it.each([false, true])("retains task input provenance outside the running window (persisted=%s)", (persisted) => {
		const admitted = { ...input("m1", "queued", { kind: "agent", sessionId: root }), delivery: "start" as const };
		const task: Extract<FileEntry, { type: "agent_task" }> = {
			type: "agent_task",
			id: "task-running",
			parentId: null,
			timestamp: time,
			agentId: child,
			taskId: "task-1",
			status: "running",
			text: "Same text",
			taskSummary: "Same text",
		};
		const journal: FileEntry[] = [admitted, task];
		if (persisted)
			journal.push({
				type: "message",
				id: "persisted",
				parentId: null,
				timestamp: time,
				agentMessageId: "m1",
				message: { role: "user", content: "Same text", timestamp: 1 },
			});
		journal.push(
			{ ...input("m2", "queued", { kind: "user" }), taskId: "task-2" },
			{ ...task, id: "task-done", status: "done" },
			{ ...admitted, id: "m1-delivered", state: "delivered" },
		);
		const { items } = projectAgentItems(
			journal,
			{ sessionId: root, agentId: child, taskId: "task-1", limit: 100 },
			time,
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			agentMessageId: "m1",
			agentTaskId: "task-1",
			origin: { kind: "agent", sessionId: root },
			deliveryState: "delivered",
			instructionRevision: 1,
		});
	});

	it("uses stable IDs for identical messages and shows accepted inputs before model consumption", () => {
		const first = input("m1", "accepted", { kind: "agent", sessionId: root });
		const second = input("m2", "queued", { kind: "user" });
		const pending = read([first, second]);
		expect(pending.map((item) => [item.agentMessageId, item.origin?.kind, item.deliveryState])).toEqual([
			["m1", "agent", "accepted"],
			["m2", "user", "queued"],
		]);
		const journal: FileEntry[] = [
			first,
			second,
			{
				type: "message",
				id: "persisted-m1",
				parentId: null,
				timestamp: time,
				agentMessageId: "m1",
				message: { role: "user", content: "Same text", timestamp: 1 },
			},
			{
				type: "message",
				id: "persisted-m2",
				parentId: "persisted-m1",
				timestamp: time,
				agentMessageId: "m2",
				message: { role: "user", content: "Same text", timestamp: 2 },
			},
			{ ...first, id: "m1-delivered", state: "delivered" },
			{ ...second, id: "m2-delivered", state: "delivered" },
		];
		const delivered = read(journal);
		expect(delivered).toHaveLength(2);
		expect(
			delivered.map((item) => [item.itemId, item.origin?.kind, item.deliveryState, item.instructionRevision]),
		).toEqual([
			["persisted-m1", "agent", "delivered", 1],
			["persisted-m2", "user", "delivered", 2],
		]);
	});

	it("updates the existing parent notification receipt without duplicating its event identity", () => {
		const entry: Extract<FileEntry, { type: "agent_mailbox_event" }> = {
			type: "agent_mailbox_event",
			id: "journal-event",
			parentId: null,
			timestamp: time,
			event: {
				type: "intervention",
				eventId: "intervention-1",
				taskId: "task-1",
				agentId: child,
				parentSessionId: root,
				name: "Layout",
				completedAt: time,
				messageId: "m2",
				instructionRevision: 2,
				delivery: "steer",
				state: "queued",
				text: "Change the dimensions",
			},
		};
		const before = projectAgentMailboxItem(entry, root, time);
		const after = projectAgentMailboxItem(
			entry,
			root,
			time,
			latestAgentInputs([input("m2", "delivered", { kind: "user" })]),
		);
		expect(before.deliveryState).toBe("queued");
		expect(after.deliveryState).toBe("delivered");
		expect(after.itemId).toBe(before.itemId);
		expect(after.agentTargetId).toBe(child);
		expect(after.origin).toEqual({ kind: "system", eventId: "intervention-1" });
	});

	it("does not infer provenance for legacy messages from matching text", () => {
		const items = read([
			{
				type: "message",
				id: "legacy",
				parentId: null,
				timestamp: time,
				message: { role: "user", content: "Same text", timestamp: 1 },
			},
			input("m1", "queued", { kind: "user" }),
		]);
		expect(items).toHaveLength(2);
		expect(items[0]?.origin).toBeUndefined();
		expect(items[1]?.origin).toEqual({ kind: "user" });
	});
});
