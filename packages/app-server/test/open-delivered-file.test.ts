import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageDeliveredFile } from "@metis/coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { openDeliveredFile } from "../src/open-delivered-file.ts";

describe("openDeliveredFile", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});

	it("opens a staged delivered file by id", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-open-deliver-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "report.txt"), "hello");
		const sessionId = "session-open-deliver";
		const staged = stageDeliveredFile({
			agentDir,
			sessionId,
			cwd,
			sourcePath: join(cwd, "report.txt"),
		});

		await expect(
			openDeliveredFile({
				agentDir,
				sessionId,
				fileId: staged.fileId,
				action: "default",
			}),
		).resolves.toBeUndefined();
	});

	it("throws when the delivered file id is unknown", async () => {
		await expect(
			openDeliveredFile({
				agentDir: join(tmpdir(), "missing-agent"),
				sessionId: "missing-session",
				fileId: "cccccccccccccccc",
				action: "default",
			}),
		).rejects.toThrow(/Delivered file was not found/iu);
	});
});
