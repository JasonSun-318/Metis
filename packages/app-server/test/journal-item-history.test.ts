import type { ItemView, SessionSummary } from "@metis/app-protocol";
import type { FileEntry } from "@metis/coding-agent/host";
import { describe, expect, it, vi } from "vitest";
import { projectAgentMailboxItem } from "../src/agent-conversation-projection.ts";
import { projectSessionEntry } from "../src/item-projection.ts";
import { JournalItemHistory, ProjectedItemCache } from "../src/projection/journal-item-history.ts";
import { SessionProjection } from "../src/projection/session-projection.ts";

const time = "2026-11-05T00:00:00.000Z";
const session: SessionSummary = {
	sessionId: "history-session",
	mode: "code",
	cwdOrigin: "user-selected",
	cwd: "/tmp",
	createdAt: time,
	updatedAt: time,
	state: "idle",
	archived: false,
	unread: false,
	useMemory: true,
	contributeMemory: true,
};

function message(index: number): Record<string, unknown> {
	return {
		type: "message",
		id: `item-${index}`,
		timestamp: time,
		message: { role: "user", content: `消息 ${index}` },
	};
}

function project(entry: Record<string, unknown>): ItemView | undefined {
	return projectSessionEntry({
		entry,
		sessionId: session.sessionId,
		turnStates: new Map(),
		toolStates: new Map(),
		fallbackTimestamp: time,
	});
}

describe("lazy journal item history", () => {
	it.each([false, true])(
		"uses mailbox event identity across durable receipts, pages and live updates (indexed=%s)",
		(indexed) => {
			const queued = {
				type: "agent_mailbox_event",
				id: "mailbox-queued-record",
				parentId: null,
				timestamp: time,
				event: {
					type: "intervention",
					eventId: "mailbox/event-1",
					taskId: "task-1",
					agentId: "00000000-0000-4000-8000-000000000002",
					parentSessionId: session.sessionId,
					name: "Worker",
					completedAt: time,
					messageId: "message-1",
					instructionRevision: 1,
					delivery: "steer",
					state: "queued",
					text: "Check the layout",
				},
			} satisfies Extract<FileEntry, { type: "agent_mailbox_event" }>;
			const delivered = {
				...queued,
				id: "mailbox-delivered-record",
				event: { ...queued.event, state: "delivered" as const },
			};
			const journal = [message(0), queued, message(1), delivered, message(2)];
			const projector = vi.fn((entry: Record<string, unknown>) =>
				entry.type === "agent_mailbox_event"
					? projectAgentMailboxItem(
							entry as unknown as Extract<FileEntry, { type: "agent_mailbox_event" }>,
							session.sessionId,
							time,
						)
					: project(entry),
			);
			const reader = vi.fn((index: number) => journal[index]!);
			const history = new JournalItemHistory(
				journal,
				projector,
				new ProjectedItemCache(),
				indexed ? reader : undefined,
			);
			const projection = new SessionProjection({ session, history });
			const mailboxItem = projectAgentMailboxItem(delivered, session.sessionId, time);
			expect(history.itemIds).toEqual(["item-0", mailboxItem.itemId, "item-1", "item-2"]);
			expect(projector).not.toHaveBeenCalled();
			expect(reader).not.toHaveBeenCalled();
			expect(projection.snapshot("epoch", 1).recentItems).toEqual([
				project(message(0)),
				mailboxItem,
				project(message(1)),
				project(message(2)),
			]);
			const latest = projection.readItems({ sessionId: session.sessionId, limit: 2 });
			expect(latest).toEqual({ items: [project(message(1)), project(message(2))], nextBeforeItemId: "item-1" });
			expect(
				projection.readItems({ sessionId: session.sessionId, beforeItemId: latest.nextBeforeItemId, limit: 2 }),
			).toEqual({ items: [project(message(0)), mailboxItem], nextBeforeItemId: null });
			expect(
				projection.readItems({ sessionId: session.sessionId, beforeItemId: mailboxItem.itemId, limit: 2 }),
			).toEqual({ items: [project(message(0))], nextBeforeItemId: null });
			if (indexed) {
				expect(reader).toHaveBeenCalledWith(3);
				expect(reader).not.toHaveBeenCalledWith(1);
			}
			const liveReceipt = projectAgentMailboxItem(
				delivered,
				session.sessionId,
				time,
				new Map([[queued.event.messageId, { agentId: queued.event.agentId, state: "cancelled" as const }]]),
			);
			projection.apply({ type: "item/completed", item: liveReceipt });
			expect(projection.snapshot("epoch", 2).recentItems).toEqual([
				project(message(0)),
				liveReceipt,
				project(message(1)),
				project(message(2)),
			]);
		},
	);

	it("materializes only requested pages and preserves eager history output, cursors and live updates", () => {
		const journal = Array.from({ length: 1_000 }, (_, index) => message(index));
		const projector = vi.fn(project);
		const cache = new ProjectedItemCache();
		const history = new JournalItemHistory(journal, projector, cache);
		const lazy = new SessionProjection({ session, history });
		const eager = new SessionProjection({
			session,
			items: journal.map(project).filter((item) => item !== undefined),
		});
		expect(projector).not.toHaveBeenCalled();
		const snapshot = lazy.snapshot("epoch", 1);
		expect(snapshot).toEqual(eager.snapshot("epoch", 1));
		expect(projector.mock.calls.length).toBe(201);
		const rows = [...snapshot.recentItems];
		let beforeItemId = snapshot.nextBeforeItemId;
		while (beforeItemId) {
			const params = { sessionId: session.sessionId, beforeItemId, limit: 200 };
			const page = lazy.readItems(params);
			expect(page).toEqual(eager.readItems(params));
			rows.unshift(...page.items);
			beforeItemId = page.nextBeforeItemId;
		}
		expect(rows).toEqual(journal.map(project));
		const live: ItemView = { ...rows[0]!, itemId: "live", role: "assistant", state: "streaming", content: [] };
		for (const projection of [lazy, eager]) {
			projection.apply({ type: "item/started", item: live });
			projection.apply({
				type: "item/delta",
				sessionId: session.sessionId,
				itemId: live.itemId,
				delta: { type: "text", text: "正在输出" },
			});
		}
		expect(lazy.snapshot("epoch", 2)).toEqual(eager.snapshot("epoch", 2));
		const page = lazy.readItems({ sessionId: session.sessionId, beforeItemId: "item-10", limit: 2 });
		(page.items[0]! as { content: unknown[] }).content = [];
		expect(lazy.readItems({ sessionId: session.sessionId, beforeItemId: "item-10", limit: 2 })).toEqual(
			eager.readItems({ sessionId: session.sessionId, beforeItemId: "item-10", limit: 2 }),
		);
	});

	it("skips invisible records without phantom cursors and rejects a non-item cursor", () => {
		const journal = [
			{ type: "session", id: "header" },
			{ type: "model_change", id: "hidden-0" },
			message(1),
			{ type: "message", id: "empty", message: { role: "assistant", content: [] } },
			message(2),
			{ type: "runtime_turn", id: "hidden-1" },
		];
		const lazy = new SessionProjection({
			session,
			history: new JournalItemHistory(journal, project, new ProjectedItemCache()),
		});
		expect(lazy.readItems({ sessionId: session.sessionId, limit: 1 })).toMatchObject({
			items: [{ itemId: "item-2" }],
			nextBeforeItemId: "item-2",
		});
		expect(lazy.readItems({ sessionId: session.sessionId, beforeItemId: "item-2", limit: 10 })).toEqual({
			items: [project(message(1))],
			nextBeforeItemId: null,
		});
		for (const beforeItemId of ["missing", "hidden-0", "empty"]) {
			expect(() => lazy.readItems({ sessionId: session.sessionId, beforeItemId, limit: 10 })).toThrow("NOT_FOUND");
		}
	});

	it("appends a newly visible live row even when its identity exists in hidden journal metadata", () => {
		const journal = [message(0), { type: "custom", id: "hidden" }, message(1)];
		const lazy = new SessionProjection({
			session,
			history: new JournalItemHistory(journal, project, new ProjectedItemCache()),
		});
		const eager = new SessionProjection({
			session,
			items: journal.map(project).filter((item) => item !== undefined),
		});
		const revealed = { ...project(message(2))!, itemId: "hidden" };
		for (const projection of [lazy, eager]) projection.apply({ type: "item/completed", item: revealed });
		expect(lazy.snapshot("epoch", 0)).toEqual(eager.snapshot("epoch", 0));
	});

	it("keeps the existing UTF-8 response budget when pages exceed the byte limit", () => {
		const journal = Array.from({ length: 20 }, (_, index) => message(index));
		const large = (entry: Record<string, unknown>): ItemView => ({
			...project(entry)!,
			content: [{ type: "text", text: "界".repeat(350_000) }],
		});
		const lazy = new SessionProjection({
			session,
			history: new JournalItemHistory(journal, large, new ProjectedItemCache({ maxBytes: 2_000_000 })),
		});
		const eager = new SessionProjection({ session, items: journal.map(large) });
		let beforeItemId: string | null = null;
		const ids: string[] = [];
		do {
			const params = { sessionId: session.sessionId, beforeItemId, limit: 200 };
			const page = lazy.readItems(params);
			expect(page).toEqual(eager.readItems(params));
			expect(Buffer.byteLength(JSON.stringify(page.items), "utf8")).toBeLessThanOrEqual(6 * 1024 * 1024);
			ids.unshift(...page.items.map((item) => item.itemId));
			beforeItemId = page.nextBeforeItemId;
		} while (beforeItemId);
		expect(ids).toEqual(journal.map((record) => record.id));
	});

	it("evicts by entry count and byte budget, then reconstructs the same row without affecting other histories", () => {
		for (const options of [
			{ maxEntries: 2, maxBytes: 100_000 },
			{ maxEntries: 100, maxBytes: 500 },
		]) {
			const projector = vi.fn(project);
			const cache = new ProjectedItemCache(options);
			const first = new JournalItemHistory([message(0)], projector, cache);
			const second = new JournalItemHistory([message(1), message(2), message(3)], projector, cache);
			const initial = first.readItem("item-0");
			expect(first.readItem("item-0")).toBe(initial);
			for (const itemId of second.itemIds) second.readItem(itemId);
			const restored = first.readItem("item-0");
			expect(restored).toEqual(initial);
			expect(restored).not.toBe(initial);
			expect(projector).toHaveBeenCalledTimes(5);
		}
	});

	it("updates an unmaterialized historical permission row without projecting unrelated messages", () => {
		const tool = {
			type: "message",
			id: "tool-message",
			timestamp: time,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "action", name: "read_file", arguments: { path: "a" } }],
			},
		};
		const projector = vi.fn(project);
		const history = new JournalItemHistory(
			[tool, ...Array.from({ length: 500 }, (_, i) => message(i))],
			projector,
			new ProjectedItemCache(),
		);
		const projection = new SessionProjection({ session, history });
		const updates = projection.setPermissionDecision("action", "user", { outcome: "allow" });
		expect(projector).toHaveBeenCalledTimes(1);
		expect(updates).toMatchObject([
			{ itemId: "tool-message", content: [{ permissionDecision: { source: "user", outcome: "allow" } }] },
		]);
		expect(projection.readItems({ sessionId: session.sessionId, beforeItemId: "item-0", limit: 10 }).items).toEqual(
			updates,
		);
	});
});
