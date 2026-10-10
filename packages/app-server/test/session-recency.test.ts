import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultSessionDir, SessionManager } from "@metis/coding-agent/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSessionActivityEntry, SessionCatalog } from "../src/session-catalog.ts";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";

describe("session recency", () => {
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `metis-session-recency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(agentDir, "project");
		mkdirSync(projectDir, { recursive: true });
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	it("ignores settings bookkeeping written after the last conversation activity", async () => {
		vi.setSystemTime(new Date("2026-10-01T08:00:00.000Z"));
		const manager = SessionManager.create(projectDir, getDefaultSessionDir(projectDir, agentDir), {
			id: SESSION_ID,
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		vi.setSystemTime(new Date("2026-10-01T09:00:00.000Z"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		// Opening an older session backfills its thinking level; renaming and linking write entries too.
		vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
		manager.appendThinkingLevelChange("high");
		manager.appendSessionInfo("Renamed");
		manager.appendCustomEntry("metis.knowledge.links.v1", { libraries: [] });
		manager.close();

		const catalog = new SessionCatalog({ agentDir, sessionsRoot: join(agentDir, "sessions") });
		await catalog.refresh();
		expect(catalog.get(SESSION_ID).summary.updatedAt).toBe("2026-10-01T09:00:00.000Z");
	});

	it("treats conversation entries as activity and settings entries as bookkeeping", () => {
		for (const type of ["message", "custom_message", "compaction", "branch_summary", "runtime_turn", "session"]) {
			expect(isSessionActivityEntry({ type })).toBe(true);
		}
		for (const type of ["thinking_level_change", "model_change", "session_info", "label", "custom"]) {
			expect(isSessionActivityEntry({ type })).toBe(false);
		}
		expect(isSessionActivityEntry(null)).toBe(false);
	});
});
