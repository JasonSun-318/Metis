import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import truncatedTool from "../examples/extensions/truncated-tool.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => "src/app.ts:1:match\n"),
}));

describe("truncated-tool example", () => {
	it("passes model-controlled search values as argv instead of shell text", async () => {
		let registered: ToolDefinition | undefined;
		const metis = {
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
		} as unknown as ExtensionAPI;
		truncatedTool(metis);

		const pattern = '"; touch /tmp/metis-example-pwn; #';
		await registered!.execute("call-1", { pattern, path: "src", glob: "*.ts" } as never, undefined, undefined, {
			cwd: "/repo",
		} as ExtensionContext);

		expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
			"rg",
			["--line-number", "--color=never", "--glob", "*.ts", "--", pattern, "src"],
			{ cwd: "/repo", encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 },
		);
	});
});
