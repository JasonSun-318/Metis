import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentStore, SessionManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProcessHistory } from "../src/agent-process-history.ts";
import type { SessionRef } from "../src/session-runtime-host.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
	vi.restoreAllMocks();
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "metis-child-process-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const project = join(dir, "project");
	mkdirSync(project);
	const agentDir = join(dir, "agent");
	const root = SessionManager.create(project, join(agentDir, "sessions"), { mode: "chat" });
	cleanup.push(() => root.close());
	const sessionId = root.getSessionId();
	const store = new AgentStore(root, agentDir);
	const createChild = () => {
		const agentId = randomUUID();
		return store.create(
			{
				agentId,
				name: agentId,
				agentType: "worker",
				initialTask: "inspect",
				tools: ["bash"],
				writePolicy: "inherit",
				permissionPreset: "full",
				model: { provider: "fixture", modelId: "test" },
				thinkingLevel: "off",
				cwd: project,
				forkTurns: 0,
				timeoutSeconds: 60,
				mayDelegate: false,
				parentSessionId: sessionId,
				rootSessionId: sessionId,
				agentPath: [agentId],
			},
			[],
		);
	};
	const ref: SessionRef = {
		path: root.getSessionFile()!,
		relativePath: "root.jsonl",
		summary: {
			sessionId,
			mode: "chat",
			cwd: project,
			cwdOrigin: "user-selected",
			createdAt: root.getHeader()!.timestamp,
			updatedAt: root.getHeader()!.timestamp,
			state: "idle",
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		},
	};
	return { agentDir, ref, createChild };
}

function appendCommand(path: string, id: string, output: string, failed = false) {
	const writer = SessionManager.open(path);
	try {
		writer.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command: "pwd" } }],
			api: "openai-completions",
			provider: "fixture",
			model: "test",
			stopReason: "toolUse",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		writer.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: output }],
			isError: failed,
			timestamp: 2,
		});
	} finally {
		writer.close();
	}
}

describe("child process history cache", () => {
	it("opens only the selected child, reuses its index, refreshes appended results and releases deleted readers", async () => {
		const { agentDir, ref, createChild } = fixture();
		const child = createChild();
		const other = createChild();
		appendCommand(child.path, "first", "first output");
		appendCommand(other.path, "other", "unselected output");
		writeFileSync(join(dirname(child.path), "000-corrupt.jsonl"), "invalid journal\n");
		const open = vi.spyOn(SessionManager, "openJournalReadOnly");
		const history = new AgentProcessHistory(agentDir);
		cleanup.push(() => history.close());
		expect(await history.read(ref, child.agentId, "first")).toMatchObject({
			output: "first output",
			state: "completed",
		});
		const firstReader = open.mock.results[0]!.value as ReturnType<typeof SessionManager.openJournalReadOnly>;

		expect(await history.read(ref, child.agentId, "first")).toMatchObject({ command: "pwd" });
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith(child.path);
		appendCommand(child.path, "second", "failed output", true);
		expect(await history.read(ref, child.agentId, "second")).toMatchObject({
			output: "failed output",
			state: "failed",
		});
		expect(open).toHaveBeenCalledTimes(2);
		expect(() => firstReader.view[1]).toThrow(/closed/i);
		rmSync(child.path);
		await expect(history.read(ref, child.agentId, "first")).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects a child journal copied from another root", async () => {
		const first = fixture();
		const child = first.createChild();
		appendCommand(child.path, "call", "private output");
		const second = fixture();
		const sibling = second.createChild();
		copyFileSync(child.path, join(dirname(sibling.path), "foreign.jsonl"));
		const history = new AgentProcessHistory(second.agentDir);
		cleanup.push(() => history.close());
		await expect(history.read(second.ref, child.agentId, "call")).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("evicts readers at the capacity limit and closes the remaining readers", async () => {
		const { agentDir, ref, createChild } = fixture();
		const children = Array.from({ length: 9 }, () => createChild());
		for (const child of children) appendCommand(child.path, "call", "output");
		const open = vi.spyOn(SessionManager, "openJournalReadOnly");
		const history = new AgentProcessHistory(agentDir);
		cleanup.push(() => history.close());
		await history.read(ref, children[0]!.agentId, "call");
		const first = open.mock.results[0]!.value as ReturnType<typeof SessionManager.openJournalReadOnly>;

		for (const child of children.slice(1)) await history.read(ref, child.agentId, "call");
		expect(() => first.view[1]).toThrow(/closed/i);
		await history.read(ref, children[0]!.agentId, "call");
		expect(open).toHaveBeenCalledTimes(10);
		const last = open.mock.results.at(-1)!.value as ReturnType<typeof SessionManager.openJournalReadOnly>;

		history.close();
		expect(() => last.view[1]).toThrow(/closed/i);
	});
});
