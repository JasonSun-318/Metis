import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_MAX_BYTES, readDeliveredPreviewBytes } from "../src/main/preview-file-reader.ts";
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
		const dir = mkdtempSync(join(tmpdir(), "metis-preview-"));
		roots.push(dir);
		const fileId = "bbbbbbbbbbbbbbbb";
		writeFileSync(join(dir, `${fileId}-note.pdf`), "%PDF-1.4 tiny");
		const ok = await readDeliveredPreviewBytes(dir, fileId);
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(Buffer.from(ok.bytes).toString("utf8")).toContain("%PDF-1.4");
			expect(ok.name).toBe(`${fileId}-note.pdf`);
			expect(ok.mediaType).toBe("application/pdf");
		}

		const hugeId = "cccccccccccccccc";
		writeFileSync(join(dir, `${hugeId}-huge.pdf`), Buffer.alloc(PREVIEW_MAX_BYTES + 1));
		const tooBig = await readDeliveredPreviewBytes(dir, hugeId);
		expect(tooBig).toEqual({ ok: false, reason: "too-large" });
	});
});
