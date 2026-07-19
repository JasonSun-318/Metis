import { createHash } from "crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findMostRecentSession,
	getSessionImageDir,
	getSessionToolOutputDir,
	loadEntriesFromFile,
	moveSessionFileWithLease,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { assistantMsg } from "../utilities.ts";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("rejects a file without a valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(() => loadEntriesFromFile(file)).toThrow("not a valid arcmind session");
	});

	it("rejects malformed complete JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(() => loadEntriesFromFile(file)).toThrow("Malformed complete journal record");
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("stores images by hash and hydrates them when reopening", () => {
		const bytes = Buffer.from("same image bytes");
		const data = bytes.toString("base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "two copies" },
				{ type: "image", data, mimeType: "image/png" },
				{ type: "image", data, mimeType: "image/png" },
			],
			timestamp: 1,
		});
		session.appendMessage(assistantMsg("ok"));

		const sessionFile = session.getSessionFile()!;
		const raw = readFileSync(sessionFile, "utf8");
		expect(raw).not.toContain(data);
		expect(raw.match(/"type":"image_ref"/g)).toHaveLength(2);
		expect(readFileSync(join(getSessionImageDir(sessionFile), `${hash}.png`))).toEqual(bytes);

		session.close();
		const reopened = SessionManager.open(sessionFile, tempDir);
		const userMessage = reopened.buildSessionContext().messages[0];
		if (userMessage.role !== "user") throw new Error("Expected user message");
		expect(userMessage.content).toEqual([
			{ type: "text", text: "two copies" },
			{ type: "image", data, mimeType: "image/png" },
			{ type: "image", data, mimeType: "image/png" },
		]);
		reopened.close();
	});

	it("replaces a missing stored image with an unavailable note", () => {
		const bytes = Buffer.from("missing image bytes");
		const data = bytes.toString("base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/jpeg" }],
			timestamp: 1,
		});
		session.appendMessage(assistantMsg("ok"));
		unlinkSync(join(getSessionImageDir(session.getSessionFile()!), `${hash}.jpg`));

		session.close();
		const reopened = SessionManager.open(session.getSessionFile()!, tempDir);
		const userMessage = reopened.buildSessionContext().messages[0];
		if (userMessage.role !== "user") throw new Error("Expected user message");
		expect(userMessage.content).toEqual([{ type: "text", text: `[Image unavailable: ${hash}]` }]);
		reopened.close();
	});

	it("keeps inline data when an existing hash file is corrupt", () => {
		const bytes = Buffer.from("valid image bytes");
		const data = bytes.toString("base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const session = SessionManager.create(tempDir, tempDir);
		const imageDir = getSessionImageDir(session.getSessionFile()!);
		mkdirSync(imageDir, { recursive: true });
		writeFileSync(join(imageDir, `${hash}.png`), "corrupt");
		session.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		session.appendMessage(assistantMsg("ok"));

		const raw = readFileSync(session.getSessionFile()!, "utf8");
		expect(raw).toContain(data);
		expect(raw).not.toContain('"type":"image_ref"');
	});

	it.skipIf(process.platform === "win32")("does not trust a symlink at an existing image hash", () => {
		const bytes = Buffer.from("symlinked image bytes");
		const data = bytes.toString("base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const session = SessionManager.create(tempDir, tempDir);
		const imageDir = getSessionImageDir(session.getSessionFile()!);
		mkdirSync(imageDir, { recursive: true });
		const outside = join(tempDir, "outside-image");
		writeFileSync(outside, bytes);
		symlinkSync(outside, join(imageDir, `${hash}.png`));

		session.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});

		const raw = readFileSync(session.getSessionFile()!, "utf8");
		expect(raw).toContain(data);
		expect(raw).not.toContain('"type":"image_ref"');
		session.close();
	});

	it.skipIf(process.platform === "win32")("uses one image store across session path aliases", () => {
		const realDirectory = join(tempDir, "real");
		const aliasDirectory = join(tempDir, "alias");
		mkdirSync(realDirectory);
		symlinkSync(realDirectory, aliasDirectory, "dir");
		const bytes = Buffer.from("alias image bytes");
		const data = bytes.toString("base64");
		const session = SessionManager.create(aliasDirectory, aliasDirectory);
		session.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		const aliasFile = session.getSessionFile()!;
		session.close();

		const reopened = SessionManager.open(join(realDirectory, basename(aliasFile)), realDirectory);
		const message = reopened.buildSessionContext().messages[0];
		if (message.role !== "user") throw new Error("Expected user message");
		expect(message.content).toEqual([{ type: "image", data, mimeType: "image/png" }]);
		reopened.close();
	});

	it.skipIf(process.platform === "win32")("keeps image storage pinned when a session file alias is swapped", () => {
		const oldTarget = join(tempDir, "old.jsonl");
		const newTarget = join(tempDir, "new.jsonl");
		const aliasFile = join(tempDir, "current.jsonl");
		const makeHeader = (id: string) =>
			`${JSON.stringify({
				type: "session",
				version: 5,
				id,
				timestamp: "2025-01-01T00:00:00Z",
				cwd: tempDir,
			})}\n`;
		writeFileSync(oldTarget, makeHeader("old"));
		writeFileSync(newTarget, makeHeader("new"));
		symlinkSync(oldTarget, aliasFile, "file");

		const session = SessionManager.open(aliasFile, tempDir);
		expect(session.getToolOutputDir()).toBe(getSessionToolOutputDir(realpathSync(oldTarget)));
		const pinnedToolOutputDir = session.getToolOutputDir();
		unlinkSync(aliasFile);
		symlinkSync(newTarget, aliasFile, "file");
		expect(session.getToolOutputDir()).toBe(pinnedToolOutputDir);

		const bytes = Buffer.from("pinned alias image bytes");
		const data = bytes.toString("base64");
		session.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		session.close();

		expect(readFileSync(oldTarget, "utf8")).toContain('"type":"image_ref"');
		expect(readFileSync(newTarget, "utf8")).toBe(makeHeader("new"));
		const reopened = SessionManager.open(oldTarget, tempDir);
		const message = reopened.buildSessionContext().messages[0];
		if (message.role !== "user") throw new Error("Expected user message");
		expect(message.content).toEqual([{ type: "image", data, mimeType: "image/png" }]);
		reopened.close();
	});

	it("keeps image stores isolated between sessions", () => {
		const sharedBytes = Buffer.from("shared image");
		const sharedData = sharedBytes.toString("base64");
		const sharedHash = createHash("sha256").update(sharedBytes).digest("hex");

		const first = SessionManager.create(tempDir, tempDir);
		first.appendMessage({
			role: "user",
			content: [{ type: "image", data: sharedData, mimeType: "image/png" }],
			timestamp: 1,
		});
		first.appendMessage(assistantMsg("ok"));

		const second = SessionManager.create(tempDir, tempDir);
		second.appendMessage({
			role: "user",
			content: [{ type: "image", data: sharedData, mimeType: "image/png" }],
			timestamp: 1,
		});
		second.appendMessage(assistantMsg("ok"));

		const firstImageDir = getSessionImageDir(first.getSessionFile()!);
		const secondImageDir = getSessionImageDir(second.getSessionFile()!);
		expect(firstImageDir).not.toBe(secondImageDir);
		rmSync(firstImageDir, { recursive: true });
		expect(readFileSync(join(secondImageDir, `${sharedHash}.png`))).toEqual(sharedBytes);
	});

	it("migrates v3 inline images to current references", () => {
		const file = join(tempDir, "legacy.jsonl");
		const data = Buffer.from("legacy image bytes").toString("base64");
		const entries = [
			{ type: "session", version: 3, id: "legacy", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir },
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: {
					role: "user",
					content: [{ type: "image", data, mimeType: "image/webp" }],
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp: "2025-01-01T00:00:02Z",
				message: assistantMsg("ok"),
			},
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		SessionManager.open(file, tempDir).close();

		const raw = readFileSync(file, "utf8");
		expect(raw).toContain('"version":7');
		expect(raw).toContain('"type":"image_ref"');
		expect(raw).not.toContain(data);
		const backup = readdirSync(tempDir).find((name) => name.includes(".keep-v3."));
		expect(backup).toMatch(/\.replace\.bak$/);
		expect(readFileSync(join(tempDir, backup!), "utf8")).toContain('"version":3');
	});

	it("rejects a malformed complete line without changing the file", () => {
		const file = join(tempDir, "mixed.jsonl");
		const original =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			"not valid json\n" +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n';
		writeFileSync(file, original);
		expect(() => loadEntriesFromFile(file)).toThrow("Malformed complete journal record");
		expect(readFileSync(file, "utf8")).toBe(original);
	});
});

describe("moveSessionFileWithLease", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-move-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("moves a closed session to a durable destination", () => {
		const session = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const source = session.getSessionFile()!;
		const destination = join(tempDir, "sessions", ".archive", basename(source));
		session.close();

		moveSessionFileWithLease(source, destination);

		expect(existsSync(source)).toBe(false);
		expect(readFileSync(destination, "utf8")).toContain(`"id":"${session.getSessionId()}"`);
	});

	it("refuses to move a session with an active writer", () => {
		const session = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const source = session.getSessionFile()!;
		const destination = join(tempDir, "sessions", ".archive", basename(source));

		expect(() => moveSessionFileWithLease(source, destination)).toThrow();
		expect(existsSync(source)).toBe(true);
		expect(existsSync(destination)).toBe(false);
		session.close();
	});

	it.skipIf(process.platform === "win32")("refuses a symlink source", () => {
		const source = join(tempDir, "source.jsonl");
		const alias = join(tempDir, "alias.jsonl");
		const destination = join(tempDir, "archive", "source.jsonl");
		writeFileSync(source, "{}\n");
		symlinkSync(source, alias);

		expect(() => moveSessionFileWithLease(alias, destination)).toThrow("single-link regular file");
		expect(existsSync(source)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("refuses to replace a broken destination symlink", () => {
		const session = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const source = session.getSessionFile()!;
		const destination = join(tempDir, "sessions", ".archive", basename(source));
		session.close();
		mkdirSync(join(tempDir, "sessions", ".archive"), { recursive: true });
		symlinkSync(join(tempDir, "missing-target"), destination);

		expect(() => moveSessionFileWithLease(source, destination)).toThrow("already exists");
		expect(existsSync(source)).toBe(true);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("skips a newer session with a corrupt graph and returns the older valid session", async () => {
		const valid = join(tempDir, "valid.jsonl");
		const corrupt = join(tempDir, "corrupt.jsonl");
		writeFileSync(
			valid,
			'{"type":"session","version":5,"id":"valid","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		writeFileSync(
			corrupt,
			'{"type":"session","version":5,"id":"corrupt","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"orphan","parentId":"missing","timestamp":"2025-01-01T00:00:01Z","customType":"x"}\n',
		);

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("continues the newest session when only its final record is incomplete", async () => {
		const older = join(tempDir, "older.jsonl");
		const newer = join(tempDir, "newer.jsonl");
		writeFileSync(
			older,
			`${JSON.stringify({
				type: "session",
				version: 5,
				id: "older",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			})}\n`,
		);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		writeFileSync(
			newer,
			'{"type":"session","version":5,"id":"newer","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"complete","parentId":null,"timestamp":"2025-01-01T00:00:01Z","customType":"x"}\n' +
				'{"type":"custom","id":"partial"',
		);

		expect(findMostRecentSession(tempDir, "/tmp")).toBe(newer);
		expect((await SessionManager.list("/tmp", tempDir)).some((session) => session.path === newer)).toBe(true);
		const resumed = SessionManager.continueRecent("/tmp", tempDir);
		expect(resumed.getSessionFile()).toBe(newer);
		expect(resumed.getEntries()).toMatchObject([
			{ id: "complete", customType: "x" },
			{ type: "custom", customType: "arcmind.session_recovery", parentId: "complete" },
		]);
		resumed.close();
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionManager custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(cwd: string, label: string): string {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		session.close();
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = createPersistedSession(projectB, "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses cwd from a valid header longer than the initial read buffer", () => {
		const path = join(tempDir, "long-header.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({
				type: "session",
				version: 5,
				id: "long-header",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: tempDir,
				parentSession: "x".repeat(70 * 1024),
			})}\n`,
		);

		const manager = SessionManager.open(path, tempDir);
		expect(manager.getCwd()).toBe(tempDir);
		manager.close();
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("throws and preserves non-empty file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		const originalContent =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, originalContent);

		expect(() => SessionManager.open(noHeaderFile, tempDir)).toThrow(
			`Session file is not a valid arcmind session: ${noHeaderFile}`,
		);
		expect(readFileSync(noHeaderFile, "utf-8")).toBe(originalContent);
	});

	it("throws and preserves non-session JSONL files", () => {
		const nonSessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(nonSessionFile, originalContent);

		expect(() => SessionManager.open(nonSessionFile, tempDir)).toThrow(
			`Session file is not a valid arcmind session: ${nonSessionFile}`,
		);
		expect(readFileSync(nonSessionFile, "utf-8")).toBe(originalContent);
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of initialized empty file work correctly", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm1 = SessionManager.open(emptyFile, tempDir);
		const sessionId = sm1.getSessionId();
		sm1.close();

		const sm2 = SessionManager.open(emptyFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
		sm2.close();
	});
});
