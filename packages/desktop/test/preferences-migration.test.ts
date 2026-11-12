// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyDesktopPreferences } from "../src/renderer/preferences-migration.ts";

beforeEach(() => localStorage.clear());

const legacyPreferences = {
	version: 1,
	entries: [
		{ mode: "chat", cwd: "/work/a", alias: "Chat alias", pinned: false },
		{ mode: "code", cwd: "/work/a", alias: "Code alias", pinned: true },
		{ mode: "code", cwd: "/work/b", pinned: false },
	],
};

describe("migrateLegacyDesktopPreferences", () => {
	it("keeps a fresh profile at its defaults", () => {
		migrateLegacyDesktopPreferences();

		expect(localStorage.getItem("metis.work-mode.v1")).toBe("chat");
		expect(localStorage.getItem("metis.projectPreferences.v3")).toBeNull();
		expect(localStorage.getItem("metis.session-grouping.v2")).toBeNull();
	});

	it("migrates mode-keyed preferences and keeps the current work mode", () => {
		localStorage.setItem("metis.work-mode.v1", "code");
		localStorage.setItem("metis.projectPreferences.v2", JSON.stringify(legacyPreferences));
		localStorage.setItem("metis.session-grouping.v1", JSON.stringify({ chat: "status", code: "project" }));

		migrateLegacyDesktopPreferences();

		expect(localStorage.getItem("metis.work-mode.v1")).toBe("code");
		expect(JSON.parse(localStorage.getItem("metis.projectPreferences.v3")!)).toEqual({
			version: 1,
			entries: [
				{ cwd: "/work/a", pinned: true, alias: "Code alias" },
				{ cwd: "/work/b", pinned: false },
			],
		});
		expect(localStorage.getItem("metis.session-grouping.v2")).toBe("project");
		expect(localStorage.getItem("metis.projectPreferences.v2")).toBeNull();
		expect(localStorage.getItem("metis.session-grouping.v1")).toBeNull();
	});

	it("derives the work mode from the legacy active conversation list", () => {
		localStorage.setItem("metis.activeSessionId.code", "11111111-1111-4111-8111-111111111111");

		migrateLegacyDesktopPreferences();

		expect(localStorage.getItem("metis.work-mode.v1")).toBe("code");
	});

	it("leaves already migrated preferences alone", () => {
		const v3 = JSON.stringify({ version: 1, entries: [{ cwd: "/work/a", pinned: true }] });
		localStorage.setItem("metis.work-mode.v1", "chat");
		localStorage.setItem("metis.projectPreferences.v3", v3);
		localStorage.setItem("metis.session-grouping.v2", "date");

		migrateLegacyDesktopPreferences();

		expect(localStorage.getItem("metis.projectPreferences.v3")).toBe(v3);
		expect(localStorage.getItem("metis.session-grouping.v2")).toBe("date");
	});

	it("is idempotent", () => {
		localStorage.setItem("metis.projectPreferences.v1", JSON.stringify(legacyPreferences));
		migrateLegacyDesktopPreferences();
		const first = localStorage.getItem("metis.projectPreferences.v3");
		migrateLegacyDesktopPreferences();
		expect(localStorage.getItem("metis.projectPreferences.v3")).toBe(first);
	});
});
