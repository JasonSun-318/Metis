import { setCapabilities, Text, type TUI } from "@metis/tui";
import { Type } from "typebox";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { permissionClaim, permissionDescriptor } from "../src/core/tool-permission-adapter.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 80;
const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0x00);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd83d);

const fakeTui = {
	requestRender: () => {},
} as unknown as TUI;

function fixtureDefinition(
	name: string,
	overrides: Partial<ToolDefinition<any, any, any>> = {},
): ToolDefinition<any, any, any> {
	return {
		name,
		label: `label:${name}`,
		description: `fixture tool ${name}`,
		parameters: Type.Any(),
		permission: permissionDescriptor(() => permissionClaim()),
		execute: async () => ({ content: [], details: undefined }),
		...overrides,
	};
}

function renderLines(component: ToolExecutionComponent, width = WIDTH): string[] {
	return stripAnsi(component.render(width).join("\n"))
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/u, ""));
}

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
});

describe("ToolExecutionComponent private unknown storage compatibility", () => {
	test("passes primitive and array arguments to renderers without filtering or mutation", () => {
		const observed: unknown[] = [];
		const args = ["alpha", { nested: [`bold${ESC}[31m`, 7] }, true, null, 42];
		const component = new ToolExecutionComponent(
			"opaque_args",
			"opaque-args-call",
			args,
			{},
			fixtureDefinition("opaque_args", {
				renderCall: (callArgs) => {
					observed.push(callArgs);
					return new Text("CALL", 0, 0);
				},
			}),
			fakeTui,
			"/tmp/compat-opaque-args",
		);

		expect(observed).toEqual([["alpha", { nested: ["bold", 7] }, true, null, 42]]);
		expect(args[1]).toEqual({ nested: [`bold${ESC}[31m`, 7] });

		for (const primitive of [17, true, null, "plain"]) {
			component.updateArgs(primitive);
			expect(observed.at(-1)).toBe(primitive);
		}
		component.updateArgs(["x", null]);
		expect(observed.at(-1)).toEqual(["x", null]);
		expect(renderLines(component)).toEqual(["", "", " CALL", ""]);
	});

	test("passes opaque primitive details and custom content blocks through updateResult unchanged", () => {
		const results: Array<{ content: unknown; details: unknown }> = [];
		const component = new ToolExecutionComponent(
			"opaque_result",
			"opaque-result-call",
			{},
			{},
			fixtureDefinition("opaque_result", {
				renderCall: () => new Text("CALL", 0, 0),
				renderResult: (result) => {
					results.push(result);
					return new Text("RESULT", 0, 0);
				},
			}),
			fakeTui,
			"/tmp/compat-opaque-result",
		);
		const injected = `visible${ESC}[31m\r\nnext${NUL}${LONE_HIGH_SURROGATE}`;
		const customBlock = Object.assign(
			{ type: "custom_resource", text: injected, data: "payload", mimeType: "text/plain" },
			{ extra: { keep: true } },
		);

		component.updateResult(
			{
				content: [customBlock, { type: "image", data: "abc", mimeType: "image/png" }],
				details: 17,
				isError: false,
			},
			false,
		);

		expect(results).toHaveLength(1);
		expect(results[0].details).toBe(17);
		expect(results[0].content).toEqual([
			{
				type: "custom_resource",
				text: `visible\nnext${LONE_HIGH_SURROGATE}`,
				data: "payload",
				mimeType: "text/plain",
				extra: { keep: true },
			},
			{ type: "image", data: "abc", mimeType: "image/png" },
		]);
		expect(customBlock.text).toBe(injected);

		for (const details of [true, null, "plain"]) {
			component.updateResult({ content: [], details, isError: false }, false);
			expect(results.at(-1)?.details).toBe(details);
		}
		component.updateResult(
			{ content: [{ type: "text", text: `opaque${ESC}[31m` }], details: `opaque${ESC}[31m`, isError: false },
			false,
		);
		expect(results.at(-1)?.details).toBe("opaque");
		expect(results.at(-1)?.content).toEqual([{ type: "text", text: "opaque" }]);
		expect(renderLines(component)).toEqual(["", "", " CALL", " RESULT", ""]);
	});
});
