import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	CONTEXT_CARRY_MIGRATION_TYPE,
	type CompactionEntry,
	type CustomEntry,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

function contextMessages(entries: SessionEntry[], leaf: string) {
	return buildSessionContext(entries, leaf).messages;
}

function userEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function taskResultEntry(id: string, parentId: string | null, done: number, open: number): SessionMessageEntry {
	const tasks = [
		...Array.from({ length: done }, (_, i) => ({ task: `done-${i}`, completed: true })),
		...Array.from({ length: open }, (_, i) => ({ task: `open-${i}`, completed: false })),
	];
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "set_tasks",
			content: [{ type: "text", text: `<task_list>${tasks.map((t) => t.task).join(",")}</task_list>` }],
			details: { tasks },
			isError: false,
			timestamp: 1,
		},
	};
}

function compactionEntry(
	id: string,
	parentId: string | null,
	firstKeptEntryId: string,
	contextCarry?: CompactionEntry["contextCarry"],
): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 1000,
		contextCarry,
	};
}

function latestTasksCarry(text: string) {
	return {
		version: 1 as const,
		messages: [
			{
				role: "custom" as const,
				customType: "latest_tasks",
				content: [{ type: "text" as const, text }],
				display: false,
				timestamp: 2,
			},
		],
	};
}

describe("compaction context carry", () => {
	it("keeps the compaction carry snapshot while later task updates append", () => {
		const manager = SessionManager.inMemory();
		const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		const carry = {
			version: 1 as const,
			messages: [
				{
					role: "custom" as const,
					customType: "latest_tasks",
					content: "tasks-at-compaction",
					display: false,
					timestamp: 2,
				},
			],
		};
		manager.appendCompaction("summary", kept, 1000, undefined, false, carry);
		const before = manager.buildSessionContext().messages;
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tasks-2",
			toolName: "set_tasks",
			content: [{ type: "text", text: "new-tasks" }],
			isError: false,
			timestamp: 3,
			details: { tasks: [{ title: "new", completed: false }] },
		});
		const after = manager.buildSessionContext().messages;
		expect(after.slice(0, before.length)).toEqual(before);
		expect(JSON.stringify(after)).toContain("new-tasks");
		manager.close();
	});

	it("treats an empty carry as an explicit decision, not a missing snapshot", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tasks-1",
			toolName: "set_tasks",
			content: [{ type: "text", text: "old-tasks" }],
			isError: false,
			timestamp: 1,
			details: { tasks: [{ task: "open", completed: false }] },
		});
		const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 2 });
		manager.appendCompaction("summary", kept, 1000, undefined, false, { version: 1, messages: [] });
		const messages = manager.buildSessionContext().messages;
		expect(messages.some((m) => m.role === "custom" && m.customType === "latest_tasks")).toBe(false);
		manager.close();
	});

	it("rejects a carry containing non-latest_tasks messages", () => {
		const manager = SessionManager.inMemory();
		const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		const bad = {
			version: 1 as const,
			messages: [{ role: "user" as const, content: "fabricated", timestamp: 2 }],
		};
		expect(() => manager.appendCompaction("summary", kept, 1000, undefined, false, bad as never)).toThrow(
			/contextCarry/,
		);
		manager.close();
	});

	it("computes the carry from the newest pre-kept set_tasks result with open tasks", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tasks-1",
			toolName: "set_tasks",
			content: [{ type: "text", text: "carried-tasks" }],
			isError: false,
			timestamp: 1,
			details: { tasks: [{ task: "open", completed: false }] },
		});
		const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 2 });
		const carry = manager.computeCompactionCarry(kept);
		expect(carry.version).toBe(1);
		expect(carry.messages).toHaveLength(1);
		expect(carry.messages[0].role).toBe("custom");
		if (carry.messages[0].role !== "custom") throw new Error("unreachable");
		expect(carry.messages[0].customType).toBe("latest_tasks");
		expect(carry.messages[0].display).toBe(false);
		manager.close();
	});

	it("computes an empty carry when the newest set_tasks result stays in the kept range", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const kept = manager.appendMessage({
			role: "toolResult",
			toolCallId: "tasks-1",
			toolName: "set_tasks",
			content: [{ type: "text", text: "kept-tasks" }],
			isError: false,
			timestamp: 2,
			details: { tasks: [{ task: "open", completed: false }] },
		});
		expect(manager.computeCompactionCarry(kept).messages).toEqual([]);
		manager.close();
	});
});

describe("legacy compaction carry migration", () => {
	function seedLegacyCompaction(manager: SessionManager): void {
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tasks-1",
			toolName: "set_tasks",
			content: [{ type: "text", text: "legacy-tasks" }],
			isError: false,
			timestamp: 1,
			details: { tasks: [{ task: "open", completed: false }] },
		});
		const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 2 });
		manager.appendCompaction("summary", kept, 1000);
	}

	it("freezes the live lookup into one migration record", () => {
		const manager = SessionManager.inMemory();
		seedLegacyCompaction(manager);
		const before = manager.buildSessionContext().messages;
		expect(before.some((m) => m.role === "custom" && m.customType === "latest_tasks")).toBe(true);

		expect(manager.migrateCompactionCarry()).toBeDefined();
		expect(manager.migrateCompactionCarry()).toBeUndefined();

		const records = manager
			.getEntries()
			.filter((e): e is CustomEntry => e.type === "custom" && e.customType === CONTEXT_CARRY_MIGRATION_TYPE);
		expect(records).toHaveLength(1);

		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tasks-2",
			toolName: "set_tasks",
			content: [{ type: "text", text: "post-migration-tasks" }],
			isError: false,
			timestamp: 3,
			details: { tasks: [{ task: "new", completed: false }] },
		});
		const after = manager.buildSessionContext().messages;
		const carry = after.filter((m) => m.role === "custom" && m.customType === "latest_tasks");
		expect(carry).toHaveLength(1);
		expect(JSON.stringify(carry[0])).toContain("legacy-tasks");
		manager.close();
	});

	it("uses the earliest reachable migration record for the compaction", () => {
		const manager = SessionManager.inMemory();
		seedLegacyCompaction(manager);
		const compaction = manager.getEntries().find((e) => e.type === "compaction")!;
		manager.appendCustomEntry(CONTEXT_CARRY_MIGRATION_TYPE, {
			compactionEntryId: compaction.id,
			carry: latestTasksCarry("earliest"),
		});
		manager.appendCustomEntry(CONTEXT_CARRY_MIGRATION_TYPE, {
			compactionEntryId: compaction.id,
			carry: latestTasksCarry("later"),
		});
		const carry = manager
			.buildSessionContext()
			.messages.filter((m) => m.role === "custom" && m.customType === "latest_tasks");
		expect(JSON.stringify(carry[0])).toContain("earliest");
		manager.close();
	});

	it("records the empty carry as a decision so later updates cannot reintroduce one", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tasks-1",
			toolName: "set_tasks",
			content: [{ type: "text", text: "all-done" }],
			isError: false,
			timestamp: 1,
			details: { tasks: [{ task: "done", completed: true }] },
		});
		const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 2 });
		manager.appendCompaction("summary", kept, 1000);

		expect(manager.migrateCompactionCarry()).toBeDefined();
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tasks-2",
			toolName: "set_tasks",
			content: [{ type: "text", text: "post-migration-tasks" }],
			isError: false,
			timestamp: 3,
			details: { tasks: [{ task: "new", completed: false }] },
		});
		const carry = manager
			.buildSessionContext()
			.messages.filter((m) => m.role === "custom" && m.customType === "latest_tasks");
		expect(carry).toEqual([]);
		manager.close();
	});

	it("does not write a record when the latest compaction already has a carry", () => {
		const manager = SessionManager.inMemory();
		const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		manager.appendCompaction("summary", kept, 1000, undefined, false, latestTasksCarry("frozen"));
		expect(manager.migrateCompactionCarry()).toBeUndefined();
		expect(
			manager.getEntries().filter((e) => e.type === "custom" && e.customType === CONTEXT_CARRY_MIGRATION_TYPE),
		).toEqual([]);
		manager.close();
	});
});

describe("carry across branches", () => {
	it("applies the frozen carry on every descendant branch of the compaction", () => {
		const carry = latestTasksCarry("frozen-at-compaction");
		const entries: SessionEntry[] = [
			userEntry("1", null, "start"),
			taskResultEntry("2", "1", 0, 2),
			userEntry("3", "2", "retained"),
			compactionEntry("4", "3", "3", carry),
			userEntry("5a", "4", "branch-a"),
			taskResultEntry("5b", "4", 0, 1),
			userEntry("6b", "5b", "branch-b"),
		];
		for (const leaf of ["5a", "6b"]) {
			const messages = contextMessages(entries, leaf);
			const carries = messages.filter((m) => m.role === "custom" && m.customType === "latest_tasks");
			expect(carries).toHaveLength(1);
			expect(JSON.stringify(carries[0])).toContain("frozen-at-compaction");
		}
	});

	it("applies a branch's own migration record without leaking to siblings", () => {
		const entries: SessionEntry[] = [
			userEntry("1", null, "start"),
			taskResultEntry("2", "1", 0, 2),
			userEntry("3", "2", "retained"),
			compactionEntry("4", "3", "3"),
			{
				type: "custom",
				id: "5a",
				parentId: "4",
				timestamp: "2025-01-01T00:00:00Z",
				customType: CONTEXT_CARRY_MIGRATION_TYPE,
				data: { compactionEntryId: "4", carry: latestTasksCarry("branch-a-carry") },
			} satisfies CustomEntry,
			userEntry("6a", "5a", "branch-a"),
			userEntry("5b", "4", "branch-b"),
		];
		const a = contextMessages(entries, "6a").filter((m) => m.role === "custom" && m.customType === "latest_tasks");
		expect(JSON.stringify(a[0])).toContain("branch-a-carry");
		const b = contextMessages(entries, "5b").filter((m) => m.role === "custom" && m.customType === "latest_tasks");
		expect(JSON.stringify(b[0])).toContain("open-0");
	});
});
