import { describe, expect, it } from "vitest";
import {
	computeNavigationMarks,
	navigationMarkTop,
	navigationScrollOffset,
	navigationViewportHeight,
	pickNavigationIndex,
} from "../src/renderer/conversation-navigation.ts";

function history(count: number) {
	return Array.from({ length: count }, (_, index) => ({ itemId: `turn-${index}` }));
}

describe("Scrollable conversation index layout", () => {
	it("has no viewport or rows when there is no history or available space", () => {
		expect(navigationViewportHeight(0, 420)).toBe(0);
		expect(navigationViewportHeight(15, 0)).toBe(0);
		expect(navigationViewportHeight(15, -10)).toBe(0);
		expect(computeNavigationMarks([], 120, 0)).toEqual([]);
		expect(computeNavigationMarks(history(15), 0, 0)).toEqual([]);
	});

	it("grows real eight-pixel rows while retaining a minimum hit target for one or two turns", () => {
		expect(navigationViewportHeight(1, 420)).toBe(24);
		expect(navigationViewportHeight(2, 420)).toBe(24);
		expect(navigationViewportHeight(3, 420)).toBe(24);
		expect(navigationViewportHeight(15, 420)).toBe(120);
	});

	it("caps large indexes at 640 pixels and at the smaller available frame", () => {
		expect(navigationViewportHeight(1000, 900)).toBe(640);
		expect(navigationViewportHeight(1000, 420)).toBe(420);
		expect(navigationViewportHeight(1, 12)).toBe(12);
	});

	it("centers only actual short-history marks inside the minimum hit target", () => {
		expect(navigationMarkTop(0, 1, 24)).toBe(12);
		expect([navigationMarkTop(0, 2, 24), navigationMarkTop(1, 2, 24)]).toEqual([8, 16]);
		expect(computeNavigationMarks(history(2), 24, 0)).toEqual([
			{ key: "turn-0", index: 0, top: 8 },
			{ key: "turn-1", index: 1, top: 16 },
		]);
	});

	it("renders exactly fifteen real identities at eight-pixel spacing in a 120-pixel index", () => {
		const marks = computeNavigationMarks(history(15), 120, 0);
		expect(marks).toHaveLength(15);
		expect(marks.map((mark) => mark.key)).toEqual(history(15).map((item) => item.itemId));
		expect(marks[0]).toEqual({ key: "turn-0", index: 0, top: 4 });
		expect(marks.at(-1)).toEqual({ key: "turn-14", index: 14, top: 116 });
		for (let index = 1; index < marks.length; index += 1) expect(marks[index]!.top - marks[index - 1]!.top).toBe(8);
	});

	it("bounds a thousand-turn render window with four genuine overscan rows on either side", () => {
		const entries = history(1000);
		const top = computeNavigationMarks(entries, 640, 0);
		expect(top).toHaveLength(84);
		expect(top[0]!.key).toBe("turn-0");
		expect(top.at(-1)!.key).toBe("turn-83");
		const middle = computeNavigationMarks(entries, 640, 3200);
		expect(middle).toHaveLength(88);
		expect(middle[0]).toEqual({ key: "turn-396", index: 396, top: 3172 });
		expect(middle.at(-1)!.key).toBe("turn-483");
		expect(middle.some((mark) => mark.key === "turn-400")).toBe(true);
		expect(middle.some((mark) => mark.key === "turn-479")).toBe(true);
		expect(new Set(middle.map((mark) => mark.key)).size).toBe(middle.length);
	});

	it("clamps out-of-range index scrolling without generating missing or synthetic rows", () => {
		const entries = history(1000);
		expect(computeNavigationMarks(entries, 640, -100)).toEqual(computeNavigationMarks(entries, 640, 0));
		const bottom = computeNavigationMarks(entries, 640, 10000);
		expect(bottom).toHaveLength(84);
		expect(bottom[0]!.key).toBe("turn-916");
		expect(bottom.at(-1)).toEqual({ key: "turn-999", index: 999, top: 7996 });
	});

	it("hit-tests real rows with both short-list padding and a fractional browsed offset", () => {
		expect(pickNavigationIndex(2, 24, 0, 0)).toBe(0);
		expect(pickNavigationIndex(2, 24, 0, 12)).toBe(1);
		expect(pickNavigationIndex(1000, 420, 1603, 1)).toBe(200);
		expect(pickNavigationIndex(1000, 420, 1603, 20)).toBe(202);
		expect(pickNavigationIndex(15, 120, 0, -100)).toBe(0);
		expect(pickNavigationIndex(15, 120, 0, 1000)).toBe(14);
		expect(pickNavigationIndex(0, 120, 0, 0)).toBe(0);
	});

	it("reveals offscreen targets, preserves fully visible rows and clamps Home/End boundaries", () => {
		expect(navigationScrollOffset(201, 1000, 640, 1603)).toBe(1603);
		expect(navigationScrollOffset(0, 1000, 640, 1603)).toBe(0);
		expect(navigationScrollOffset(999, 1000, 640, 0)).toBe(7360);
		for (const [target, current] of [
			[100, 3200],
			[900, 0],
		] as const) {
			const offset = navigationScrollOffset(target, 1000, 640, current);
			const center = navigationMarkTop(target, 1000, 640);
			expect(offset).toBeGreaterThanOrEqual(0);
			expect(offset).toBeLessThanOrEqual(7360);
			expect(center - 4).toBeGreaterThanOrEqual(offset);
			expect(center + 4).toBeLessThanOrEqual(offset + 640);
		}
		expect(navigationScrollOffset(3, 0, 640, 100)).toBe(0);
		expect(navigationScrollOffset(3, 15, 0, 100)).toBe(0);
	});

	it("retains a real row identity and fractional position across a prepend", () => {
		const entries = history(1000);
		const before = computeNavigationMarks(entries, 420, 1603).find((mark) => mark.key === "turn-200")!;
		const prepended = [{ itemId: "older-a" }, { itemId: "older-b" }, ...entries];
		const after = computeNavigationMarks(prepended, 420, 1619).find((mark) => mark.key === "turn-200")!;
		expect(after.key).toBe(before.key);
		expect(after.index).toBe(before.index + 2);
		expect(after.top - 1619).toBe(before.top - 1603);
	});
});
