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
const BEL = String.fromCharCode(0x07);
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

describe("ToolExecutionComponent compatibility", () => {
	test("keeps the known built-in read fallback collapsed until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"read-call",
			{ path: "notes.txt" },
			{},
			undefined,
			fakeTui,
			"/tmp/compat-read",
		);

		expect(renderLines(component)).toEqual(["", "", " read notes.txt", ""]);

		component.updateResult({ content: [{ type: "text", text: "BODY" }], details: undefined, isError: false }, false);
		expect(renderLines(component)).toEqual(["", "", " read notes.txt", ""]);

		component.setExpanded(true);
		expect(renderLines(component)).toEqual(["", "", " read notes.txt", "", " BODY", ""]);
	});

	test("renders unknown tools through the generic JSON fallback", () => {
		const component = new ToolExecutionComponent(
			"unknown_tool",
			"unknown-call",
			{ alpha: "beta", count: 2 },
			{},
			undefined,
			fakeTui,
			"/tmp/compat-unknown",
		);

		expect(renderLines(component)).toEqual([
			"",
			"",
			" unknown_tool",
			"",
			" {",
			'   "alpha": "beta",',
			'   "count": 2',
			" }",
			"",
		]);

		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		expect(renderLines(component)).toEqual([
			"",
			"",
			" unknown_tool",
			"",
			" {",
			'   "alpha": "beta",',
			'   "count": 2',
			" }",
			" done",
			"",
		]);
	});

	test("renders custom-only tools with default-shell fallbacks in each slot", () => {
		const component = new ToolExecutionComponent(
			"custom_only",
			"custom-only-call",
			{ input: "value" },
			{},
			fixtureDefinition("custom_only"),
			fakeTui,
			"/tmp/compat-custom-only",
		);

		expect(renderLines(component)).toEqual(["", "", " custom_only", ""]);

		component.updateResult(
			{ content: [{ type: "text", text: "custom output" }], details: {}, isError: false },
			false,
		);
		expect(renderLines(component)).toEqual(["", "", " custom_only", " custom output", ""]);
	});

	test("uses an overridden call renderer while inheriting the built-in result renderer", () => {
		const component = new ToolExecutionComponent(
			"read",
			"read-call-override",
			{ path: "notes.txt" },
			{},
			fixtureDefinition("read", { renderCall: () => new Text("CALL-ONLY", 0, 0) }),
			fakeTui,
			"/tmp/compat-read-call",
		);

		expect(renderLines(component)).toEqual(["", "", " CALL-ONLY", ""]);

		component.updateResult({ content: [{ type: "text", text: "BODY" }], details: undefined, isError: false }, false);
		expect(renderLines(component)).toEqual(["", "", " CALL-ONLY", ""]);

		component.setExpanded(true);
		expect(renderLines(component)).toEqual(["", "", " CALL-ONLY", "", " BODY", ""]);
	});

	test("uses an overridden result renderer while inheriting the built-in call renderer", () => {
		const component = new ToolExecutionComponent(
			"read",
			"read-result-override",
			{ path: "notes.txt" },
			{},
			fixtureDefinition("read", { renderResult: () => new Text("RESULT-ONLY", 0, 0) }),
			fakeTui,
			"/tmp/compat-read-result",
		);

		component.updateResult({ content: [{ type: "text", text: "BODY" }], details: undefined, isError: false }, false);
		expect(renderLines(component)).toEqual(["", "", " read notes.txt", " RESULT-ONLY", ""]);
	});

	test("applies an overridden self shell without replacing built-in renderers", () => {
		const component = new ToolExecutionComponent(
			"read",
			"read-shell-override",
			{ path: "notes.txt" },
			{},
			fixtureDefinition("read", { renderShell: "self" }),
			fakeTui,
			"/tmp/compat-read-shell",
		);

		expect(renderLines(component)).toEqual(["", "read notes.txt"]);

		component.updateResult({ content: [{ type: "text", text: "BODY" }], details: undefined, isError: false }, false);
		expect(renderLines(component)).toEqual(["", "read notes.txt"]);

		component.setExpanded(true);
		expect(renderLines(component)).toEqual(["", "read notes.txt", "", "BODY"]);
	});

	test("falls back independently in unoverridden custom-only renderer slots", () => {
		const callOnly = new ToolExecutionComponent(
			"custom_call_only",
			"custom-call-only",
			{},
			{},
			fixtureDefinition("custom_call_only", { renderCall: () => new Text("CALL ONLY", 0, 0) }),
			fakeTui,
			"/tmp/compat-custom-call-only",
		);
		callOnly.updateResult({ content: [{ type: "text", text: "BODY" }], details: {}, isError: false }, false);
		expect(renderLines(callOnly)).toEqual(["", "", " CALL ONLY", " BODY", ""]);

		const resultOnly = new ToolExecutionComponent(
			"custom_result_only",
			"custom-result-only",
			{},
			{},
			fixtureDefinition("custom_result_only", { renderResult: () => new Text("RESULT ONLY", 0, 0) }),
			fakeTui,
			"/tmp/compat-custom-result-only",
		);
		resultOnly.updateResult({ content: [{ type: "text", text: "BODY" }], details: {}, isError: false }, false);
		expect(renderLines(resultOnly)).toEqual(["", "", " custom_result_only", " RESULT ONLY", ""]);
	});

	test("keeps default and self framing distinct for custom renderers", () => {
		const defaultShell = new ToolExecutionComponent(
			"framing_default",
			"framing-default",
			{},
			{},
			fixtureDefinition("framing_default", {
				renderCall: () => new Text("CALL", 0, 0),
				renderResult: () => new Text("RESULT", 0, 0),
			}),
			fakeTui,
			"/tmp/compat-framing-default",
		);
		defaultShell.updateResult({ content: [], details: {}, isError: false }, false);
		expect(renderLines(defaultShell)).toEqual(["", "", " CALL", " RESULT", ""]);

		const selfShell = new ToolExecutionComponent(
			"framing_self",
			"framing-self",
			{},
			{},
			fixtureDefinition("framing_self", {
				renderShell: "self",
				renderCall: () => new Text("CALL", 0, 0),
				renderResult: () => new Text("RESULT", 0, 0),
			}),
			fakeTui,
			"/tmp/compat-framing-self",
		);
		selfShell.updateResult({ content: [], details: {}, isError: false }, false);
		expect(renderLines(selfShell)).toEqual(["", "CALL", "RESULT"]);
	});

	test("sanitizes unknown tool names, arguments, and results without mutating callers", () => {
		const injected = `safe${ESC}]52;c;VEVTVA==${BEL}${ESC}[2J\r\nnext${NUL}`;
		const rawKey = `key${ESC}[31m`;
		const args = { nested: [{ value: injected }], [rawKey]: "v" };
		const component = new ToolExecutionComponent(
			`name${ESC}[31m`,
			"sanitized-call",
			args,
			{},
			undefined,
			fakeTui,
			"/tmp/compat-sanitized",
		);
		component.updateResult(
			{ content: [{ type: "text", text: injected }], details: { value: injected }, isError: false },
			false,
		);

		expect(renderLines(component)).toEqual([
			"",
			"",
			" name",
			"",
			" {",
			'   "nested": [',
			"     {",
			'       "value": "safe\\nnext"',
			"     }",
			"   ],",
			'   "key": "v"',
			" }",
			" safe",
			" next",
			"",
		]);

		const raw = component.render(WIDTH).join("\n");
		expect(raw).not.toContain(`${ESC}]52;c;VEVTVA==${BEL}`);
		expect(raw).not.toContain(`${ESC}[2J`);
		expect(raw).not.toContain(NUL);

		expect(args.nested[0]!.value).toBe(injected);
		expect(Object.keys(args)).toContain(rawKey);
	});

	test("passes sanitized arguments and details to custom renderers", () => {
		const calls: any[] = [];
		const results: any[] = [];
		const injected = `safe${ESC}]52;c;VEVTVA==${BEL}${ESC}[2J\r\nnext${NUL}${LONE_HIGH_SURROGATE}`;
		const component = new ToolExecutionComponent(
			"captured",
			"captured-call",
			{ nested: [{ value: injected }] },
			{},
			fixtureDefinition("captured", {
				renderCall: (args) => {
					calls.push(args);
					return new Text("CALL", 0, 0);
				},
				renderResult: (result) => {
					results.push(result);
					return new Text("RESULT", 0, 0);
				},
			}),
			fakeTui,
			"/tmp/compat-captured",
		);
		component.updateResult(
			{ content: [{ type: "text", text: injected }], details: { value: injected }, isError: false },
			false,
		);

		const expectedSanitized = `safe\nnext${LONE_HIGH_SURROGATE}`;
		expect(calls.at(-1)).toEqual({ nested: [{ value: expectedSanitized }] });
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({
			content: [{ type: "text", text: expectedSanitized }],
			details: { value: expectedSanitized },
		});
		expect(renderLines(component)).toEqual(["", "", " CALL", " RESULT", ""]);
	});

	test("falls back when custom call and result renderers throw", () => {
		const callThrow = new ToolExecutionComponent(
			"throw_call",
			"throw-call",
			{},
			{},
			fixtureDefinition("throw_call", {
				renderCall: () => {
					throw new Error("call renderer failed");
				},
				renderResult: () => new Text("REAL RESULT", 0, 0),
			}),
			fakeTui,
			"/tmp/compat-throw-call",
		);
		expect(renderLines(callThrow)).toEqual(["", "", " throw_call", ""]);

		callThrow.updateResult({ content: [{ type: "text", text: "OUT" }], details: {}, isError: false }, false);
		expect(renderLines(callThrow)).toEqual(["", "", " throw_call", " REAL RESULT", ""]);

		const resultThrow = new ToolExecutionComponent(
			"throw_result",
			"throw-result",
			{},
			{},
			fixtureDefinition("throw_result", {
				renderCall: () => new Text("REAL CALL", 0, 0),
				renderResult: () => {
					throw new Error("result renderer failed");
				},
			}),
			fakeTui,
			"/tmp/compat-throw-result",
		);
		resultThrow.updateResult(
			{ content: [{ type: "text", text: "fallback output" }], details: {}, isError: false },
			false,
		);
		expect(renderLines(resultThrow)).toEqual(["", "", " REAL CALL", " fallback output", ""]);
	});

	test("preserves current prototype-like tool-name fallback behavior", () => {
		for (const toolName of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			const component = new ToolExecutionComponent(
				toolName,
				`prototype-${toolName}`,
				{ ignored: true },
				{},
				undefined,
				fakeTui,
				"/tmp/compat-prototype",
			);
			component.updateResult({ content: [{ type: "text", text: "out" }], details: {}, isError: false }, false);

			expect(renderLines(component)).toEqual(["", "", ` ${toolName}`, " out", ""]);
		}
	});

	test("keeps showImages context and image fallback without native conversion", () => {
		const observedShowImages: boolean[] = [];
		const imageContext = new ToolExecutionComponent(
			"image_context",
			"image-context",
			{},
			{ showImages: false },
			fixtureDefinition("image_context", {
				renderResult: (_result, _options, _theme, context) => {
					observedShowImages.push(context.showImages);
					return new Text(`showImages=${String(context.showImages)}`, 0, 0);
				},
			}),
			fakeTui,
			"/tmp/compat-image-context",
		);
		imageContext.updateResult(
			{ content: [{ type: "image", data: "abc", mimeType: "image/png" }], details: {}, isError: false },
			false,
		);
		expect(observedShowImages.at(-1)).toBe(false);
		expect(renderLines(imageContext)).toEqual(["", "", " image_context", " showImages=false", ""]);

		imageContext.setShowImages(true);
		expect(observedShowImages.at(-1)).toBe(true);
		expect(renderLines(imageContext)).toEqual(["", "", " image_context", " showImages=true", ""]);

		const imageFallback = new ToolExecutionComponent(
			"image_unknown",
			"image-unknown",
			{},
			{},
			undefined,
			fakeTui,
			"/tmp/compat-image-fallback",
		);
		imageFallback.updateResult(
			{ content: [{ type: "image", data: "abc", mimeType: "image/png" }], details: {}, isError: false },
			false,
		);
		expect(renderLines(imageFallback)).toEqual(["", "", " image_unknown", "", " {}", " [Image: [image/png]]", ""]);
	});

	test("keeps partial args, result flags, lastComponent, and per-instance state isolated", () => {
		type RenderState = { calls: number; results: number };
		type Observation = {
			instance: string;
			slot: "call" | "result";
			args: any;
			result?: any;
			options?: { expanded: boolean; isPartial: boolean };
			component?: unknown;
			lastComponent?: unknown;
			state: RenderState;
			executionStarted: boolean;
			argsComplete: boolean;
			isPartial: boolean;
			expanded: boolean;
			showImages: boolean;
			isError: boolean;
			cwd: string;
			toolCallId: string;
		};

		const observations: Observation[] = [];

		const definition: ToolDefinition<any, any, RenderState> = fixtureDefinition("stateful", {
			renderCall: (args, _theme, context) => {
				context.state.calls = (context.state.calls ?? 0) + 1;
				const component = new Text(`call-${String(context.state.calls)}`, 0, 0);
				observations.push({
					instance: context.toolCallId.startsWith("first") ? "first" : "second",
					slot: "call",
					args,
					component,
					lastComponent: context.lastComponent,
					state: context.state,
					executionStarted: context.executionStarted,
					argsComplete: context.argsComplete,
					isPartial: context.isPartial,
					expanded: context.expanded,
					showImages: context.showImages,
					isError: context.isError,
					cwd: context.cwd,
					toolCallId: context.toolCallId,
				});
				return component;
			},
			renderResult: (result, options, _theme, context) => {
				context.state.results = (context.state.results ?? 0) + 1;
				const component = new Text(`result-${String(context.state.results)}`, 0, 0);
				observations.push({
					instance: context.toolCallId.startsWith("first") ? "first" : "second",
					slot: "result",
					args: context.args,
					result,
					options: { ...options },
					component,
					lastComponent: context.lastComponent,
					state: context.state,
					executionStarted: context.executionStarted,
					argsComplete: context.argsComplete,
					isPartial: context.isPartial,
					expanded: context.expanded,
					showImages: context.showImages,
					isError: context.isError,
					cwd: context.cwd,
					toolCallId: context.toolCallId,
				});
				return component;
			},
		});

		const first = new ToolExecutionComponent(
			"stateful",
			"first-call",
			{ query: "first" },
			{ showImages: false },
			definition,
			fakeTui,
			"/tmp/compat-cwd-first",
		);
		const second = new ToolExecutionComponent(
			"stateful",
			"second-call",
			{ query: "second" },
			{},
			definition,
			fakeTui,
			"/tmp/compat-cwd-second",
		);
		expect(second).toBeInstanceOf(ToolExecutionComponent);

		const firstCallsAfterConstruct = observations.filter((entry) => entry.instance === "first");
		const secondCallsAfterConstruct = observations.filter((entry) => entry.instance === "second");
		expect(firstCallsAfterConstruct).toHaveLength(1);
		expect(secondCallsAfterConstruct).toHaveLength(1);
		const firstState = firstCallsAfterConstruct[0]!.state;
		const secondState = secondCallsAfterConstruct[0]!.state;
		expect(firstState).not.toBe(secondState);

		first.markExecutionStarted();
		first.setArgsComplete();
		first.updateArgs({ query: "second" });
		first.updateResult({ content: [{ type: "text", text: "partial" }], details: { step: 1 }, isError: true }, true);
		first.setExpanded(true);
		first.setShowImages(true);
		first.updateResult({ content: [{ type: "text", text: "final" }], details: { step: 2 }, isError: false }, false);

		const firstObservations = observations.filter((entry) => entry.instance === "first");
		const secondObservations = observations.filter((entry) => entry.instance === "second");
		expect(firstObservations.every((entry) => entry.state === firstState)).toBe(true);
		expect(secondObservations.every((entry) => entry.state === secondState)).toBe(true);
		expect(firstState).toEqual({ calls: 8, results: 4 });
		expect(secondState).toEqual({ calls: 1 });

		const firstCalls = firstObservations.filter((entry) => entry.slot === "call");
		expect(firstCalls[0]!.lastComponent).toBeUndefined();
		for (let index = 1; index < firstCalls.length; index++) {
			expect(firstCalls[index]!.lastComponent).toBe(firstCalls[index - 1]!.component);
		}
		expect(firstCalls.at(-1)!.args).toEqual({ query: "second" });
		expect(firstCalls.at(-1)!.executionStarted).toBe(true);
		expect(firstCalls.at(-1)!.argsComplete).toBe(true);
		expect(firstCalls.at(-1)!.isPartial).toBe(false);
		expect(firstCalls.at(-1)!.expanded).toBe(true);
		expect(firstCalls.at(-1)!.showImages).toBe(true);
		expect(firstCalls.at(-1)!.isError).toBe(false);
		expect(firstCalls.at(-1)!.cwd).toBe("/tmp/compat-cwd-first");

		const firstResults = firstObservations.filter((entry) => entry.slot === "result");
		expect(firstResults).toHaveLength(4);
		expect(firstResults[0]!.lastComponent).toBeUndefined();
		for (let index = 1; index < firstResults.length; index++) {
			expect(firstResults[index]!.lastComponent).toBe(firstResults[index - 1]!.component);
		}

		expect(firstResults[0]!.options).toEqual({ expanded: false, isPartial: true });
		expect(firstResults[0]!.result).toEqual({
			content: [{ type: "text", text: "partial" }],
			details: { step: 1 },
		});
		expect(firstResults[0]!.isPartial).toBe(true);
		expect(firstResults[0]!.isError).toBe(true);

		expect(firstResults.at(-1)!.options).toEqual({ expanded: true, isPartial: false });
		expect(firstResults.at(-1)!.result).toEqual({
			content: [{ type: "text", text: "final" }],
			details: { step: 2 },
		});
		expect(firstResults.at(-1)!.isError).toBe(false);
		expect(firstResults.at(-1)!.cwd).toBe("/tmp/compat-cwd-first");
		expect(secondCallsAfterConstruct[0]!.cwd).toBe("/tmp/compat-cwd-second");
		expect(secondCallsAfterConstruct[0]!.toolCallId).toBe("second-call");
	});
});
