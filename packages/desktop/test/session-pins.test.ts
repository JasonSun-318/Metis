import { describe, expect, it } from "vitest";
import { loadSessionPins, saveSessionPins, setSessionPinned } from "../src/renderer/store/session-pins.ts";

describe("session pins", () => {
	it("persists a stable set and toggles one session without mutating the input", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};
		const empty = loadSessionPins(storage);
		const pinned = setSessionPinned(empty, "session-b", true);
		const twoPinned = setSessionPinned(pinned, "session-a", true);

		expect(empty).toEqual(new Set());
		expect(twoPinned).toEqual(new Set(["session-b", "session-a"]));
		saveSessionPins(storage, twoPinned);
		expect(values.get("metis.sessionPins.v1")).toBe('{"version":1,"sessionIds":["session-a","session-b"]}');
		expect(loadSessionPins(storage)).toEqual(new Set(["session-a", "session-b"]));
		expect(setSessionPinned(twoPinned, "session-b", false)).toEqual(new Set(["session-a"]));
	});

	it("fails closed for malformed or extended documents", () => {
		for (const value of [
			"{",
			'{"version":2,"sessionIds":[]}',
			'{"version":1,"sessionIds":"session-a"}',
			'{"version":1,"sessionIds":["session-a",1]}',
			'{"version":1,"sessionIds":[""],"extra":true}',
		]) {
			expect(loadSessionPins({ getItem: () => value })).toEqual(new Set());
		}
	});
});
