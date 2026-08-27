import { describe, expect, it } from "vitest";
import type { FileEntry } from "../src/core/session-manager.ts";
import {
	MAX_TRACE_EVENT_UTF8_BYTES,
	MAX_TRACE_PAGE_UTF8_BYTES,
	projectAgentTrace,
} from "../src/core/subagents/trace.ts";
import { AgentError } from "../src/core/subagents/types.ts";

const TASK_ID = "task-1";

function entry(overrides: Record<string, unknown>): FileEntry {
	return overrides as unknown as FileEntry;
}

function journal(): FileEntry[] {
	return [
		entry({ type: "session", id: "header", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		entry({
			type: "agent_task",
			id: "task-record-queued",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			agentId: "child-1",
			taskId: TASK_ID,
			text: "Review the patch",
			taskSummary: "Review the patch",
			status: "queued",
		}),
		entry({
			type: "message",
			id: "user-1",
			parentId: "header",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "user", content: "Review the patch" },
		}),
		entry({
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "text", text: "Checking files." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/secret" } },
				],
			},
		}),
		entry({
			type: "message",
			id: "tool-1",
			parentId: "assistant-1",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "TOP SECRET OUTPUT" }],
				isError: false,
				details: { path: "/secret" },
			},
		}),
		entry({
			type: "agent_message",
			id: "steer-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:05.000Z",
			agentId: "child-1",
			taskId: TASK_ID,
			messageId: "msg-1",
			text: "Focus on auth.",
			state: "accepted",
		}),
		entry({
			type: "agent_task",
			id: "task-record-done",
			parentId: null,
			timestamp: "2026-01-01T00:00:06.000Z",
			agentId: "child-1",
			taskId: TASK_ID,
			text: "Review the patch",
			taskSummary: "Review the patch",
			status: "done",
			finalMessage: "Review complete.",
		}),
	];
}

describe("projectAgentTrace", () => {
	it("projects whitelist-visible activity newest first without leaking hidden content", () => {
		const result = projectAgentTrace({ journal: journal(), taskId: TASK_ID, limit: 20 });
		expect(result.events.map((event) => event.kind)).toEqual(["final", "tool", "llm"]);
		expect(JSON.stringify(result.events)).not.toContain("hidden reasoning");
		expect(JSON.stringify(result.events)).not.toContain("TOP SECRET OUTPUT");
		expect(JSON.stringify(result.events)).not.toContain("/secret");
		expect(result.events.find((event) => event.kind === "tool")).toMatchObject({
			toolName: "read",
			status: "success",
		});
		expect(result.events.find((event) => event.kind === "final")).toMatchObject({
			text: "Review complete.",
		});
	});

	it("paginates with beforeEventId and nextBeforeEventId", () => {
		const all = projectAgentTrace({ journal: journal(), taskId: TASK_ID, limit: 20 }).events;
		const firstPage = projectAgentTrace({ journal: journal(), taskId: TASK_ID, limit: 2 });
		expect(firstPage.events).toHaveLength(2);
		expect(firstPage.events[0]?.eventId).toBe(all[0]?.eventId);
		expect(firstPage.nextBeforeEventId).toBe(firstPage.events.at(-1)?.eventId);

		const secondPage = projectAgentTrace({
			journal: journal(),
			taskId: TASK_ID,
			limit: 2,
			beforeEventId: firstPage.nextBeforeEventId,
		});
		expect(secondPage.events[0]?.eventId).toBe(all[2]?.eventId);
		expect(secondPage.events.every((event) => !firstPage.events.some((seen) => seen.eventId === event.eventId))).toBe(
			true,
		);
	});

	it("rejects unknown cursors", () => {
		expect(() => projectAgentTrace({ journal: journal(), taskId: TASK_ID, beforeEventId: "missing-cursor" })).toThrow(
			AgentError,
		);
		try {
			projectAgentTrace({ journal: journal(), taskId: TASK_ID, beforeEventId: "missing-cursor" });
		} catch (error) {
			expect(error).toMatchObject({ code: "UNKNOWN_CURSOR" });
		}
	});

	it("truncates oversized text events and enforces the page budget", () => {
		const huge = "x".repeat(MAX_TRACE_EVENT_UTF8_BYTES + 128);
		const heavyJournal = [
			...journal().slice(0, 2),
			entry({
				type: "message",
				id: "assistant-huge",
				parentId: "header",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: huge },
						{ type: "toolCall", id: "call-huge", name: "read", arguments: {} },
					],
				},
			}),
			...journal().slice(-1),
		];
		const oversized = projectAgentTrace({ journal: heavyJournal, taskId: TASK_ID, limit: 10 });
		const llm = oversized.events.find((event) => event.eventId === "assistant-huge");
		expect(llm?.kind).toBe("llm");
		if (llm?.kind !== "llm") throw new Error("expected llm event");
		expect(llm.truncated).toBe(true);
		expect(new TextEncoder().encode(llm.text).byteLength).toBeLessThanOrEqual(MAX_TRACE_EVENT_UTF8_BYTES);

		const filler = "y".repeat(Math.floor(MAX_TRACE_PAGE_UTF8_BYTES / 3));
		const budgetJournal: FileEntry[] = [
			journal()[0]!,
			journal()[1]!,
			...Array.from({ length: 5 }, (_, index) =>
				entry({
					type: "message",
					id: `assistant-${index}`,
					parentId: "header",
					timestamp: `2026-01-01T00:00:0${index + 3}.000Z`,
					message: { role: "assistant", content: [{ type: "text", text: filler }] },
				}),
			),
			journal().at(-1)!,
		];
		const page = projectAgentTrace({ journal: budgetJournal, taskId: TASK_ID, limit: 10 });
		const pageBytes = page.events.reduce(
			(total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
			0,
		);
		expect(pageBytes).toBeLessThanOrEqual(MAX_TRACE_PAGE_UTF8_BYTES);
		expect(page.nextBeforeEventId).toBeDefined();
	});
});
