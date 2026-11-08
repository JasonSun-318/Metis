import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FileEntry } from "../src/core/session-manager.ts";
import { readAgentConversation } from "../src/core/subagents/conversation-history.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
function outputDir() {
	const path = mkdtempSync(join(tmpdir(), "metis-history-"));
	dirs.push(path);
	return path;
}
function fixture(): FileEntry[] {
	return [
		{ type: "agent_task", id: "task-start", taskId: "task", status: "running" },
		{
			type: "agent_input",
			id: "input",
			messageId: "human",
			taskId: "task",
			origin: { kind: "user" },
			input: { text: "Question" },
			state: "delivered",
		},
		{ type: "message", id: "user", agentMessageId: "human", message: { role: "user", content: "Question" } },
		{
			type: "message",
			id: "answer",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE REASONING" },
					{ type: "text", text: "Answer" },
				],
			},
		},
		{
			type: "message",
			id: "tool",
			message: {
				role: "toolResult",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "RAW TOOL OUTPUT" }],
			},
		},
	].map((entry) => ({
		parentId: null,
		timestamp: "2026-11-06T00:00:00Z",
		...entry,
	})) as unknown as unknown as FileEntry[];
}
it("pages newest first across visible sources with stable older cursors", async () => {
	const dir = outputDir();
	const first = await readAgentConversation(fixture(), "child", { limit: 2 }, dir);
	expect(first.records.map((item) => item.messageId)).toEqual(["tool", "answer"]);
	expect(first.order).toBe("newest_first");
	expect(JSON.stringify(first)).not.toMatch(/PRIVATE REASONING|RAW TOOL OUTPUT/);
	const next = await readAgentConversation(fixture(), "child", { cursor: first.nextCursor }, dir);
	expect(next.records).toHaveLength(1);
	expect(next.records[0]).toMatchObject({
		messageId: "human",
		origin: { kind: "user" },
		text: "Question",
		taskId: "task",
	});
	expect(next.nextCursor).toBeUndefined();
});
it("preserves complete Unicode messages and exports history without hidden reasoning", async () => {
	const journal = fixture();
	const text = "完整报告😀\n".repeat(8000);
	journal.push({
		type: "message",
		id: "long",
		timestamp: "2026-11-06T01:00:00Z",
		message: { role: "assistant", content: [{ type: "text", text }] },
	} as unknown as FileEntry);
	const dir = outputDir();
	const page = await readAgentConversation(journal, "child", { limit: 1 }, dir);
	expect(page.records[0]?.truncated).toBe(true);
	expect(readFileSync(page.records[0]!.fullOutputPath!, "utf8")).toBe(text);
	const exported = await readAgentConversation(journal, "child", { output: "file", taskId: "task" }, dir);
	const saved = readFileSync(exported.fullOutputPath!, "utf8");
	expect(saved).toContain(text);
	expect(saved).toContain("Question");
	expect(saved).not.toContain("PRIVATE REASONING");
});
it("rejects unknown cursors and incompatible file pagination", async () => {
	await expect(readAgentConversation(fixture(), "child", { cursor: "missing" }, outputDir())).rejects.toMatchObject({
		code: "UNKNOWN_CURSOR",
	});
	await expect(
		readAgentConversation(fixture(), "child", { output: "file", cursor: "answer" }, outputDir()),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("keeps cursors stable when pending inputs and tool calls receive their results", async () => {
	const journal = fixture();
	journal.push({
		type: "agent_input",
		id: "queued",
		timestamp: "2026-11-06T02:00:00Z",
		messageId: "queued-message",
		taskId: "next-task",
		origin: { kind: "user" },
		state: "queued",
		input: { text: "Next question" },
	} as unknown as FileEntry);
	journal.push({
		type: "message",
		id: "calling",
		timestamp: "2026-11-06T03:00:00Z",
		message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
	} as unknown as FileEntry);
	const dir = outputDir();
	const first = await readAgentConversation(journal, "child", { limit: 1 }, dir);
	expect(first.nextCursor).toBe("call");
	journal.push({
		type: "message",
		id: "result",
		timestamp: "2026-11-06T04:00:00Z",
		message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false },
	} as unknown as FileEntry);
	journal.push({
		type: "message",
		id: "delivered",
		agentMessageId: "queued-message",
		timestamp: "2026-11-06T05:00:00Z",
		message: { role: "user", content: "Next question" },
	} as unknown as FileEntry);
	const older = await readAgentConversation(journal, "child", { cursor: first.nextCursor, limit: 1 }, dir);
	expect(older.records[0]?.messageId).toBe("queued-message");
	const rest = await readAgentConversation(journal, "child", { cursor: older.nextCursor }, dir);
	expect(rest.records.map((record) => record.messageId)).toEqual(["tool", "answer", "human"]);
});

it("defaults to twenty records, filters tasks and reads one message", async () => {
	const journal = fixture();
	for (let i = 0; i < 30; i++)
		journal.push({
			type: "message",
			id: `answer-${i}`,
			timestamp: "2026-11-06T03:00:00Z",
			message: { role: "assistant", content: [{ type: "text", text: `Reply ${i}` }] },
		} as unknown as FileEntry);
	const dir = outputDir();
	const page = await readAgentConversation(journal, "child", {}, dir);
	expect(page.records).toHaveLength(20);
	expect(page.records[0]?.text).toBe("Reply 29");
	expect(page.nextCursor).toBe("answer-10");
	const single = await readAgentConversation(journal, "child", { messageId: "human", taskId: "task" }, dir);
	expect(single.records).toHaveLength(1);
	expect(single.records[0]?.origin).toEqual({ kind: "user" });
	await expect(readAgentConversation(journal, "child", { limit: 101 }, dir)).rejects.toMatchObject({
		code: "INVALID_INPUT",
	});
	const empty = await readAgentConversation(journal, "child", { taskId: "other" }, dir);
	expect(empty.records).toEqual([]);
});

it("retains parent identity and image references without embedding image bytes", async () => {
	const journal = fixture();
	journal.push({
		type: "agent_input",
		id: "parent-input",
		timestamp: "2026-11-06T02:00:00Z",
		messageId: "assignment",
		taskId: "next",
		origin: { kind: "agent", sessionId: "parent" },
		state: "queued",
		input: {
			text: "Check this image",
			images: [{ type: "image_ref", hash: "image-hash", mimeType: "image/png", size: 100 }],
		},
	} as unknown as FileEntry);
	const page = await readAgentConversation(journal, "child", { taskId: "next" }, outputDir());
	expect(page.records).toHaveLength(1);
	expect(page.records[0]).toMatchObject({
		messageId: "assignment",
		origin: { kind: "agent", sessionId: "parent" },
		attachments: [{ type: "image_ref", hash: "image-hash", mimeType: "image/png" }],
	});
});
