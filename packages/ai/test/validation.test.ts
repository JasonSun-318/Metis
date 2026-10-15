import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		} as Tool["parameters"],
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it.each([false, true])(
		"parses nested JSON containers against their schema (serialized schema: %s)",
		(serialized) => {
			const schema = Type.Object(
				{
					action: Type.Union([
						Type.Object(
							{
								type: Type.Literal("click"),
								target: Type.Object({ elementId: Type.String() }, { additionalProperties: false }),
							},
							{ additionalProperties: false },
						),
						Type.Object({ type: Type.Literal("press"), key: Type.String() }, { additionalProperties: false }),
					]),
					rows: Type.Array(Type.Object({ text: Type.String() })),
				},
				{ additionalProperties: false },
			);
			const parameters = serialized ? JSON.parse(JSON.stringify(schema)) : schema;
			const { tool, toolCall } = createToolCallWithPlainSchema(parameters, {
				action: JSON.stringify({ type: "click", target: JSON.stringify({ elementId: "e44" }) }),
				rows: JSON.stringify([{ text: '{"keep":"as text"}' }]),
			});
			const original = structuredClone(toolCall.arguments);
			expect(validateToolArguments(tool, toolCall)).toEqual({
				value: {
					action: { type: "click", target: { elementId: "e44" } },
					rows: [{ text: '{"keep":"as text"}' }],
				},
			});
			expect(toolCall.arguments).toEqual(original);
		},
	);

	it("preserves JSON-looking strings when a union accepts strings", () => {
		const schema = Type.Union([Type.Object({ text: Type.String() }), Type.String()]);
		const value = '{"text":"keep me as a string"}';
		const { tool, toolCall } = createToolCallWithPlainSchema(schema, value);
		expect(validateToolArguments(tool, toolCall)).toEqual({ value });
	});

	it.each(['{"type":"click"', '{"type":"click","extra":true}', '{"type":"unknown"}', "[]", "null"])(
		"rejects invalid encoded objects: %s",
		(value) => {
			const schema = Type.Object({ type: Type.Literal("click") }, { additionalProperties: false });
			const { tool, toolCall } = createToolCallWithPlainSchema(schema, value);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		},
	);

	it("reports repeated union validation errors once while preserving distinct paths", () => {
		const schema = Type.Object({
			action: Type.Union([Type.Object({ click: Type.String() }), Type.Object({ press: Type.String() })]),
			count: Type.Integer(),
		});
		const { tool, toolCall } = createToolCallWithPlainSchema(schema, { action: "invalid JSON", count: "invalid" });
		let message = "";
		try {
			validateToolArguments(tool, toolCall);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message.match(/value\.action: must be object/g)).toHaveLength(1);
		expect(message).toContain("value.count");
		expect(message).toContain("Received arguments");
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
			{ schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
			{ schema: { type: "string" } as Tool["parameters"], input: null, expected: "" },
			{ schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
			{ schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
			{
				schema: { type: ["number", "string"] } as Tool["parameters"],
				input: "1",
				expected: "1",
			},
			{
				schema: { type: ["boolean", "number"] } as Tool["parameters"],
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1" },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0" },
			{ schema: { type: "null" } as Tool["parameters"], input: "null" },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});
});
