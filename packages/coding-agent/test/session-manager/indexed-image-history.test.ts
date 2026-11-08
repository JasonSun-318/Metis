import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type ImageContent } from "@metis/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedSessionRecords } from "../../src/core/indexed-session-records.ts";
import { getSessionImageDir, SessionManager } from "../../src/core/session-manager.ts";

const image: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6r9sAAAAASUVORK5CYII=",
};
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(count = 600) {
	const root = mkdtempSync(join(tmpdir(), "metis-indexed-images-"));
	roots.push(root);
	const original = SessionManager.inMemory(root);
	const ids = Array.from({ length: count }, (_, index) =>
		original.appendMessage({
			role: "user",
			content: `${index}:中文${"x".repeat(4096)}`,
			timestamp: index,
		}),
	);
	if (count > 590)
		original.appendCompaction("summary", ids[590]!, 100_000, undefined, undefined, { version: 1, messages: [] });
	const path = join(root, "session.jsonl");
	writeFileSync(
		path,
		`${original
			.getDurableJournalSnapshot()
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`,
	);
	return { path, ids };
}

function appendImages(path: string) {
	const writer = SessionManager.open(path);
	try {
		const user = writer.appendMessage({ role: "user", content: [image], timestamp: 700 });
		writer.appendMessage({
			...fauxAssistantMessage("look"),
			content: [{ type: "toolCall", id: "image-call", name: "read", arguments: { path: "image.png" } }],
		});
		const tool = writer.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "image-call",
			content: [image],
			isError: false,
			timestamp: 701,
		});
		const custom = writer.appendCustomMessageEntry("test-image", [image], true);
		return { user, tool, custom };
	} finally {
		writer.close();
	}
}

function message(manager: SessionManager, id: string) {
	const entry = manager.getEntry(id);
	if (entry?.type !== "message" || !("content" in entry.message)) throw new Error("Expected message content");
	return entry.message;
}

describe("mixed indexed image history", () => {
	it("keeps ordinary bodies lazy while preserving native images, message identities and compacted context", () => {
		const { path, ids } = fixture();
		const images = appendImages(path);
		const eager = SessionManager.open(path);
		const expected = eager.buildSessionContext();
		const branch = eager.getBranch().map((entry) => entry.id);
		eager.close();
		const manager = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
		try {
			manager.releaseJournalReadCache();
			const reads = vi.spyOn(IndexedSessionRecords.prototype, "read");
			expect(Object.getOwnPropertyDescriptor(message(manager, ids[0]!), "content")?.get).toBeTypeOf("function");
			expect(manager.getBranch().map((entry) => entry.id)).toEqual(branch);
			expect(manager.getJournalMetadata().filter((entry) => entry.type === "message")).toHaveLength(603);
			expect(reads).not.toHaveBeenCalled();
			for (const id of [images.user, images.tool]) {
				const body = message(manager, id);
				expect(body.content).toEqual([image]);
				expect(manager.getMessageEntryId(body)).toBe(id);
			}
			expect(manager.getEntry(images.custom)).toMatchObject({ content: [image] });
			expect(manager.buildSessionContext()).toEqual(expected);
			expect(reads.mock.calls.length).toBeGreaterThan(0);
			expect(reads.mock.calls.every(([index]) => index >= 591)).toBe(true);
			reads.mockClear();
			expect(message(manager, ids[0]!).content).toContain("0:中文");
			expect(reads).toHaveBeenCalledTimes(1);
			manager.branch(images.user);
			expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({ role: "user", content: [image] });
		} finally {
			manager.close();
		}
	});

	it.each(["missing", "corrupt", "invalid reference"])(
		"preserves %s image markers without exposing raw references",
		(failure) => {
			const { path, ids } = fixture();
			const images = appendImages(path);
			const bytes = Buffer.from(image.data, "base64");
			const hash = createHash("sha256").update(bytes).digest("hex");
			const asset = join(getSessionImageDir(path), `${hash}.png`);
			if (failure === "missing") rmSync(asset);
			else if (failure === "corrupt") {
				bytes[0] ^= 1;
				writeFileSync(asset, bytes);
			} else {
				const records = readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				records.find((entry) => entry.id === images.user).message.content = [
					{ type: "image_ref", hash: "invalid", mimeType: "image/png" },
				];
				writeFileSync(path, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			}
			const eager = SessionManager.open(path);
			const expected = eager.buildSessionContext();
			eager.close();
			const manager = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
			try {
				manager.releaseJournalReadCache();
				expect(Object.getOwnPropertyDescriptor(message(manager, ids[0]!), "content")?.get).toBeTypeOf("function");
				expect(message(manager, images.user).content).toEqual([
					{ type: "text", text: expect.stringContaining("Image unavailable") },
				]);
				expect(manager.getMessageEntryId(message(manager, images.user))).toBe(images.user);
				expect(manager.buildSessionContext()).toEqual(expected);
				expect(JSON.stringify(expected)).not.toContain('"type":"image_ref"');
				const raw = manager
					.getDurableJournalSnapshot()
					.find((entry) => entry.type === "message" && entry.id === images.user);
				expect(raw).toMatchObject({ message: { content: [{ type: "image_ref" }] } });
			} finally {
				manager.close();
			}
		},
	);

	it.each([14, 15])("preserves inline images from version %i and repeated reopening", (version) => {
		const { path, ids } = fixture();
		const images = appendImages(path);
		const records = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		records[0].version = version;
		records.find((entry) => entry.id === images.user).message.content = [image];
		writeFileSync(path, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		for (let attempt = 0; attempt < 2; attempt++) {
			const manager = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
			try {
				manager.releaseJournalReadCache();
				expect(Object.getOwnPropertyDescriptor(message(manager, ids[0]!), "content")?.get).toBeTypeOf("function");
				expect(message(manager, images.user).content).toEqual([image]);
				expect(manager.getMessageEntryId(message(manager, images.user))).toBe(images.user);
				const id = manager.appendMessage({ role: "user", content: [image], timestamp: 800 + attempt });
				manager.releaseJournalReadCache();
				expect(message(manager, id).content).toEqual([image]);
				expect(manager.getMessageEntryId(message(manager, id))).toBe(id);
			} finally {
				manager.close();
			}
		}
	});

	it("keeps the chronological 64 MiB image budget across append, cache release and reopen", () => {
		const { path } = fixture(0);
		const bytes = Buffer.alloc(8 * 1024 * 1024, 7);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const imageDir = getSessionImageDir(path);
		mkdirSync(imageDir, { recursive: true });
		writeFileSync(join(imageDir, `${hash}.png`), bytes);
		const header = readFileSync(path, "utf8");
		const records = Array.from({ length: 8 }, (_, index) => ({
			type: "message",
			id: `budget-${index}`,
			parentId: index === 0 ? null : `budget-${index - 1}`,
			timestamp: new Date(index).toISOString(),
			message: {
				role: "user",
				content: [{ type: "image_ref", hash, mimeType: "image/png", size: bytes.length }],
				timestamp: index,
			},
		}));
		writeFileSync(path, `${header}${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		let appended: string | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			const manager = SessionManager.open(path, undefined, undefined, { indexedHistory: true });
			try {
				manager.releaseJournalReadCache();
				for (let index = 0; index < 8; index++)
					expect(message(manager, `budget-${index}`).content).toMatchObject([{ type: "image" }]);
				appended ??= manager.appendMessage({ role: "user", content: [image], timestamp: 800 });
				manager.releaseJournalReadCache();
				expect(message(manager, appended).content).toEqual([
					{ type: "text", text: expect.stringContaining("Image unavailable") },
				]);
				expect(manager.getMessageEntryId(message(manager, appended))).toBe(appended);
				expect(manager.getDurableJournalSnapshot().at(-1)).toMatchObject({
					message: { content: [{ type: "image_ref" }] },
				});
			} finally {
				manager.close();
			}
		}
	});
});
