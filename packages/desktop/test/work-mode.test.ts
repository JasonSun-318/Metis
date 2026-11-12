// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadProjectPreferences, saveProjectPreferences } from "../src/renderer/store/project-preferences.ts";
import {
	loadSessionGroupingPreferences,
	saveSessionGroupingPreferences,
} from "../src/renderer/store/session-grouping.ts";
import { loadWorkMode, WORK_MODE_KEY } from "../src/renderer/work-mode.ts";

beforeEach(() => localStorage.clear());

it("reads the persisted UI work mode and defaults to chat", () => {
	expect(loadWorkMode(localStorage)).toBe("chat");
	localStorage.setItem(WORK_MODE_KEY, "code");
	expect(loadWorkMode(localStorage)).toBe("code");
	localStorage.setItem(WORK_MODE_KEY, "invalid");
	expect(loadWorkMode(localStorage)).toBe("chat");
});

it("reads and writes unified cwd-keyed project preferences", () => {
	const preferences = new Map([["/project", { cwd: "/project", alias: "daily", pinned: true }]]);
	saveProjectPreferences(localStorage, preferences);
	expect(loadProjectPreferences(localStorage)).toEqual(preferences);
	localStorage.setItem("metis.projectPreferences.v3", "{");
	expect(loadProjectPreferences(localStorage).size).toBe(0);
});

it("reads and writes the unified session grouping preference", () => {
	expect(loadSessionGroupingPreferences(localStorage)).toEqual({ chat: "date", code: "date" });
	saveSessionGroupingPreferences(localStorage, { chat: "project", code: "project" });
	expect(loadSessionGroupingPreferences(localStorage)).toEqual({ chat: "project", code: "project" });
	localStorage.setItem("metis.session-grouping.v2", "broken");
	expect(loadSessionGroupingPreferences(localStorage)).toEqual({ chat: "date", code: "date" });
});
