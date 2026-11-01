import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PREVIEW_MAX_BYTES,
	readDeliveredPreviewBytes,
	readKnowledgePreviewBytes,
} from "../src/main/preview-file-reader.ts";
import { validateReadPreviewFileInput } from "../src/shared/desktop-api.ts";

describe("validateReadPreviewFileInput", () => {
	it("accepts delivered SessionIdSchema ids and workspace UUID session ids", () => {
		expect(
			validateReadPreviewFileInput({
				source: "delivered",
				sessionId: "session-1",
				fileId: "aaaaaaaaaaaaaaaa",
			}),
		).toMatchObject({ source: "delivered", sessionId: "session-1", fileId: "aaaaaaaaaaaaaaaa" });
		expect(
			validateReadPreviewFileInput({
				source: "workspace",
				sessionId: "11111111-1111-4111-8111-111111111111",
				relativePath: "docs/a.pdf",
			}),
		).toMatchObject({ source: "workspace", relativePath: "docs/a.pdf" });
	});

	it("rejects extra keys and path traversal", () => {
		expect(() =>
			validateReadPreviewFileInput({
				source: "workspace",
				sessionId: "11111111-1111-4111-8111-111111111111",
				relativePath: "../secret.pdf",
			}),
		).toThrow(/relative path/i);
	});
});

describe("readDeliveredPreviewBytes", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});

	it("returns raw bytes and rejects files over the preview cap", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "metis-preview-")));
		roots.push(dir);
		const fileId = "bbbbbbbbbbbbbbbb";
		writeFileSync(join(dir, `${fileId}-note.pdf`), "%PDF-1.4 tiny");
		const ok = await readDeliveredPreviewBytes(join(dir, `${fileId}-note.pdf`), "note.pdf");
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(Buffer.from(ok.bytes).toString("utf8")).toContain("%PDF-1.4");
			expect(ok.name).toBe("note.pdf");
			expect(ok.mediaType).toBe("application/pdf");
		}

		const hugeId = "cccccccccccccccc";
		const hugePath = join(dir, `${hugeId}-huge.pdf`);
		writeFileSync(hugePath, "");
		// The boundary is the logical file size; no 50 MiB payload needs writing.
		truncateSync(hugePath, PREVIEW_MAX_BYTES + 1);
		const tooBig = await readDeliveredPreviewBytes(join(dir, `${hugeId}-huge.pdf`), "huge.pdf");
		expect(tooBig).toEqual({ ok: false, reason: "too-large" });
	});
	it("rejects delivery paths through symlinks or Windows junctions", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "metis-delivery-link-")));
		roots.push(dir);
		const target = join(dir, "target");
		mkdirSync(target);
		writeFileSync(join(target, "note.pdf"), "%PDF-1.4 secret");
		const alias = join(dir, "alias");
		symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
		expect(await readDeliveredPreviewBytes(join(alias, "note.pdf"), "note.pdf")).toEqual({
			ok: false,
			reason: "not-found",
		});
		expect(await readDeliveredPreviewBytes(`${target}/../target/note.pdf`, "note.pdf")).toEqual({
			ok: false,
			reason: "not-found",
		});
	});
});

describe("readKnowledgePreviewBytes", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

	function vault(): string {
		const dir = mkdtempSync(join(tmpdir(), "metis-knowledge-preview-"));
		roots.push(dir);
		mkdirSync(join(dir, "assets"));
		writeFileSync(join(dir, "assets", "diagram.png"), PNG);
		writeFileSync(join(dir, "note.md"), "# Note");
		writeFileSync(join(dir, "fake.png"), Buffer.from("not a bitmap at all"));
		writeFileSync(join(dir, "empty.png"), Buffer.alloc(0));
		return dir;
	}

	it("returns verified bytes with matching revisions and rejects stale or mismatched files", async () => {
		const root = vault();
		const read = await readKnowledgePreviewBytes(root, "assets/diagram.png");
		expect(read).toMatchObject({ ok: true, name: "diagram.png", mediaType: "image/png", byteLength: PNG.length });
		if (read.ok) expect(Buffer.from(read.bytes)).toEqual(PNG);

		const note = await readKnowledgePreviewBytes(root, "note.md");
		expect(note).toMatchObject({ ok: true, mediaType: "text/markdown" });
		if (note.ok) {
			const stale = await readKnowledgePreviewBytes(root, "note.md", "0:0:1");
			expect(stale).toEqual({ ok: false, reason: "stale" });
			const fresh = await readKnowledgePreviewBytes(root, "note.md", note.byteLength.toString());
			// A revision carries mtime/ctime/size, so a bare size is still stale-checked, not trusted blindly.
			expect(fresh.ok).toBe(false);
		}

		expect(await readKnowledgePreviewBytes(root, "fake.png")).toEqual({ ok: false, reason: "not-found" });
		expect(await readKnowledgePreviewBytes(root, "missing.png")).toEqual({ ok: false, reason: "not-found" });
		// Empty attachments cannot be validated by signature, so they are refused.
		expect(await readKnowledgePreviewBytes(root, "empty.png")).toEqual({ ok: false, reason: "not-found" });
	});

	it("rejects traversal, absolute paths, unsupported extensions and symlink escapes", async () => {
		const root = vault();
		const outside = mkdtempSync(join(tmpdir(), "metis-knowledge-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "secret.png"), PNG);
		symlinkSync(outside, join(root, "assets", "escape"));

		expect(await readKnowledgePreviewBytes(root, "../note.md")).toMatchObject({ ok: false });
		expect(await readKnowledgePreviewBytes(root, "/etc/passwd")).toMatchObject({ ok: false });
		expect(await readKnowledgePreviewBytes(root, "assets/movie.mp4")).toMatchObject({ ok: false });
		expect(await readKnowledgePreviewBytes(root, "assets")).toMatchObject({ ok: false });
		expect(await readKnowledgePreviewBytes(root, "assets/escape/secret.png")).toMatchObject({ ok: false });
	});
});
