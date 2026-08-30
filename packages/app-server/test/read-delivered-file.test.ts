import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeliveredFile } from "../src/read-delivered-file.ts";

describe("readDeliveredFile", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});

	it("reads an authorized delivered artifact and preserves its journal name", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-read-deliver-"));
		roots.push(root);
		const path = join(root, "aaaaaaaaaaaaaaaa.pdf");
		writeFileSync(path, "%PDF-1.4 sample content");
		const artifact = {
			fileId: "aaaaaaaaaaaaaaaa",
			name: "Quarterly Report.pdf",
			byteLength: Buffer.byteLength("%PDF-1.4 sample content"),
			deliveredAt: "2026-08-30T00:00:00.000Z",
			availability: "available" as const,
		};

		const result = await readDeliveredFile({ artifact, path });

		expect(result.fileId).toBe(artifact.fileId);
		expect(result.name).toBe("Quarterly Report.pdf");
		expect(result.byteLength).toBe(artifact.byteLength);
		expect(result.mediaType).toBe("application/pdf");
		expect(Buffer.from(result.data, "base64").toString("utf8")).toBe("%PDF-1.4 sample content");
	});
});
