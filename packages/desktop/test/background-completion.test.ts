import type { SessionSummary } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundCompletionTracker } from "../src/main/background-completion.ts";

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		sessionId: "session-1",
		name: "检查登录流程",
		mode: "code",
		cwdOrigin: "user-selected",
		cwd: "/tmp/project",
		createdAt: "2026-08-14T00:00:00.000Z",
		updatedAt: "2026-08-14T00:00:01.000Z",
		state: "running",
		archived: false,
		unread: false,
		useMemory: true,
		contributeMemory: true,
		...overrides,
	};
}

describe("background completion tracker", () => {
	it("counts each completed session once and removes only the viewed session", () => {
		const setBadgeCount = vi.fn();
		const notify = vi.fn();
		const tracker = createBackgroundCompletionTracker({ isActive: () => false, setBadgeCount, notify });

		tracker.update(session());
		tracker.update(session({ state: "idle", unread: true, lastTurnOutcome: "completed" }));
		tracker.update(session({ state: "idle", unread: true, lastTurnOutcome: "completed" }));
		tracker.update(session({ sessionId: "session-2" }));
		tracker.update(
			session({ sessionId: "session-2", state: "interrupted", unread: true, lastTurnOutcome: "failed" }),
		);

		expect(setBadgeCount.mock.calls).toEqual([[1], [2]]);
		expect(notify).toHaveBeenCalledTimes(2);
		tracker.view("session-1");
		expect(setBadgeCount).toHaveBeenLastCalledWith(1);
		tracker.view("session-2");
		expect(setBadgeCount).toHaveBeenLastCalledWith(0);
	});

	it("does not notify for foreground, restored unread, or a user interruption", () => {
		let active = false;
		const setBadgeCount = vi.fn();
		const notify = vi.fn();
		const tracker = createBackgroundCompletionTracker({ isActive: () => active, setBadgeCount, notify });

		tracker.update(session({ state: "idle", unread: true, lastTurnOutcome: "completed" }));
		tracker.update(session());
		active = true;
		tracker.update(session({ state: "idle", unread: true, lastTurnOutcome: "completed" }));
		active = false;
		tracker.update(session());
		tracker.setUserInterruptPending("session-1", true);
		tracker.update(session({ state: "interrupted", unread: true, lastTurnOutcome: "failed" }));

		expect(setBadgeCount).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("removes unseen completions when their session or project is deleted", () => {
		const setBadgeCount = vi.fn();
		const tracker = createBackgroundCompletionTracker({ isActive: () => false, setBadgeCount, notify: vi.fn() });

		tracker.update(session());
		tracker.update(session({ state: "idle", unread: true, lastTurnOutcome: "completed" }));
		tracker.update(session({ sessionId: "session-2", cwd: "/tmp/other" }));
		tracker.update(
			session({
				sessionId: "session-2",
				cwd: "/tmp/other",
				state: "idle",
				unread: true,
				lastTurnOutcome: "completed",
			}),
		);

		tracker.forgetSession("session-1");
		expect(setBadgeCount).toHaveBeenLastCalledWith(1);
		tracker.forgetSession("session-1");
		expect(setBadgeCount).toHaveBeenCalledTimes(3);
		tracker.forgetProject("code", "/tmp/other");
		expect(setBadgeCount).toHaveBeenLastCalledWith(0);
	});
});
