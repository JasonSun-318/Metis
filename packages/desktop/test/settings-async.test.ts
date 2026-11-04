import { describe, expect, it } from "vitest";
import { cachedSettingsView, rememberSettingsView } from "../src/renderer/settings-async.ts";

describe("settings view cache", () => {
	it("round-trips a view per owner and key", () => {
		const owner = {};
		expect(cachedSettingsView(owner, "model")).toBeUndefined();
		rememberSettingsView(owner, "model", { enabled: true });
		expect(cachedSettingsView(owner, "model")).toEqual({ enabled: true });
		expect(cachedSettingsView(owner, "memory")).toBeUndefined();
	});

	it("keeps owners isolated", () => {
		const first = {};
		const second = {};
		rememberSettingsView(first, "profile", "first");
		expect(cachedSettingsView(second, "profile")).toBeUndefined();
		expect(cachedSettingsView(first, "profile")).toBe("first");
	});
});
