import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionJournal } from "../../src/core/session-journal.ts";
import { SessionLease } from "../../src/core/session-lease.ts";
import { CURRENT_SESSION_VERSION, getSessionImageDir, SessionManager } from "../../src/core/session-manager.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function header(overrides: Record<string, unknown> = {}) {
	return { type: "session", version: 5, id: "session-1", timestamp, cwd: "/tmp", ...overrides };
}

function entry(id: string, parentId: string | null) {
	return { type: "custom", customType: "test", id, parentId, timestamp };
}

describe("SessionManager durable ownership and recovery", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arcmind-session-manager-durable-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("holds one writer lease for the manager lifetime while read-only snapshots remain available", () => {
		const writer = SessionManager.create(directory, directory);
		const entryId = writer.appendCustomEntry("state", { ready: true });
		const path = writer.getSessionFile()!;

		expect(() => SessionManager.open(path)).toThrow("already in use");
		const snapshot = SessionManager.openReadOnly(path);
		expect(snapshot.getEntries()).toHaveLength(1);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect((snapshot as unknown as { appendCustomEntry?: unknown }).appendCustomEntry).toBeUndefined();
		const snapshotEntry = snapshot.getEntry(entryId);
		if (snapshotEntry?.type !== "custom") throw new Error("Expected custom entry");
		expect(Object.isFrozen(snapshotEntry.data)).toBe(true);
		expect(() => {
			(snapshotEntry.data as { ready: boolean }).ready = false;
		}).toThrow(TypeError);
		expect(snapshot.getEntry(entryId)).toMatchObject({ data: { ready: true } });

		writer.close();
		const reopened = SessionManager.open(path);
		expect(reopened.getEntries()).toHaveLength(1);
		reopened.close();
	});

	it.skipIf(process.platform === "win32")("skips a FIFO session header without blocking the catalog", () => {
		const fifoPath = join(directory, "fifo.jsonl");
		execFileSync("mkfifo", [fifoPath]);
		const moduleUrl = new URL("../../src/core/session-manager.ts", import.meta.url).href;
		const source = `
			import { findMostRecentSession } from ${JSON.stringify(moduleUrl)};
			process.exit(findMostRecentSession(process.argv[1]) === null ? 0 : 2);
		`;
		const child = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "--eval", source, directory],
			{ timeout: 10_000 },
		);

		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
	});

	it("does not advance memory when the writer fence is lost", () => {
		const manager = SessionManager.create(directory, directory);
		manager.appendCustomEntry("before");
		const path = manager.getSessionFile()!;
		const original = readFileSync(path, "utf8");
		const entryCount = manager.getEntries().length;
		const leafId = manager.getLeafId();
		SessionLease.forceUnlock(path);

		expect(() => manager.branchWithSummary(null, "after")).toThrow("writer lease was lost");
		expect(manager.getEntries()).toHaveLength(entryCount);
		expect(manager.getLeafId()).toBe(leafId);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("repairs only an incomplete tail and appends a recovery notice", () => {
		const path = join(directory, "recovery.jsonl");
		const complete = `${JSON.stringify(header())}\n${JSON.stringify(entry("one", null))}\n`;
		writeFileSync(path, `${complete}{"partial"`);

		const manager = SessionManager.open(path);
		const notice = manager.getEntries().at(-1);
		expect(notice).toMatchObject({ type: "custom", customType: "arcmind.session_recovery", parentId: "one" });
		expect(readFileSync(path, "utf8")).not.toContain('{"partial"');
		expect(existsSync(join(directory, ".recovery"))).toBe(true);
		manager.close();
	});

	it("recovers a file containing only a partial header in one open", () => {
		const path = join(directory, "partial-header.jsonl");
		writeFileSync(path, '{"type":"session"');

		const manager = SessionManager.open(path);
		expect(manager.getHeader()).toMatchObject({ type: "session", version: CURRENT_SESSION_VERSION });
		expect(manager.getEntries()).toMatchObject([
			{ type: "custom", customType: "arcmind.session_recovery", parentId: null },
		]);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
		manager.close();
	});

	it("fills a recovery notice after a crash between tail repair and notice append", () => {
		const path = join(directory, "crash-window.jsonl");
		writeFileSync(path, `${JSON.stringify(header())}\n${JSON.stringify(entry("one", null))}\n{"partial"`);
		const journal = openSessionJournal(path);
		journal.readStrict();
		journal.close();

		const first = SessionManager.open(path);
		expect(
			first.getEntries().filter((item) => item.type === "custom" && item.customType === "arcmind.session_recovery"),
		).toHaveLength(1);
		first.close();

		const second = SessionManager.open(path);
		expect(
			second.getEntries().filter((item) => item.type === "custom" && item.customType === "arcmind.session_recovery"),
		).toHaveLength(1);
		second.close();
	});

	it("restores a graph-valid backup instead of promoting a graph-invalid replacement temp", () => {
		const path = join(directory, "session.jsonl");
		const transactionId = "11111111-1111-4111-8111-111111111111";
		const backupPath = join(directory, `.session.jsonl.${transactionId}.replace.bak`);
		const temporaryPath = join(directory, `.session.jsonl.${transactionId}.replace.tmp`);
		const good = `${[header({ id: "good" }), entry("one", null)].map((record) => JSON.stringify(record)).join("\n")}\n`;
		const invalid = `${[header({ id: "bad" }), entry("orphan", "missing")]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`;
		writeFileSync(backupPath, good);
		writeFileSync(temporaryPath, invalid);

		const manager = SessionManager.open(path);
		expect(manager.getHeader()?.id).toBe("good");
		expect(manager.getEntries()).toMatchObject([{ id: "one", parentId: null }]);
		manager.close();

		const restored = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(restored).toMatchObject([
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "good" },
			{ id: "one", parentId: null },
		]);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(temporaryPath)).toBe(false);
		const quarantine = readdirSync(directory).find((name) => name.endsWith(".invalid-replacement"));
		expect(quarantine).toBeDefined();
		expect(readFileSync(join(directory, quarantine!), "utf8")).toBe(invalid);
	});

	it.skipIf(process.platform === "win32")("does not follow asset-root symlinks created after open", () => {
		const path = join(directory, "session.jsonl");
		writeFileSync(path, `${JSON.stringify(header())}\n`);
		const manager = SessionManager.open(path);
		const outsideImages = join(directory, "outside-images");
		const outsideTools = join(directory, "outside-tools");
		mkdirSync(outsideImages);
		mkdirSync(outsideTools);
		symlinkSync(outsideImages, join(directory, "images"), "dir");
		symlinkSync(outsideTools, join(directory, "tool-results"), "dir");

		const data = Buffer.from("must stay inline").toString("base64");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		expect(readFileSync(path, "utf8")).toContain(data);
		expect(readdirSync(outsideImages)).toEqual([]);

		expect(() => manager.getToolOutputDir()).toThrow("not a real directory");
		expect(readdirSync(outsideTools)).toEqual([]);
		manager.close();
	});

	it.skipIf(process.platform === "win32")("does not follow session-specific asset-directory symlinks", () => {
		const path = join(directory, "session.jsonl");
		writeFileSync(path, `${JSON.stringify(header())}\n`);
		const manager = SessionManager.open(path);
		const imageDir = getSessionImageDir(path);
		const toolOutputDir = manager.getToolOutputDir()!;
		const outsideImages = join(directory, "outside-image-session");
		const outsideTools = join(directory, "outside-tool-session");
		mkdirSync(dirname(imageDir), { recursive: true });
		mkdirSync(dirname(toolOutputDir), { recursive: true });
		mkdirSync(outsideImages);
		mkdirSync(outsideTools);
		symlinkSync(outsideImages, imageDir, "dir");
		symlinkSync(outsideTools, toolOutputDir, "dir");

		const data = Buffer.from("must also stay inline").toString("base64");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		expect(readFileSync(path, "utf8")).toContain(data);
		expect(readdirSync(outsideImages)).toEqual([]);
		expect(() => manager.getToolOutputDir()).toThrow("asset directory is not a real directory");
		expect(readdirSync(outsideTools)).toEqual([]);
		manager.close();
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked pending recovery artifact", () => {
		const path = join(directory, "session.jsonl");
		writeFileSync(path, `${JSON.stringify(header())}\n`);
		const recoveryDirectory = join(directory, ".recovery");
		mkdirSync(recoveryDirectory);
		const outside = join(directory, "outside");
		writeFileSync(outside, "partial");
		symlinkSync(outside, join(recoveryDirectory, "session-1-attacker.partial"));

		expect(() => SessionManager.open(path)).toThrow("Unsafe session recovery artifact");
	});

	it.each([
		["duplicate id", [header(), entry("one", null), entry("one", null)], "duplicated"],
		["missing parent", [header(), entry("one", "missing")], "missing or forward parent"],
		["forward parent", [header(), entry("one", "two"), entry("two", null)], "missing or forward parent"],
		["self parent", [header(), entry("one", "one")], "own parent"],
		[
			"unknown label target",
			[header(), { type: "label", id: "label", parentId: null, timestamp, targetId: "missing", label: "x" }],
			"unknown target",
		],
	])("rejects a %s without changing the journal", (_name, records, message) => {
		const path = join(directory, "invalid.jsonl");
		const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		writeFileSync(path, original);

		expect(() => SessionManager.open(path)).toThrow(message as string);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("rejects a future session version without rewriting it", () => {
		const path = join(directory, "future.jsonl");
		const original = `${JSON.stringify(header({ version: 99 }))}\n`;
		writeFileSync(path, original);

		expect(() => SessionManager.open(path)).toThrow("newer than supported");
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("keeps a legacy journal unchanged when its migrated graph is invalid", () => {
		const path = join(directory, "invalid-legacy.jsonl");
		const records = [header({ version: 3 }), entry("orphan", "missing")];
		const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		writeFileSync(path, original);

		expect(() => SessionManager.open(path)).toThrow("missing or forward parent");
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(readdirSync(directory).some((name) => name.includes(".keep-v3."))).toBe(false);
	});

	it("keeps the current session usable when candidate acquisition fails", () => {
		const current = SessionManager.create(directory, directory);
		const occupied = SessionManager.create(directory, directory);
		const currentPath = current.getSessionFile();
		const currentId = current.getSessionId();

		expect(() => current.setSessionFile(occupied.getSessionFile()!)).toThrow("already in use");
		expect(current.getSessionFile()).toBe(currentPath);
		expect(current.getSessionId()).toBe(currentId);
		expect(() => current.appendCustomEntry("still-owned")).not.toThrow();

		current.close();
		occupied.close();
	});

	it("creates a branch candidate without reopening or replacing the source", () => {
		const source = SessionManager.create(directory, directory);
		const selected = source.appendCustomEntry("selected");
		const candidate = source.createBranchedSessionManager(selected);

		expect(candidate.getSessionFile()).not.toBe(source.getSessionFile());
		expect(candidate.getEntries().map((item) => item.id)).toEqual([selected]);
		expect(() => source.appendCustomEntry("source-still-owned")).not.toThrow();

		candidate.close();
		source.close();
	});

	it("imports over the same path without truncating and leaves no transient backup", () => {
		const source = SessionManager.create(directory, directory);
		source.appendCustomEntry("saved", { value: 1 });
		const path = source.getSessionFile()!;
		source.close();
		const before = statSync(path);

		const imported = SessionManager.importFrom(path, path);
		const after = statSync(path);
		expect(imported.getEntries()).toHaveLength(1);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(readdirSync(directory).some((name) => name.endsWith(".replace.bak"))).toBe(false);
		imported.close();
	});

	it("does not snapshot or replace a same-path import behind an active writer", () => {
		const writer = SessionManager.create(directory, directory);
		writer.appendCustomEntry("before");
		const path = writer.getSessionFile()!;
		const before = readFileSync(path, "utf8");

		expect(() => SessionManager.importFrom(path, path)).toThrow("already in use");
		expect(readFileSync(path, "utf8")).toBe(before);
		writer.appendCustomEntry("after");
		writer.close();

		const reopened = SessionManager.open(path);
		expect(reopened.getEntries()).toMatchObject([
			{ type: "custom", customType: "before" },
			{ type: "custom", customType: "after" },
		]);
		reopened.close();
	});

	it("never replaces a destination that appears before create-exclusive publication", () => {
		const source = SessionManager.create(directory, directory);
		source.appendMessage({
			role: "user",
			content: [{ type: "image", data: Buffer.from("source-image").toString("base64"), mimeType: "image/png" }],
			timestamp: Date.now(),
		});
		const sourcePath = source.getSessionFile()!;
		source.close();
		const destinationPath = join(directory, "appeared.jsonl");
		const destination = SessionManager.open(destinationPath, directory, directory);
		destination.appendCustomEntry("target-only");
		destination.close();
		const destinationBefore = readFileSync(destinationPath, "utf8");
		expect(existsSync(getSessionImageDir(destinationPath))).toBe(false);

		let failure: unknown;
		try {
			SessionManager.importFrom(sourcePath, destinationPath, undefined, {
				destinationMode: "create-exclusive",
			});
		} catch (error) {
			failure = error;
		}
		expect((failure as NodeJS.ErrnoException).code).toBe("EEXIST");
		expect(readFileSync(destinationPath, "utf8")).toBe(destinationBefore);
		expect(existsSync(getSessionImageDir(destinationPath))).toBe(false);
	});

	it("preserves a raw missing image reference during a same-path import", () => {
		const path = join(directory, "missing-image.jsonl");
		const hash = "a".repeat(64);
		const records = [
			header(),
			{
				type: "message",
				id: "image",
				parentId: null,
				timestamp,
				message: {
					role: "user",
					content: [{ type: "image_ref", hash, mimeType: "image/png" }],
					timestamp: 1,
				},
			},
		];
		writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

		const imported = SessionManager.importFrom(path, path);
		expect(readFileSync(path, "utf8")).toContain('"type":"image_ref"');
		const message = imported.buildSessionContext().messages[0];
		if (message.role !== "user") throw new Error("Expected user message");
		expect(message.content).toEqual([{ type: "text", text: `[Image unavailable: ${hash}]` }]);
		imported.close();
	});

	it("rejects a corrupt fork source before publishing a destination", () => {
		const source = join(directory, "source.jsonl");
		writeFileSync(source, `${JSON.stringify(header())}\nnot-json\n`);

		expect(() => SessionManager.forkFrom(source, directory, directory)).toThrow("Malformed complete journal record");
		expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual(["source.jsonl"]);
	});

	it("copies referenced images into fork and branch candidates", () => {
		const sourcePath = join(directory, "source.jsonl");
		const data = Buffer.from("strict-image").toString("base64");
		const source = SessionManager.open(sourcePath, directory, directory);
		const selected = source.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: Date.now(),
		});
		const fork = SessionManager.forkFrom(sourcePath, directory, directory, { id: "fork-valid" });
		const branch = source.createBranchedSessionManager(selected);

		for (const candidate of [fork, branch]) {
			const message = candidate.getEntry(selected);
			if (message?.type !== "message" || !("content" in message.message)) throw new Error("Expected image message");
			expect(message.message.content).toEqual([{ type: "image", data, mimeType: "image/png" }]);
			candidate.close();
		}
		source.close();
	});

	it("copies owned tool outputs into fork and branch candidates", async () => {
		const sourcePath = join(directory, "source.jsonl");
		const source = SessionManager.open(sourcePath, directory, directory);
		const sourceOutputDir = source.getToolOutputDir();
		if (!sourceOutputDir) throw new Error("Expected source tool output directory");
		mkdirSync(sourceOutputDir, { recursive: true });
		const sourceOutputPath = join(sourceOutputDir, "full-output.txt");
		writeFileSync(sourceOutputPath, "complete tool output");
		const toolEntryId = source.appendMessage(
			{
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: `preview\nFull output: ${sourceOutputPath}` }],
				details: { fullOutputPath: sourceOutputPath },
				isError: false,
				timestamp: Date.now(),
			},
			{ truncated: true, originalBytes: 20, previewBytes: 7, fullOutputPath: sourceOutputPath },
		);
		const selected = source.appendMessage({
			role: "bashExecution",
			command: "seq 3000",
			output: "preview",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: sourceOutputPath,
			timestamp: Date.now(),
		});

		const fork = SessionManager.forkFrom(sourcePath, directory, directory, { id: "fork-tool-output" });
		const branch = source.createBranchedSessionManager(selected);
		const candidatePaths: string[] = [];
		for (const candidate of [fork, branch]) {
			const entry = candidate.getEntry(toolEntryId);
			if (entry?.type !== "message" || !entry.toolOutput) throw new Error("Expected copied tool output");
			const copiedPath = entry.toolOutput.fullOutputPath;
			candidatePaths.push(copiedPath);
			expect(copiedPath).not.toBe(sourceOutputPath);
			expect(readFileSync(copiedPath, "utf8")).toBe("complete tool output");
			expect(entry.message.role === "toolResult" ? entry.message.details : undefined).toMatchObject({
				fullOutputPath: copiedPath,
			});
			expect(entry.message.role === "toolResult" ? entry.message.content[0] : undefined).toMatchObject({
				text: expect.stringContaining(copiedPath),
			});
			const bashEntry = candidate.getEntry(selected);
			expect(bashEntry?.type === "message" ? bashEntry.message : undefined).toMatchObject({
				role: "bashExecution",
				fullOutputPath: copiedPath,
			});
			expect(readdirSync(dirname(copiedPath))).toHaveLength(1);
			if (process.platform !== "win32") expect(statSync(copiedPath).mode & 0o777).toBe(0o600);
			candidate.close();
		}
		source.close();

		expect((await SessionManager.deleteSession(sourcePath)).ok).toBe(true);
		expect(existsSync(sourceOutputPath)).toBe(false);
		for (const path of candidatePaths) expect(readFileSync(path, "utf8")).toBe("complete tool output");
	});

	it.skipIf(process.platform === "win32")(
		"does not publish a fork or branch through a symlinked owned tool output",
		() => {
			const sourcePath = join(directory, "source.jsonl");
			const source = SessionManager.open(sourcePath, directory, directory);
			const sourceOutputDir = source.getToolOutputDir();
			if (!sourceOutputDir) throw new Error("Expected source tool output directory");
			mkdirSync(sourceOutputDir, { recursive: true });
			const sourceOutputPath = join(sourceOutputDir, "full-output.txt");
			writeFileSync(sourceOutputPath, "complete tool output");
			const selected = source.appendMessage(
				{
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read",
					content: [{ type: "text", text: `Full output: ${sourceOutputPath}` }],
					details: { fullOutputPath: sourceOutputPath },
					isError: false,
					timestamp: Date.now(),
				},
				{ truncated: true, originalBytes: 20, previewBytes: 7, fullOutputPath: sourceOutputPath },
			);
			source.close();
			const outside = join(directory, "outside-tool-output.txt");
			writeFileSync(outside, "outside");
			rmSync(sourceOutputPath);
			symlinkSync(outside, sourceOutputPath);

			expect(() => SessionManager.forkFrom(sourcePath, directory, directory, { id: "fork-tool-symlink" })).toThrow();
			const reopened = SessionManager.open(sourcePath, directory, directory);
			expect(() => reopened.createBranchedSessionManager(selected)).toThrow();
			reopened.close();
			expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual(["source.jsonl"]);
		},
	);

	it.each(["missing", "corrupt"] as const)(
		"does not publish a fork or branch with a %s referenced image",
		(failure) => {
			const sourcePath = join(directory, "source.jsonl");
			const source = SessionManager.open(sourcePath, directory, directory);
			const selected = source.appendMessage({
				role: "user",
				content: [{ type: "image", data: Buffer.from("strict-image").toString("base64"), mimeType: "image/png" }],
				timestamp: Date.now(),
			});
			source.close();
			const imageDir = getSessionImageDir(sourcePath);
			const imagePath = join(imageDir, readdirSync(imageDir)[0]!);
			if (failure === "missing") rmSync(imagePath);
			else writeFileSync(imagePath, "corrupt");

			expect(() => SessionManager.forkFrom(sourcePath, directory, directory, { id: `fork-${failure}` })).toThrow();
			const reopened = SessionManager.open(sourcePath, directory, directory);
			expect(() => reopened.createBranchedSessionManager(selected)).toThrow();
			reopened.close();
			expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual(["source.jsonl"]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not publish a fork or branch through a symlinked referenced image",
		() => {
			const sourcePath = join(directory, "source.jsonl");
			const source = SessionManager.open(sourcePath, directory, directory);
			const selected = source.appendMessage({
				role: "user",
				content: [{ type: "image", data: Buffer.from("strict-image").toString("base64"), mimeType: "image/png" }],
				timestamp: Date.now(),
			});
			source.close();
			const imageDir = getSessionImageDir(sourcePath);
			const imagePath = join(imageDir, readdirSync(imageDir)[0]!);
			const outside = join(directory, "outside-image.png");
			writeFileSync(outside, readFileSync(imagePath));
			rmSync(imagePath);
			symlinkSync(outside, imagePath);

			expect(() => SessionManager.forkFrom(sourcePath, directory, directory, { id: "fork-symlink" })).toThrow();
			const reopened = SessionManager.open(sourcePath, directory, directory);
			expect(() => reopened.createBranchedSessionManager(selected)).toThrow();
			reopened.close();
			expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual(["source.jsonl"]);
		},
	);
});
