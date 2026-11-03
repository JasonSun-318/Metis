import { describe, expect, it } from "vitest";
import config from "../webpack.renderer.config.ts";

describe("diff worker side effects", () => {
	it.each([
		"/repo/node_modules/@pierre/diffs/dist/worker/worker.js",
		"C:\\repo\\node_modules\\@pierre\\diffs\\dist\\worker\\worker.js",
	])("retains the worker entry when Webpack resolves %s", (resource) => {
		const matched = config.module?.rules?.filter(
			(rule) => typeof rule === "object" && rule !== null && rule.test instanceof RegExp && rule.test.test(resource),
		);
		expect(matched).toEqual(expect.arrayContaining([expect.objectContaining({ sideEffects: true })]));
	});

	it("does not apply the worker override to unrelated module files", () => {
		const sideEffectRules = (config.module?.rules ?? []).filter(
			(rule) => typeof rule === "object" && rule !== null && rule.sideEffects === true,
		);
		const workerRules = sideEffectRules.filter(
			(rule) =>
				typeof rule === "object" &&
				rule !== null &&
				rule.test instanceof RegExp &&
				rule.test.test("C:\\repo\\node_modules\\@pierre\\diffs\\dist\\worker\\worker.js"),
		);
		expect(workerRules).not.toHaveLength(0);
		for (const rule of workerRules) {
			if (typeof rule !== "object" || rule === null || !(rule.test instanceof RegExp))
				throw new Error("Worker rule is missing its test pattern");
			expect(rule.test.test("C:\\repo\\node_modules\\@pierre\\diffs\\dist\\worker\\index.js")).toBe(false);
		}
	});
});
