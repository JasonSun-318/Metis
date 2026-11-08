import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { ItemViewSchema } from "../src/views.ts";

describe("subagent report protocol", () => {
	it("accepts optional bounded source metadata and rejects invalid reports", () => {
		const check = Compile(ItemViewSchema);
		const item = {
			itemId: "report-1",
			sessionId: "11111111-1111-4111-8111-111111111111",
			role: "system",
			state: "completed",
			content: [{ type: "text", text: "Found the requested files." }],
			createdAt: "2026-11-05T00:00:00Z",
		};
		expect(check.Check(item)).toBe(true);
		for (const status of ["done", "failed", "stopped"])
			expect(check.Check({ ...item, agentReport: { name: "Inventory", status } })).toBe(true);
		for (const agentReport of [
			{ name: "", status: "done" },
			{ name: "x".repeat(129), status: "done" },
			{ name: "Inventory", status: "running" },
			{ name: "Inventory", status: "done", text: "Extra" },
		])
			expect(check.Check({ ...item, agentReport })).toBe(false);
	});
});
