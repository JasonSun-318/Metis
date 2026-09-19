import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptCacheCheckpoint } from "@metis/ai";
import { fauxAssistantMessage } from "@metis/ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const checkpoint: PromptCacheCheckpoint = {
	version: 1,
	provider: "p",
	model: "m",
	settingsDigest: "s",
	historyBoundary: { originId: "entry:u", ordinal: 0, prefixDigest: "h" },
};

describe("SessionManager cache checkpoint", () => {
	it("persists the cache checkpoint with the assistant entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-cache-checkpoint-"));
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(dir, dir);
			const id = manager.appendMessage(fauxAssistantMessage("answer"), undefined, undefined, checkpoint);
			const file = manager.getSessionFile()!;
			manager.close();
			manager = SessionManager.open(file);
			expect(manager.getEntry(id)).toMatchObject({ cacheCheckpoint: checkpoint });
			expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("settingsDigest");
		} finally {
			manager?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not offer a future checkpoint after branching before it", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-cache-checkpoint-"));
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(dir, dir);
			const parentId = manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
			manager.appendMessage(fauxAssistantMessage("answer"), undefined, undefined, checkpoint);
			expect(manager.getBranch().some((entry) => entry.type === "message" && entry.cacheCheckpoint)).toBe(true);

			manager.branch(parentId);
			expect(manager.getBranch().some((entry) => entry.type === "message" && entry.cacheCheckpoint)).toBe(false);

			// A checkpoint recorded on the new branch is the one that must be used.
			const next = manager.appendMessage(fauxAssistantMessage("next"), undefined, undefined, {
				...checkpoint,
				settingsDigest: "s2",
			});
			expect(manager.getEntry(next)).toMatchObject({ cacheCheckpoint: { settingsDigest: "s2" } });
		} finally {
			manager?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not half-commit a message when the journal append fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-cache-checkpoint-"));
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(dir, dir);
			const file = manager.getSessionFile()!;
			const leafBefore = manager.getBranch().at(-1)?.id;
			chmodSync(file, 0o444);
			expect(() =>
				manager!.appendMessage(fauxAssistantMessage("answer"), undefined, undefined, checkpoint),
			).toThrow();
			expect(manager.getBranch().at(-1)?.id).toBe(leafBefore);
			expect(manager.getEntries().some((entry) => entry.type === "message" && entry.cacheCheckpoint)).toBe(false);
		} finally {
			if (manager?.getSessionFile()) chmodSync(manager.getSessionFile()!, 0o644);
			manager?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
