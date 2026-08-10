import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const journalOpens = vi.hoisted(() => ({ readOnly: 0, writable: 0 }));

vi.mock("../src/core/session-journal.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/session-journal.ts")>();
	return {
		...actual,
		openSessionJournal: (...args: Parameters<typeof actual.openSessionJournal>) => {
			if (args[1]?.readOnly) journalOpens.readOnly++;
			else journalOpens.writable++;
			return actual.openSessionJournal(...args);
		},
	};
});

import { identifySubmitPromptRequest } from "../src/core/runtime-recovery.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function header(id: string, version?: number) {
	return { type: "session", ...(version === undefined ? {} : { version }), id, timestamp, cwd: "/tmp" };
}

function writeRecords(path: string, records: readonly unknown[], tail = ""): void {
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n${tail}`);
}

describe("session catalog", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "metis-session-catalog-"));
		journalOpens.readOnly = 0;
		journalOpens.writable = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});

	it.each([
		{ label: "1", version: undefined },
		{ label: "2", version: 2 },
		{ label: "3", version: 3 },
		{ label: "4", version: 4 },
		{ label: "5", version: 5 },
	] as const)("summarizes v$label without hydrating the whole session", async ({ version }) => {
		const legacy = version === undefined;
		const base = (id: string, parentId: string | null, offset: number) =>
			legacy ? { timestamp: new Date(Date.parse(timestamp) + offset).toISOString() } : { id, parentId, timestamp };
		const path = join(directory, `v${version ?? 1}.jsonl`);
		const records: unknown[] = [
			header(`session-${version ?? 1}`, version),
			{ ...base("user", null, 1), type: "message", message: { role: "user", content: "hello", timestamp: 10 } },
			{
				...base("assistant", "user", 2),
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "world" }], timestamp: 20 },
			},
			{ ...base("name", "assistant", 3), type: "session_info", name: "  Catalog Name  " },
		];
		if (version === 5) {
			const input = { text: "catalog runtime" };
			const identity = identifySubmitPromptRequest("catalog-request", input);
			records.push({
				...base("runtime", "name", 4),
				type: "runtime_operation",
				operationId: identity.operationId,
				requestId: identity.requestId,
				requestHash: identity.requestHash,
				kind: "turn",
				state: "accepted",
				turnId: identity.turnId,
				input,
			});
		}
		writeRecords(path, records);

		const sessions = await SessionManager.list("/tmp", directory);
		expect(sessions).toMatchObject([
			{
				path,
				id: `session-${version ?? 1}`,
				name: "Catalog Name",
				messageCount: 2,
				firstMessage: "hello",
				allMessagesText: "hello world",
			},
		]);
		expect(sessions[0].modified.getTime()).toBe(20);
		expect(journalOpens).toEqual({ readOnly: 0, writable: 0 });
	});

	it("accepts only an incomplete final tail and rejects malformed complete records", async () => {
		const partial = join(directory, "partial.jsonl");
		const malformed = join(directory, "malformed.jsonl");
		writeRecords(partial, [header("partial", 4)], '{"type":"message"');
		writeFileSync(malformed, `${JSON.stringify(header("malformed", 4))}\nnot-json\n`);

		const sessions = await SessionManager.list("/tmp", directory);
		expect(sessions.map((session) => session.path)).toEqual([partial]);
	});

	it("hides attachment metadata in the session-list preview", async () => {
		const path = join(directory, "attachment.jsonl");
		const internalPath = "/private/attachments/token-report.pdf";
		writeRecords(path, [
			header("attachment", 4),
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp,
				message: {
					role: "user",
					content: `<attachment>${JSON.stringify({ name: "report.pdf", path: internalPath, size: 12 })}</attachment> summarize`,
					timestamp: 1,
				},
			},
		]);

		const [session] = await SessionManager.list("/tmp", directory);
		expect(session.firstMessage).toBe("[report.pdf] summarize");
		expect(session.firstMessage).not.toContain(internalPath);
	});

	it.skipIf(process.platform === "win32")("rejects final-component symlink and hardlink aliases", async () => {
		const outside = join(tmpdir(), `metis-session-catalog-outside-${process.pid}-${Date.now()}.jsonl`);
		writeRecords(outside, [header("outside", 4)]);
		try {
			symlinkSync(outside, join(directory, "symlink.jsonl"));
			linkSync(outside, join(directory, "hardlink.jsonl"));
			expect(await SessionManager.list("/tmp", directory)).toEqual([]);
		} finally {
			rmSync(outside, { force: true });
		}
	});

	it.skipIf(process.platform === "win32")("does not block the async catalog on a FIFO", () => {
		const fifoPath = join(directory, "fifo.jsonl");
		execFileSync("mkfifo", [fifoPath]);
		const moduleUrl = new URL("../src/core/session-manager.ts", import.meta.url).href;
		const source = `
			import { SessionManager } from ${JSON.stringify(moduleUrl)};
			const sessions = await SessionManager.list("/tmp", process.argv[1]);
			process.exit(sessions.length === 0 ? 0 : 2);
		`;
		const child = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "--eval", source, directory],
			{ timeout: 10_000 },
		);
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
	});

	it("keeps the event loop responsive while scanning a large history", async () => {
		const path = join(directory, "large.jsonl");
		const records: unknown[] = [header("large", 4)];
		let parentId: string | null = null;
		for (let index = 0; index < 6_000; index++) {
			const id = `message-${index}`;
			records.push({
				type: "message",
				id,
				parentId,
				timestamp,
				message: { role: "user", content: `message ${index} ${"x".repeat(350)}`, timestamp: index + 1 },
			});
			parentId = id;
		}
		writeRecords(path, records);

		let active = true;
		let turns = 0;
		const tick = () => {
			turns++;
			if (active) setImmediate(tick);
		};
		setImmediate(tick);
		const [session] = await SessionManager.list("/tmp", directory);
		active = false;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(session.messageCount).toBe(6_000);
		expect(turns).toBeGreaterThan(1);
	});

	it("opens each recent candidate once and skips a corrupt newer candidate", () => {
		const valid = join(directory, "valid.jsonl");
		const corrupt = join(directory, "corrupt.jsonl");
		writeRecords(valid, [header("valid", 4)]);
		writeRecords(corrupt, [
			header("corrupt", 4),
			{ type: "custom", customType: "x", id: "orphan", parentId: "missing", timestamp },
		]);
		utimesSync(valid, new Date(1_000), new Date(1_000));
		utimesSync(corrupt, new Date(2_000), new Date(2_000));

		const manager = SessionManager.continueRecent("/tmp", directory);
		try {
			expect(manager.getSessionFile()).toBe(valid);
			expect(journalOpens).toEqual({ readOnly: 0, writable: 2 });
		} finally {
			manager.close();
		}
	});

	it("does not hide an active recent session by creating a new one", () => {
		const active = SessionManager.create("/tmp", directory, { id: "active" });
		try {
			expect(() => SessionManager.continueRecent("/tmp", directory)).toThrow("already in use");
		} finally {
			active.close();
		}
	});
});
