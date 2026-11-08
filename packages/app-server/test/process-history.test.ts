import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileEntry, SessionManager } from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import { ProcessHistory } from "../src/process-history.ts";
import { ProcessProjector } from "../src/process-projector.ts";
import { AppServerError } from "../src/session-runtime-host.ts";

type JournalMessage = Extract<FileEntry, { type: "message" }>["message"];
type AssistantMessage = Extract<JournalMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<JournalMessage, { role: "toolResult" }>;

const sessionId = "11111111-1111-4111-8111-111111111111";
const call = (id: string, command = "echo same"): FileEntry =>
	({
		type: "message",
		id: `call-${id}`,
		parentId: null,
		timestamp: "2026-11-06T00:00:00Z",
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
	}) as unknown as FileEntry;
const start = (id: string, state = "started"): FileEntry =>
	({
		type: "runtime_tool",
		toolName: "bash",
		toolCallId: id,
		turnId: "turn",
		state,
		timestamp: "2026-11-06T12:00:00.000Z",
	}) as FileEntry;
const result = (id: string, output: string, isError = false): FileEntry =>
	({
		type: "message",
		id: `result-${id}`,
		message: {
			role: "toolResult",
			toolName: "bash",
			toolCallId: id,
			isError,
			content: [{ type: "text", text: output }],
		},
	}) as FileEntry;

describe("process history", () => {
	it("keeps repeated commands distinct, returns newest by default, and pins an identity across later turns", async () => {
		const journal = [
			call("one"),
			start("one"),
			result("one", "first"),
			call("two"),
			start("two"),
			result("two", "second"),
		];
		const history = new ProcessHistory();
		expect(await history.read(journal, { sessionId })).toMatchObject({
			total: 2,
			index: 1,
			process: { command: "echo same", output: "second", startedAt: "2026-11-06T12:00:00.000Z" },
		});
		const first = await history.read(journal, { sessionId, index: 0 });
		journal.push(call("three"), start("three"), result("three", "third"));
		expect(await history.read(journal, { sessionId, processId: first.process!.processId })).toMatchObject({
			total: 3,
			index: 0,
			process: { output: "first" },
		});
	});
	it("indexes a long history without reading unselected output bodies", async () => {
		let reads = 0;
		let callReads = 0;
		const journal = Array.from({ length: 5000 }, (_, i) => {
			const entry = result(String(i), "");
			Object.defineProperty((entry as { message: object }).message, "content", {
				get() {
					reads++;
					return [{ type: "text", text: `output ${i}` }];
				},
			});
			const assistant = call(String(i));
			const message = (assistant as Extract<FileEntry, { type: "message" }>).message as AssistantMessage;
			const content = message.content;
			Object.defineProperty(message, "content", {
				get() {
					callReads++;
					return content;
				},
			});
			return [assistant, start(String(i)), entry];
		}).flat();
		const history = new ProcessHistory();
		expect((await history.read(journal, { sessionId })).process?.output).toBe("output 4999");
		expect(reads).toBe(1);
		expect(callReads).toBe(1);
		await history.read(journal, { sessionId, index: 1 });
		expect(reads).toBe(2);
	});
	it("uses cumulative live output without making new records, and handles failed and interrupted executions", async () => {
		const journal = [call("one"), start("one")];
		const live = new ProcessProjector();
		const history = new ProcessHistory();
		live.apply({ type: "tool_execution_start", toolName: "bash", toolCallId: "one", args: { command: "echo same" } });
		for (const text of ["a", "ab", "abc"]) {
			live.apply({
				type: "tool_execution_update",
				toolName: "bash",
				toolCallId: "one",
				args: {},
				partialResult: { content: [{ type: "text", text }] },
			});
			expect(await history.read(journal, { sessionId }, (id) => live.read(id))).toMatchObject({
				total: 1,
				process: { output: text, state: "running" },
			});
		}
		journal.push(start("one", "interrupted"));
		expect((await history.read(journal, { sessionId })).process?.state).toBe("interrupted");
		journal.push(call("two"), start("two"), result("two", "error", true));
		expect((await history.read(journal, { sessionId })).process?.state).toBe("failed");
	});
	it("resolves child references only when selected and keeps their place among parent commands", async () => {
		const journal = [
			call("one"),
			start("one"),
			result("one", "parent"),
			{
				type: "custom",
				customType: "metis.process",
				data: { agentId: "child", toolCallId: "child-call", turnId: "turn" },
			} as FileEntry,
			call("two"),
			start("two"),
			result("two", "last"),
		];
		const child = [call("child-call"), result("child-call", "child output")];
		let reads = 0;
		const readChild = async () => {
			reads++;
			return (await new ProcessHistory().read(child, { sessionId })).process;
		};
		const history = new ProcessHistory();
		await history.read(journal, { sessionId }, undefined, readChild);
		expect(reads).toBe(0);
		expect(await history.read(journal, { sessionId, index: 1 }, undefined, readChild)).toMatchObject({
			total: 3,
			index: 1,
			process: { output: "child output", startedAt: "2026-11-06T00:00:00Z" },
		});
		expect(reads).toBe(1);
	});
	it("keeps navigation usable when a source child was deleted", async () => {
		const journal = [
			{ type: "custom", customType: "metis.process", data: { agentId: "deleted", toolCallId: "call" } } as FileEntry,
		];
		const page = await new ProcessHistory().read(journal, { sessionId }, undefined, async () => {
			throw new AppServerError("NOT_FOUND");
		});
		expect(page).toMatchObject({ total: 1, index: 0, process: { state: "unavailable" } });
	});
	it("restores existing command/result evidence after closing and reopening a real session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-process-history-"));
		try {
			const manager = SessionManager.create(dir, join(dir, "sessions"), { id: sessionId, mode: "chat" });
			const message = (call("saved") as Extract<FileEntry, { type: "message" }>).message;
			manager.appendMessage({
				...message,
				api: "openai-completions",
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			} as AssistantMessage);
			manager.appendMessage({
				...(result("saved", "大".repeat(50000)) as Extract<FileEntry, { type: "message" }>).message,
				timestamp: 2,
			} as ToolResultMessage);
			const file = manager.getSessionFile()!;
			manager.close();
			const reopened = SessionManager.openReadOnly(file);
			const page = await new ProcessHistory().read(reopened.getJournalMetadata(), { sessionId });
			expect(page.process?.command).toBe("echo same");
			expect(page.process?.startedAt).toBe(
				reopened.getJournalMetadata().find((entry) => entry.type === "message")?.timestamp,
			);
			expect(page.process?.state).toBe("completed");
			expect(page.process?.truncated).toBe(true);
			expect(Buffer.byteLength(page.process!.output)).toBeLessThanOrEqual(65536);
			expect(page.process?.output).not.toContain("�");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
