import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLocalStorageData } from "../migrate-metis-data.mjs";

function storage(initial = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, String(value)),
		removeItem: (key) => values.delete(key),
		values,
	};
}

test("sets a UI work mode and keeps the rest untouched on a fresh profile", () => {
	const target = storage();
	const report = migrateLocalStorageData(target, true);
	assert.equal(report.workMode, "chat");
	assert.equal(target.values.get("metis.work-mode.v1"), "chat");
	assert.equal(report.projectPreferences, false);
	assert.equal(report.sessionGrouping, false);
});

test("migrates mode-keyed project preferences to v3 preferring the current UI mode", () => {
	const target = storage({
		"metis.work-mode.v1": "code",
		"metis.projectPreferences.v2": JSON.stringify({
			version: 1,
			entries: [
				{ mode: "chat", cwd: "/work/a", alias: "Chat alias", pinned: false },
				{ mode: "code", cwd: "/work/a", alias: "Code alias", pinned: true },
				{ mode: "code", cwd: "/work/b", pinned: false },
			],
		}),
	});
	const report = migrateLocalStorageData(target, true);
	assert.equal(report.projectPreferences, true);
	assert.deepEqual(JSON.parse(target.values.get("metis.projectPreferences.v3")), {
		version: 1,
		entries: [
			{ cwd: "/work/a", alias: "Code alias", pinned: true },
			{ cwd: "/work/b", pinned: false },
		],
	});
	assert.equal(target.values.has("metis.projectPreferences.v2"), false);
});

test("migrates the legacy session grouping with the current UI mode", () => {
	const target = storage({
		"metis.work-mode.v1": "code",
		"metis.session-grouping.v1": JSON.stringify({ chat: "status", code: "project" }),
	});
	const report = migrateLocalStorageData(target, true);
	assert.equal(report.sessionGrouping, true);
	assert.equal(target.values.get("metis.session-grouping.v2"), "project");
	assert.equal(target.values.has("metis.session-grouping.v1"), false);
});

test("keeps a valid v3 preference document and only removes retired keys", () => {
	const v3 = JSON.stringify({ version: 1, entries: [{ cwd: "/work/a", pinned: true }] });
	const target = storage({
		"metis.projectPreferences.v3": v3,
		"metis.projectPreferences.v2": JSON.stringify({ version: 1, entries: [] }),
		"metis.session-grouping.v2": "date",
	});
	const report = migrateLocalStorageData(target, true);
	assert.equal(report.projectPreferences, false);
	assert.equal(target.values.get("metis.projectPreferences.v3"), v3);
	assert.equal(target.values.has("metis.projectPreferences.v2"), false);
});

test("dry runs report the planned changes without writing", () => {
	const target = storage({
		"metis.projectPreferences.v2": JSON.stringify({
			version: 1,
			entries: [{ mode: "chat", cwd: "/work/a", pinned: true }],
		}),
	});
	const report = migrateLocalStorageData(target, false);
	assert.equal(report.workMode, "chat");
	assert.equal(report.projectPreferences, true);
	assert.equal(target.values.has("metis.work-mode.v1"), false);
	assert.equal(target.values.has("metis.projectPreferences.v3"), false);
	assert.equal(target.values.has("metis.projectPreferences.v2"), true);
});

test("is idempotent", () => {
	const target = storage({
		"metis.projectPreferences.v2": JSON.stringify({
			version: 1,
			entries: [{ mode: "chat", cwd: "/work/a", pinned: true }],
		}),
		"metis.session-grouping.v1": JSON.stringify({ chat: "status", code: "date" }),
	});
	migrateLocalStorageData(target, true);
	const second = migrateLocalStorageData(target, true);
	assert.equal(second.projectPreferences, false);
	assert.equal(second.sessionGrouping, false);
	assert.equal(second.workMode, null);
});
