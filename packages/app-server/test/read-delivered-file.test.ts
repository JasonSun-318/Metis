import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageDeliveredFile } from "@metis/coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { readDeliveredFile } from "../src/read-delivered-file.ts";

describe("readDeliveredFile", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});

	it("reads a staged delivered file by id and returns base64 data", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-read-deliver-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "report.pdf"), "%PDF-1.4 sample content");
		const sessionId = "session-read-deliver";
		const staged = stageDeliveredFile({
			agentDir,
			sessionId,
			cwd,
			sourcePath: join(cwd, "report.pdf"),
		});

		const result = await readDeliveredFile({
			agentDir,
			sessionId,
			fileId: staged.fileId,
		});

		expect(result.fileId).toBe(staged.fileId);
		expect(result.byteLength).toBe(staged.byteLength);
		expect(result.mediaType).toBe("application/pdf");
		expect(Buffer.from(result.data, "base64").toString("utf8")).toBe("%PDF-1.4 sample content");
	});

	it("throws when the delivered file id is unknown", async () => {
		await expect(
			readDeliveredFile({
				agentDir: join(tmpdir(), "missing-agent"),
				sessionId: "missing-session",
				fileId: "cccccccccccccccc",
			}),
		).rejects.toThrow(/Delivered file was not found/iu);
	});
});
