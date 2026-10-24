import type { BrowserObservation } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import { pageBrowserObservation } from "../src/main/browser-observation.ts";

const base: BrowserObservation = {
	browserId: "88888888-8888-4888-8888-888888888888",
	profileId: "00000000-0000-4000-8000-000000000001",
	documentId: "99999999-9999-4999-8999-999999999999",
	revision: 1,
	change: "full",
	url: "https://example.test/",
	title: "Fixture",
	loading: false,
	state: "e1 button Continue",
};

describe("browser observation pages", () => {
	it("leaves small observations and their screenshot unchanged", () => {
		const observation = { ...base, screenshot: { mediaType: "image/jpeg" as const, data: "anBlZw==" } };
		expect(pageBrowserObservation(observation, undefined)).toBe(observation);
	});

	it.each([
		Array.from({ length: 1600 }, (_, index) => `e${index} button "${"Label ".repeat(10)}"\n`).join(""),
		`e1 button ${JSON.stringify('"\\\u0000😀中文'.repeat(15_000))}`,
	])("preserves every character across bounded, parseable pages", (state) => {
		const observation = { ...base, state, title: '"\\\u0000'.repeat(1000) };
		let page = pageBrowserObservation(observation, undefined);
		let joined = "";
		let count = 0;
		do {
			expect(++count).toBeLessThan(100);
			expect(JSON.stringify(page).length).toBeLessThanOrEqual(45_000);
			expect(JSON.parse(JSON.stringify(page))).toEqual(page);
			expect(page.statePage?.offset).toBe(joined.length);
			expect(Buffer.from(page.state, "utf8").toString("utf8")).toBe(page.state);
			joined += page.state;
			if (!page.statePage?.nextCursor) break;
			page = pageBrowserObservation(observation, page.statePage.nextCursor);
		} while (joined.length < state.length);
		expect(count).toBeGreaterThan(1);
		expect(joined).toBe(state);
	});

	it.each([
		{ documentId: base.documentId, revision: 0, offset: 2 },
		{ documentId: base.browserId, revision: 1, offset: 2 },
		{ documentId: base.documentId, revision: 1, offset: 99 },
	])("explicitly restarts an expired or invalid continuation", (cursor) => {
		expect(pageBrowserObservation(base, cursor)).toMatchObject({
			state: base.state,
			cursorReset: true,
			statePage: { offset: 0, totalChars: base.state.length },
		});
	});
});
