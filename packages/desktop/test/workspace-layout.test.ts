import { describe, expect, it } from "vitest";
import { projectPaneSizes, resizeAdjacentPaneSizes } from "../src/renderer/workspace-layout.ts";

describe("projectPaneSizes", () => {
	it("distributes the budget proportionally to positive weights", () => {
		expect(projectPaneSizes([1, 3], 800, 0)).toEqual([200, 600]);
	});

	it("preserves proportions and minimums when finite weights would overflow their sum", () => {
		const huge = Number.MAX_VALUE;
		expect(projectPaneSizes([huge, huge], 800, 100)).toEqual([400, 400]);
		expect(projectPaneSizes([huge / 2, huge], 900, 0)).toEqual([300, 600]);
		expect(projectPaneSizes([1, huge, huge], 900, 100)).toEqual([100, 400, 400]);
	});

	it("falls back to equal shares for zero, negative or non-finite weights", () => {
		expect(projectPaneSizes([0, -1, Number.NaN], 300, 0)).toEqual([100, 100, 100]);
	});

	it("water-fills panes below the minimum and keeps the total exact", () => {
		const sizes = projectPaneSizes([1, 1, 98], 1000, 100);
		expect(sizes[0]).toBeCloseTo(100);
		expect(sizes[1]).toBeCloseTo(100);
		expect(sizes[2]).toBeCloseTo(800);
		expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1000);
	});

	it("clamps the soft minimum to at most the equal share of the budget", () => {
		// minimum 400 would exceed 600/2, so both panes keep equal sizes.
		expect(projectPaneSizes([1, 1], 600, 400)).toEqual([300, 300]);
		// minimum 100 fits within 600/2 and lifts the small pane off its raw 60 share.
		expect(projectPaneSizes([1, 9], 600, 100)).toEqual([100, 500]);
	});

	it("returns zeros for an unusable budget and an empty array for no panes", () => {
		expect(projectPaneSizes([1, 2], 0, 100)).toEqual([0, 0]);
		expect(projectPaneSizes([1, 2], Number.NaN, 100)).toEqual([0, 0]);
		expect(projectPaneSizes([], 500, 100)).toEqual([]);
	});

	it("does not mutate the saved weights", () => {
		const weights = [2, 1, 0];
		projectPaneSizes(weights, 900, 50);
		expect(weights).toEqual([2, 1, 0]);
	});
});

describe("resizeAdjacentPaneSizes", () => {
	it("moves the boundary by delta while preserving the total and non-adjacent sizes", () => {
		const next = resizeAdjacentPaneSizes([100, 200, 300], 1, 50, 50);
		expect(next).toEqual([150, 150, 300]);
		expect(next.reduce((sum, size) => sum + size, 0)).toBe(600);
	});

	it("supports negative deltas growing the right pane", () => {
		expect(resizeAdjacentPaneSizes([100, 200], 1, -40, 10)).toEqual([60, 240]);
	});

	it("clamps so both adjacent panes stay at the minimum", () => {
		expect(resizeAdjacentPaneSizes([100, 200], 1, 500, 60)).toEqual([240, 60]);
		expect(resizeAdjacentPaneSizes([100, 200], 1, -500, 60)).toEqual([60, 240]);
	});

	it("clamps the minimum to half the adjacent total when space is tight", () => {
		expect(resizeAdjacentPaneSizes([90, 10], 1, 5, 60)).toEqual([50, 50]);
	});

	it("returns the input unchanged for invalid boundaries or values", () => {
		const sizes = [100, 200, 300];
		expect(resizeAdjacentPaneSizes(sizes, 0, 10, 10)).toBe(sizes);
		expect(resizeAdjacentPaneSizes(sizes, 3, 10, 10)).toBe(sizes);
		expect(resizeAdjacentPaneSizes(sizes, 1.5, 10, 10)).toBe(sizes);
		expect(resizeAdjacentPaneSizes(sizes, 1, Number.NaN, 10)).toBe(sizes);
		expect(resizeAdjacentPaneSizes([100, Number.NaN], 1, 10, 10)).toEqual([100, Number.NaN]);
	});

	it("does not mutate the input sizes", () => {
		const sizes = [100, 200];
		resizeAdjacentPaneSizes(sizes, 1, 30, 10);
		expect(sizes).toEqual([100, 200]);
	});
});
