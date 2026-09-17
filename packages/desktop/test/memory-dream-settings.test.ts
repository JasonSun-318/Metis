import { describe, expect, it } from "vitest";
import { parseDreamDraft, toDreamDraft } from "../src/renderer/components/memory-dream-settings.ts";

describe("Dream settings draft", () => {
	const defaults = { enabled: true, minHours: 24, minSessions: 5, maxUnusedDays: 90, nextEligible: false };
	it("clears a model override and sends every editable setting", () => {
		expect(parseDreamDraft(toDreamDraft(defaults))).toEqual({
			ok: true,
			value: {
				enabled: true,
				model: null,
				minHours: 24,
				minSessions: 5,
				maxUnusedDays: 90,
			},
		});
	});
	it.each(["", "0", "-1", "1.5", "8761", "Infinity"])("rejects invalid minHours %s", (minHours) => {
		expect(parseDreamDraft({ ...toDreamDraft(defaults), minHours }).ok).toBe(false);
	});
	it("preserves provider and model IDs containing slashes", () => {
		const model = { provider: "custom/team", modelId: "vendor/model" };
		const result = parseDreamDraft(toDreamDraft({ ...defaults, model }));
		expect(result.ok && result.value.model).toEqual(model);
	});
	it("checks the other RPC integer bounds", () => {
		expect(parseDreamDraft({ ...toDreamDraft(defaults), minSessions: "100001" }).ok).toBe(false);
		expect(parseDreamDraft({ ...toDreamDraft(defaults), maxUnusedDays: "3651" }).ok).toBe(false);
	});
});
