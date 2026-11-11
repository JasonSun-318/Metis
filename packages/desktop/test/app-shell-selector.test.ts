import type { SessionSummary } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import { selectSessionIndexKey } from "../src/renderer/app-shell-selector.ts";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		sessionId: "session-1",
		mode: "chat",
		cwdOrigin: "project",
		cwd: "/work",
		createdAt: 1,
		updatedAt: 1,
		state: "idle",
		archived: false,
		unread: false,
		useMemory: true,
		contributeMemory: true,
		...overrides,
	} as SessionSummary;
}

describe("selectSessionIndexKey", () => {
	it("changes when a session summary is updated in place", () => {
		const sessions = new Map<string, SessionSummary>([["session-1", summary()]]);
		const before = selectSessionIndexKey(sessions);
		sessions.set("session-1", summary({ mode: "code", cwd: "/elsewhere" }));
		expect(selectSessionIndexKey(sessions)).not.toBe(before);
	});

	it("changes when sessions are added or removed", () => {
		const sessions = new Map<string, SessionSummary>([["session-1", summary()]]);
		const before = selectSessionIndexKey(sessions);
		sessions.set("session-2", summary({ sessionId: "session-2" }));
		expect(selectSessionIndexKey(sessions)).not.toBe(before);
		sessions.delete("session-2");
		expect(selectSessionIndexKey(sessions)).toBe(before);
	});

	it("keeps the same key for unchanged summaries", () => {
		const first = selectSessionIndexKey(new Map([["session-1", summary()]]));
		const second = selectSessionIndexKey(new Map([["session-1", summary()]]));
		expect(second).toBe(first);
	});
});
