// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadProjectPreferences, saveProjectPreferences } from "../src/renderer/store/project-preferences.ts";
import {
	loadSessionGroupingPreferences,
	saveSessionGroupingPreferences,
} from "../src/renderer/store/session-grouping.ts";
import { legacyActiveConversation, loadWorkMode, WORK_MODE_KEY } from "../src/renderer/work-mode.ts";

beforeEach(() => localStorage.clear());
it("migrates the focused legacy code conversation and mode-keyed project preferences once", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	localStorage.setItem("metis.activeSessionId.code", id);
	localStorage.setItem(
		"metis.workspace-layout.v1",
		JSON.stringify({
			version: 1,
			activePaneId: "pane",
			nextNumber: 2,
			panes: [{ id: "pane", row: 0, activeIndex: 0, chats: [{ sessionId: id }] }],
		}),
	);
	localStorage.setItem("metis.session-grouping.v1", JSON.stringify({ chat: "date", code: "project" }));
	localStorage.setItem(
		"metis.projectPreferences.v2",
		JSON.stringify({
			version: 1,
			entries: [
				{ mode: "chat", cwd: "/project", alias: "daily", pinned: false },
				{ mode: "code", cwd: "/project", alias: "development", pinned: true },
			],
		}),
	);
	expect(legacyActiveConversation(localStorage)).toBe(id);
	expect(loadWorkMode(localStorage)).toBe("code");
	const preferences = loadProjectPreferences(localStorage);
	expect([...preferences.values()]).toEqual([{ cwd: "/project", alias: "development", pinned: true }]);
	saveProjectPreferences(localStorage, preferences);
	saveSessionGroupingPreferences(localStorage, loadSessionGroupingPreferences(localStorage));
	localStorage.setItem(WORK_MODE_KEY, "chat");
	expect(loadWorkMode(localStorage)).toBe("chat");
	expect(loadSessionGroupingPreferences(localStorage)).toEqual({ chat: "project", code: "project" });
	expect(loadProjectPreferences(localStorage)).toEqual(preferences);
});
it("uses daily work for a fresh installation and malformed preference", () => {
	expect(loadWorkMode(localStorage)).toBe("chat");
	localStorage.setItem(WORK_MODE_KEY, "invalid");
	localStorage.setItem("metis.workspace-layout.v1", "{");
	expect(loadWorkMode(localStorage)).toBe("chat");
});
