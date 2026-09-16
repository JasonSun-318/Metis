import type { SessionSummary } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import { AppStore } from "../src/renderer/store/app-store.ts";
import {
	DEFAULT_SESSION_GROUPING,
	groupSessionsByDate,
	groupSessionsByUnread,
	loadSessionGroupingPreferences,
	saveSessionGroupingPreferences,
	sessionsForMode,
} from "../src/renderer/store/session-grouping.ts";

// Local-time constructor keeps grouping assertions deterministic in any timezone.
const local = (year: number, month: number, day: number, hour: number) =>
	new Date(year, month - 1, day, hour).toISOString();

function session(sessionId: string, mode: "chat" | "code", updatedAt: string, unread = false): SessionSummary {
	return {
		sessionId,
		mode,
		cwdOrigin: "user-selected",
		cwd: "/tmp/project",
		createdAt: updatedAt,
		updatedAt,
		state: "idle",
		archived: false,
		unread,
	};
}

describe("session grouping", () => {
	it("sorts one mode deterministically into local date and unread sections", () => {
		const store = new AppStore();
		const sessions = [
			session("b", "chat", local(2026, 7, 31, 1), true),
			session("a", "chat", local(2026, 7, 31, 1)),
			session("yesterday", "chat", local(2026, 7, 30, 12)),
			session("older", "chat", local(2026, 7, 29, 12)),
			session("previous-year", "chat", local(2025, 7, 31, 12)),
			session("code", "code", local(2026, 7, 31, 23), true),
		];
		store.setSessions({ sessions: sessions.reverse(), nextAfterSessionId: null });
		const chat = sessionsForMode(store.getSnapshot(), "chat");

		expect(chat.map(({ sessionId }) => sessionId)).toEqual(["a", "b", "yesterday", "older", "previous-year"]);
		expect(groupSessionsByDate(chat, new Date(2026, 6, 31, 12)).map(({ label }) => label)).toEqual([
			"Today",
			"Yesterday",
			"Jul 29",
			"Jul 31, 2025",
		]);
		expect(
			groupSessionsByUnread(chat).map(({ label, sessions: grouped }) => [
				label,
				grouped.map(({ sessionId }) => sessionId),
			]),
		).toEqual([
			["Unread", ["b"]],
			["Read", ["a", "yesterday", "older", "previous-year"]],
		]);
		expect(
			groupSessionsByUnread([session("read", "chat", "2026-07-31T00:00:00Z")]).map(({ label }) => label),
		).toEqual(["Read"]);
	});

	it("loads safe defaults and saves independent mode preferences", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};
		expect(loadSessionGroupingPreferences(storage)).toEqual(DEFAULT_SESSION_GROUPING);
		saveSessionGroupingPreferences(storage, { chat: "unread", code: "none" });
		expect(loadSessionGroupingPreferences(storage)).toEqual({ chat: "unread", code: "none" });
		values.set("metis.session-grouping.v1", '{"chat":"broken","code":"project"}');
		expect(loadSessionGroupingPreferences(storage)).toEqual({ chat: "date", code: "project" });
		values.set("metis.session-grouping.v1", "{");
		expect(loadSessionGroupingPreferences(storage)).toEqual(DEFAULT_SESSION_GROUPING);
	});
});
