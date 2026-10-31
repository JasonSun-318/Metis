import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDeliveredFile } from "../src/read-delivered-file.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

describe("readDeliveredFile", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});

	it("rejects oversized artifacts before opening or reading their contents", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-read-deliver-"));
		roots.push(root);
		const path = join(root, "large.pdf");
		writeFileSync(path, "");
		const byteLength = 7 * 1024 * 1024;
		truncateSync(path, byteLength);
		vi.mocked(fs.open).mockClear();
		vi.mocked(fs.readFile).mockClear();
		await expect(
			readDeliveredFile({
				path,
				artifact: {
					fileId: "aaaaaaaaaaaaaaaa",
					name: "large.pdf",
					byteLength,
					deliveredAt: "2026-08-30T00:00:00.000Z",
					availability: "available",
				},
			}),
		).rejects.toThrow("too large");
		expect(fs.open).not.toHaveBeenCalled();
		expect(fs.readFile).not.toHaveBeenCalled();
		await expect(
			readDeliveredFile(
				{
					path,
					artifact: {
						fileId: "aaaaaaaaaaaaaaaa",
						name: "large.pdf",
						byteLength,
						deliveredAt: "2026-08-30T00:00:00.000Z",
						availability: "available",
					},
				},
				true,
			),
		).resolves.toEqual({ fileId: "aaaaaaaaaaaaaaaa", name: "large.pdf", byteLength, absolutePath: path, data: "" });
		expect(fs.open).not.toHaveBeenCalled();
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
