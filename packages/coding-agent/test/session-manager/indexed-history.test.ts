import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@metis/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionStats } from "../../src/core/agent-session-transcript.ts";
import { IndexedSessionRecords } from "../../src/core/indexed-session-records.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("disk-backed session history", () => {
	const roots: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "metis-indexed-history-"));
		roots.push(root);
		const original = SessionManager.inMemory(root);
		const ids = Array.from({ length: 600 }, (_, index) =>
			original.appendMessage({ role: "user", content: `${index}:中文${"x".repeat(4096)}`, timestamp: index }),
		);
		original.appendCompaction("summary", ids[590], 100_000, undefined, undefined, { version: 1, messages: [] });
		const path = join(root, "session.jsonl");
		writeFileSync(
			path,
			`${original
				.getDurableJournalSnapshot()
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return { root, original, ids, path };
	}

	it("keeps a read-only journal view usable without a writer lease or retained message bodies", () => {
		const { path, original } = fixture();
		const source = SessionManager.openJournalReadOnly(path);
		try {
			expect(source.records).toEqual(original.getDurableJournalSnapshot());
			expect(Object.getOwnPropertyDescriptor(source.view, "1")?.get).toBeTypeOf("function");
			expect(source.view[1]).toEqual(source.records[1]);
			const writer = SessionManager.open(path);
			writer.appendMessage({ role: "user", content: "later", timestamp: 900 });
			writer.close();
			expect(source.view).toHaveLength(source.records.length);
			expect(source.view.at(-1)).toEqual(source.records.at(-1));
		} finally {
			source.close();
		}
		expect(() => source.view[1]).toThrow(/closed/i);
	});

	it("keeps raw journal migrations in memory and rejects a corrupt tail without rewriting the file", () => {
		const { path, original } = fixture();
		const records = original.getDurableJournalSnapshot();
		const legacy = `${[{ ...records[0], version: 14 }, ...records.slice(1)]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(path, legacy);
		const source = SessionManager.openJournalReadOnly(path);
		try {
			expect(source.records[0]).toMatchObject({ version: original.getHeader()!.version });
			expect([...source.view]).toEqual(source.records);
			expect(readFileSync(path, "utf8")).toBe(legacy);
		} finally {
			source.close();
		}
		const corrupt = `${legacy}{"type":`;
		writeFileSync(path, corrupt);
		expect(() => SessionManager.openJournalReadOnly(path)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(corrupt);
	});

	it("walks the complete tree without loading bodies and reads only kept model context", () => {
		const { original, ids, path } = fixture();
		const manager = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
		try {
			manager.releaseJournalReadCache();
			const reads = vi.spyOn(IndexedSessionRecords.prototype, "read");
			expect(manager.getBranch().map((entry) => entry.id)).toEqual(original.getBranch().map((entry) => entry.id));
			expect(
				manager.getJournalMetadata().filter((entry) => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(600);
			expect(reads).not.toHaveBeenCalled();
			expect(manager.buildSessionContext()).toEqual(original.buildSessionContext());
			expect(reads.mock.calls.every(([index]) => index >= 591)).toBe(true);
			const kept = manager.getEntry(ids[599])!;
			if (kept.type !== "message") throw new Error("Expected message");
			expect(manager.getMessageEntryId(kept.message)).toBe(ids[599]);
			manager.branch(ids[100]);
			expect(manager.buildSessionContext().messages).toHaveLength(101);
			const appended = manager.appendMessage({ role: "user", content: "new branch", timestamp: 700 });
			expect(manager.getEntry(appended)).toMatchObject({ message: { content: "new branch" } });
			expect(manager.getRuntimeRecovery().decisions).toEqual([]);
		} finally {
			manager.close();
		}
	});

	it("reads tool-result identities without loading their output bodies", () => {
		const { path } = fixture();
		const writer = SessionManager.open(path);
		writer.appendMessage({
			role: "toolResult",
			toolCallId: "process-call",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "large output".repeat(20000) }],
			timestamp: 800,
		});
		writer.close();
		const manager = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
		try {
			manager.releaseJournalReadCache();
			const reads = vi.spyOn(IndexedSessionRecords.prototype, "read");
			const entry = manager
				.getJournalMetadata()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("Missing result");
			expect(entry.message.toolCallId).toBe("process-call");
			expect(entry.message.isError).toBe(false);
			expect(reads).not.toHaveBeenCalled();
			expect(entry.message.content[0]).toMatchObject({ type: "text" });
			expect(reads).toHaveBeenCalledTimes(1);
		} finally {
			manager.close();
		}
	});

	it("preserves detached immutable snapshots after cache release, append and close", () => {
		const { original, path } = fixture();
		const manager = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
		manager.releaseJournalReadCache();
		const snapshot = manager.getDurableJournalSnapshot();
		expect(snapshot).toEqual(original.getDurableJournalSnapshot());
		manager.releaseJournalReadCache();
		manager.appendMessage({ role: "user", content: "appended", timestamp: 700 });
		const next = manager.getDurableJournalSnapshot();
		expect(next).toHaveLength(snapshot.length + 1);
		manager.close();
		expect(structuredClone(snapshot)).toEqual(original.getDurableJournalSnapshot());
		expect(Object.isFrozen(snapshot[1])).toBe(true);
		expect(Object.isFrozen((snapshot[1] as { message: object }).message)).toBe(true);
	});

	it("retains full initial corruption checks and detects later disk mutation", () => {
		const { path, ids } = fixture();
		const bytes = readFileSync(path, "utf8");
		writeFileSync(path, bytes.replace('"parentId":null', '"parentId":"missing"'));
		expect(() => SessionManager.open(path, undefined, undefined, { indexedHistory: true })).toThrow(/parent/i);
		writeFileSync(path, bytes);
		const manager = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
		manager.releaseJournalReadCache();
		writeFileSync(path, `${bytes} `);
		expect(() => {
			const entry = manager.getEntry(ids[0]);
			if (entry?.type === "message" && entry.message.role === "user") return entry.message.content;
		}).toThrow(/changed|identity/i);
		manager.close();
	});

	it("keeps eager image-reference hydration and missing-image markers equivalent", () => {
		const { path } = fixture();
		const records = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		records[1].message.content = [{ type: "image_ref", hash: "0".repeat(64), mimeType: "image/png", size: 10 }];
		writeFileSync(path, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const eager = SessionManager.open(path);
		const expected = eager.getEntries();
		eager.close();
		const indexed = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
		try {
			indexed.releaseJournalReadCache();
			expect(indexed.getEntries()).toEqual(expected);
		} finally {
			indexed.close();
		}
	});

	it("calculates full-history usage and tool totals without reading message bodies", () => {
		const { original, path } = fixture();
		original.appendMessage({
			...fauxAssistantMessage("a large answer"),
			content: [
				{ type: "text", text: "x".repeat(100_000) },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "example.txt" } },
			],
		});
		writeFileSync(
			path,
			`${original
				.getDurableJournalSnapshot()
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const stats = (manager: SessionManager) =>
			buildSessionStats({
				entries: manager.getEntries(),
				mode: manager.getMode(),
				cwd: manager.getCwd(),
				cwdOrigin: manager.getCwdOrigin(),
				permissionPreset: manager.getPermissionPreset(),
				sessionFile: path,
				sessionId: manager.getSessionId(),
			});
		const expected = stats(original);
		const indexed = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
		try {
			indexed.releaseJournalReadCache();
			indexed.releaseJournalReadCache();
			const reads = vi.spyOn(IndexedSessionRecords.prototype, "read");
			expect(stats(indexed)).toEqual(expected);
			expect(reads).not.toHaveBeenCalled();
		} finally {
			indexed.close();
		}
	});
});
