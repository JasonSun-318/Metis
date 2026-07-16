import { createHash } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DurableImageRef,
	MAX_DURABLE_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGES,
	parseDurablePromptSubmission,
} from "../../src/core/runtime-recovery.ts";
import { getSessionImageDir } from "../../src/core/session-manager.ts";
import { identifySubmitPromptRequest, type RuntimeControlPayload, SessionManager } from "../../src/index.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function header(id: string, version = 5) {
	return { type: "session", version, id, timestamp, cwd: "/tmp" };
}

function writeRecords(path: string, records: readonly unknown[]): void {
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function caughtError(operation: () => unknown): Error {
	try {
		operation();
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected operation to throw");
}

function acceptedTurn(requestId: string, text = "hello"): RuntimeControlPayload {
	const input = { text };
	const identity = identifySubmitPromptRequest(requestId, input);
	return {
		type: "runtime_operation",
		operationId: identity.operationId,
		requestId,
		requestHash: identity.requestHash,
		kind: "turn",
		state: "accepted",
		turnId: identity.turnId,
		input,
	};
}

describe("SessionManager v5 runtime journal", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arcmind-runtime-journal-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("keeps raw runtime records out of the hydrated transcript and tree", () => {
		const manager = SessionManager.create(directory, directory, { id: "runtime-view" });
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 }, undefined, "turn-1");
		const input = {
			text: "raw image",
			images: [{ type: "image_ref" as const, hash: "a".repeat(64), mimeType: "image/png", size: 1 }],
		};
		const identity = identifySubmitPromptRequest("request-with-image", input);
		const runtimeId = manager.appendRuntimeControl({
			type: "runtime_operation",
			operationId: identity.operationId,
			requestId: identity.requestId,
			requestHash: identity.requestHash,
			kind: "turn",
			state: "accepted",
			turnId: identity.turnId,
			input,
		});
		const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });

		expect(manager.getHeader()?.version).toBe(5);
		expect(manager.getLeafId()).toBe(secondId);
		expect(manager.getEntries().map((entry) => entry.id)).toEqual([firstId, secondId]);
		expect(manager.getEntry(runtimeId)).toBeUndefined();
		expect(manager.getChildren(runtimeId)).toEqual([]);
		expect(
			manager.getTree().flatMap((root) => [root.entry.id, ...root.children.map((child) => child.entry.id)]),
		).toEqual([firstId, secondId]);
		expect(manager.getEntry(secondId)?.parentId).toBe(firstId);
		expect(manager.getEntry(firstId)).toMatchObject({ type: "message", turnId: "turn-1" });
		expect(
			(manager as unknown as { fileEntries: Array<{ type: string }> }).fileEntries.some((entry) =>
				entry.type.startsWith("runtime_"),
			),
		).toBe(false);
		expect(manager.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: "first" },
			{ role: "user", content: "second" },
		]);

		const snapshot = manager.getDurableJournalSnapshot();
		const expectedSnapshot = structuredClone(snapshot);
		const runtime = snapshot.find((entry) => entry.type === "runtime_operation");
		expect(runtime).toMatchObject({ id: runtimeId, parentId: firstId, input: { images: input.images } });
		if (runtime?.type !== "runtime_operation" || !runtime.input?.images) throw new Error("Expected runtime input");
		const runtimeImage = runtime.input.images[0];
		if (!runtimeImage) throw new Error("Expected runtime image");
		expect(() => {
			(runtimeImage as unknown as { hash: string }).hash = "b".repeat(64);
		}).toThrow(TypeError);
		expect(manager.getDurableJournalSnapshot().find((entry) => entry.type === "runtime_operation")).toMatchObject({
			input: { images: input.images },
		});

		const path = manager.getSessionFile()!;
		manager.close();
		const reopened = SessionManager.open(path, directory);
		try {
			expect(reopened.getEntries().map((entry) => entry.id)).toEqual([firstId, secondId]);
			expect(reopened.getEntry(firstId)).toMatchObject({ turnId: "turn-1" });
			expect(
				(reopened as unknown as { fileEntries: Array<{ type: string }> }).fileEntries.some((entry) =>
					entry.type.startsWith("runtime_"),
				),
			).toBe(false);
			expect(reopened.getDurableJournalSnapshot()).toEqual(expectedSnapshot);
			expect(readFileSync(path, "utf8").split("\n")[0]).toContain('"version":5');
		} finally {
			reopened.close();
		}
	});

	it("tracks the single externalized tree record that was appended", () => {
		const manager = SessionManager.create(directory, directory, { id: "raw-tree" });
		const bytes = Buffer.from("raw snapshot image");
		const data = bytes.toString("base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const id = manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});

		const rawEntry = manager.getDurableJournalSnapshot().find((entry) => entry.type === "message");
		expect(rawEntry).toMatchObject({
			id,
			message: { content: [{ type: "image_ref", hash, mimeType: "image/png", size: bytes.length }] },
		});
		expect(manager.getEntry(id)).toMatchObject({
			message: { content: [{ type: "image", data, mimeType: "image/png" }] },
		});
		const persisted = readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(persisted[1]).toEqual(rawEntry);
		manager.close();
	});

	it("bounds legacy image hydration and strict copying before reading the blob", () => {
		const path = join(directory, "legacy-large-image.jsonl");
		const hash = "a".repeat(64);
		writeRecords(path, [
			header("legacy-large-image"),
			{
				type: "message",
				id: "legacy-message",
				parentId: null,
				timestamp,
				message: {
					role: "user",
					content: [{ type: "image_ref", hash, mimeType: "image/png" }],
					timestamp: 1,
				},
			},
		]);
		const imageDir = getSessionImageDir(path);
		mkdirSync(imageDir, { recursive: true });
		const assetPath = join(imageDir, `${hash}.png`);
		writeFileSync(assetPath, "");
		truncateSync(assetPath, 64 * 1024 * 1024 + 1);

		const readonly = SessionManager.openReadOnly(path);
		expect(readonly.getEntry("legacy-message")).toMatchObject({
			message: { content: [{ type: "text", text: `[Image unavailable: ${hash}]` }] },
		});
		expect(() => SessionManager.forkFrom(path, directory, directory, { id: "bounded-copy" })).toThrow("read limit");
		expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual(["legacy-large-image.jsonl"]);
	});

	it("replaces a malformed legacy image ref instead of exposing it to context", () => {
		const path = join(directory, "malformed-image-ref.jsonl");
		writeRecords(path, [
			header("malformed-image-ref"),
			{
				type: "message",
				id: "malformed-message",
				parentId: null,
				timestamp,
				message: {
					role: "user",
					content: [{ type: "image_ref", hash: "a".repeat(64), mimeType: "image/png", size: 0 }],
					timestamp: 1,
				},
			},
		]);

		const readonly = SessionManager.openReadOnly(path);
		expect(readonly.getEntry("malformed-message")).toMatchObject({
			message: { content: [{ type: "text", text: "[Image unavailable: invalid image reference]" }] },
		});
	});

	it.skipIf(process.platform === "win32")("rejects a hard-linked durable image asset", () => {
		const manager = SessionManager.create(directory, directory, { id: "resolve-hardlink" });
		const bytes = Buffer.from("hard-linked durable image");
		const data = bytes.toString("base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		const assetPath = join(getSessionImageDir(manager.getSessionFile()!), `${hash}.png`);
		linkSync(assetPath, join(directory, "outside-hardlink"));

		expect(() =>
			manager.resolveDurableImageRefs([{ type: "image_ref", hash, mimeType: "image/png", size: bytes.length }]),
		).toThrow(`Durable image asset is unavailable or unsafe: ${hash}`);
		manager.close();
	});

	it("enforces matching durable prompt limits in the parser and image resolver without leaking paths", () => {
		const manager = SessionManager.create(directory, directory, { id: "resolve-image-limits" });
		const countRefs: DurableImageRef[] = Array.from({ length: MAX_DURABLE_PROMPT_IMAGES + 1 }, () => ({
			type: "image_ref",
			hash: "a".repeat(64),
			mimeType: "image/png",
			size: 1,
		}));
		const totalRefs: DurableImageRef[] = Array.from(
			{ length: Math.floor(MAX_DURABLE_PROMPT_IMAGE_BYTES / MAX_DURABLE_IMAGE_BYTES) + 1 },
			(_, index) => ({
				type: "image_ref",
				hash: index.toString(16).padStart(64, "0"),
				mimeType: "image/png",
				size: MAX_DURABLE_IMAGE_BYTES,
			}),
		);
		const cases: Array<{
			name: string;
			refs: DurableImageRef[];
			parserMessage: string;
			resolverMessage: string;
		}> = [
			{
				name: "count",
				refs: countRefs,
				parserMessage: `${MAX_DURABLE_PROMPT_IMAGES} image references`,
				resolverMessage: `at most ${MAX_DURABLE_PROMPT_IMAGES} images`,
			},
			{
				name: "per-file",
				refs: [
					{
						type: "image_ref",
						hash: "b".repeat(64),
						mimeType: "image/png",
						size: MAX_DURABLE_IMAGE_BYTES + 1,
					},
				],
				parserMessage: `${MAX_DURABLE_IMAGE_BYTES} bytes`,
				resolverMessage: "Invalid durable image reference",
			},
			{
				name: "total",
				refs: totalRefs,
				parserMessage: `${MAX_DURABLE_PROMPT_IMAGE_BYTES} total bytes`,
				resolverMessage: `${MAX_DURABLE_PROMPT_IMAGE_BYTES} total bytes`,
			},
		];
		const sessionPath = manager.getSessionFile()!;
		const imageDir = getSessionImageDir(sessionPath);

		for (const testCase of cases) {
			const parserError = caughtError(() =>
				parseDurablePromptSubmission({
					requestId: `request-${testCase.name}`,
					text: "hello",
					images: testCase.refs,
				}),
			);
			const resolverError = caughtError(() => manager.resolveDurableImageRefs(testCase.refs));
			expect(parserError.message, testCase.name).toContain(testCase.parserMessage);
			expect(resolverError.message, testCase.name).toContain(testCase.resolverMessage);
			for (const error of [parserError, resolverError]) {
				expect(error.message, testCase.name).not.toContain(sessionPath);
				expect(error.message, testCase.name).not.toContain(imageDir);
			}
		}
		manager.close();
	});

	it("strictly resolves valid durable images and rejects missing or corrupt assets", () => {
		const manager = SessionManager.create(directory, directory, { id: "resolve-images" });
		const bytes = Buffer.from("strict durable image");
		const data = bytes.toString("base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		const ref = { type: "image_ref" as const, hash, mimeType: "image/png", size: bytes.length };
		const assetPath = join(getSessionImageDir(manager.getSessionFile()!), `${hash}.png`);

		expect(manager.resolveDurableImageRefs([ref])).toEqual([{ type: "image", data, mimeType: "image/png" }]);
		expect(() => manager.resolveDurableImageRefs([{ ...ref, size: ref.size + 1 }])).toThrow(
			`Durable image asset is unavailable or unsafe: ${hash}`,
		);
		writeFileSync(assetPath, Buffer.alloc(bytes.length, 0x78));
		expect(() => manager.resolveDurableImageRefs([ref])).toThrow("hash mismatch");
		unlinkSync(assetPath);
		let missingError: unknown;
		try {
			manager.resolveDurableImageRefs([ref]);
		} catch (error) {
			missingError = error;
		}
		expect(missingError).toBeInstanceOf(Error);
		expect((missingError as Error).message).toBe(`Durable image asset is unavailable or unsafe: ${hash}`);
		expect((missingError as Error).message).not.toContain(assetPath);
		manager.close();
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked durable image asset", () => {
		const manager = SessionManager.create(directory, directory, { id: "resolve-symlink" });
		const bytes = Buffer.from("symlink durable image");
		const data = bytes.toString("base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		const assetPath = join(getSessionImageDir(manager.getSessionFile()!), `${hash}.png`);
		const outside = join(directory, "outside-image");
		unlinkSync(assetPath);
		writeFileSync(outside, bytes);
		symlinkSync(outside, assetPath);

		expect(() =>
			manager.resolveDurableImageRefs([{ type: "image_ref", hash, mimeType: "image/png", size: bytes.length }]),
		).toThrow(`Durable image asset is unavailable or unsafe: ${hash}`);
		manager.close();
	});

	it("migrates v4 with the existing COW backup and keeps read-only migration in memory", () => {
		const writablePath = join(directory, "writable.jsonl");
		const readonlyPath = join(directory, "readonly.jsonl");
		const records = [
			header("legacy", 4),
			{ type: "custom", customType: "legacy", id: "entry", parentId: null, timestamp },
		];
		writeRecords(writablePath, records);
		writeRecords(readonlyPath, records);

		const migrated = SessionManager.open(writablePath, directory);
		expect(migrated.getHeader()?.version).toBe(5);
		migrated.close();
		expect(readFileSync(writablePath, "utf8").split("\n")[0]).toContain('"version":5');
		const backup = readdirSync(directory).find((name) => name.includes(".writable.jsonl.keep-v4."));
		expect(backup).toMatch(/\.replace\.bak$/);
		expect(readFileSync(join(directory, backup!), "utf8").split("\n")[0]).toContain('"version":4');

		const readonly = SessionManager.openReadOnly(readonlyPath);
		expect(readonly.getHeader()?.version).toBe(5);
		expect(readFileSync(readonlyPath, "utf8").split("\n")[0]).toContain('"version":4');
		expect(readdirSync(directory).some((name) => name.includes(".readonly.jsonl.keep-v4."))).toBe(false);
	});

	it("rejects malformed, unknown, pre-v5, and invalidly anchored runtime records", () => {
		const valid = acceptedTurn("request-1") as Extract<RuntimeControlPayload, { type: "runtime_operation" }>;
		const runtime = { ...valid, id: "runtime", parentId: null, timestamp };
		const cases: Array<[string, unknown[], string]> = [
			[
				"malformed",
				[header("malformed"), { ...runtime, requestHash: "not-a-hash" }],
				"Invalid runtime control entry",
			],
			[
				"unknown",
				[header("unknown"), { type: "runtime_future", id: "future", parentId: null, timestamp }],
				"Unknown runtime control entry type",
			],
			["pre-v5", [header("pre-v5", 4), runtime], "require a v5 session header"],
			[
				"runtime-parent",
				[header("runtime-parent"), runtime, { ...runtime, id: "runtime-2", parentId: "runtime" }],
				"non-tree parent",
			],
			[
				"tree-parent",
				[
					header("tree-parent"),
					runtime,
					{ type: "custom", customType: "bad", id: "tree", parentId: "runtime", timestamp },
				],
				"missing or forward parent",
			],
			[
				"label-target",
				[
					header("label-target"),
					runtime,
					{ type: "label", id: "label", parentId: null, targetId: "runtime", label: "bad", timestamp },
				],
				"references an unknown target",
			],
			[
				"cross-kind-duplicate",
				[
					header("cross-kind-duplicate"),
					runtime,
					{ type: "custom", customType: "duplicate", id: "runtime", parentId: null, timestamp },
				],
				"id is duplicated",
			],
		];

		for (const [name, records, message] of cases) {
			const path = join(directory, `${name}.jsonl`);
			writeRecords(path, records);
			const original = readFileSync(path, "utf8");
			expect(() => SessionManager.open(path, directory), name).toThrow(message);
			expect(readFileSync(path, "utf8"), name).toBe(original);
		}
	});

	it("omits runtime controls from branches and forks while exact import preserves them", () => {
		const source = SessionManager.create(directory, directory, { id: "source" });
		const first = source.appendMessage({ role: "user", content: "first", timestamp: 1 });
		source.appendRuntimeControl(acceptedTurn("request-copy"));
		const second = source.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const sourcePath = source.getSessionFile()!;

		const branch = source.createBranchedSessionManager(second);
		const fork = SessionManager.forkFrom(sourcePath, directory, directory, { id: "fork" });
		const imported = SessionManager.importFrom(sourcePath, join(directory, "imported.jsonl"));
		try {
			for (const copy of [branch, fork]) {
				expect(copy.getEntries().map((entry) => entry.id)).toEqual([first, second]);
				expect(copy.getDurableJournalSnapshot().some((entry) => entry.type.startsWith("runtime_"))).toBe(false);
			}
			expect(imported.getDurableJournalSnapshot().some((entry) => entry.type === "runtime_operation")).toBe(true);
		} finally {
			branch.close();
			fork.close();
			imported.close();
			source.close();
		}
	});

	it("does not mutate memory when a runtime append fails", () => {
		const manager = SessionManager.create(directory, directory, { id: "append-failure" });
		manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		const beforeSnapshot = manager.getDurableJournalSnapshot();
		const beforeEntries = manager.getEntries();
		const beforeLeaf = manager.getLeafId();
		const journal = (manager as unknown as { journal: { append(record: unknown): void } }).journal;
		const append = journal.append.bind(journal);
		journal.append = () => {
			throw new Error("injected append failure");
		};

		expect(() => manager.appendRuntimeControl(acceptedTurn("request-failure"))).toThrow("injected append failure");
		expect(manager.getDurableJournalSnapshot()).toEqual(beforeSnapshot);
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(manager.getLeafId()).toBe(beforeLeaf);

		journal.append = append;
		manager.close();
	});
});
