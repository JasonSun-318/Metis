import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMemorySqlitePath } from "../src/core/auto-memory.ts";
import { clearMemoryHealth, getLatestMemoryError } from "../src/core/memory/memory-health.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";

describe("memory health boundary", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reads the latest error and clears only requested operations", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "metis-memory-health-"));
		dirs.push(agentDir);
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		store.recordHealth({
			operation: "embedding",
			status: "error",
			updatedAt: "2026-08-24T00:00:00.000Z",
			reason: "Embedding request failed",
		});
		store.recordHealth({
			operation: "rerank",
			status: "error",
			updatedAt: "2026-08-24T00:01:00.000Z",
			reason: "Rerank request failed",
		});
		store.close();

		expect(getLatestMemoryError(agentDir)).toBe("Rerank request failed");
		clearMemoryHealth(agentDir, "rerank");
		expect(getLatestMemoryError(agentDir)).toBe("Embedding request failed");
	});
});
