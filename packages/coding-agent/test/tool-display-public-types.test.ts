import type { AgentToolResult } from "@metis/agent-core";
import type { Component, TUI } from "@metis/tui";
import { Text } from "@metis/tui";
import { type Static, Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ToolDefinition as OldToolDefinition, ToolRenderContext } from "../src/core/extensions/types.ts";
import type { ToolDefinition as HostToolDefinition } from "../src/host.ts";
import {
	type ToolDefinition as RootToolDefinition,
	ToolExecutionComponent as RootToolExecutionComponent,
	type ToolExecutionOptions as RootToolExecutionOptions,
	type ToolRenderResultOptions as RootToolRenderResultOptions,
} from "../src/index.ts";
import { ToolExecutionComponent as OldToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const params = Type.Object({
	prompt: Type.String(),
	retries: Type.Optional(Type.Number()),
});

type Params = typeof params;
type Details = { changes: string[] };
type State = { calls: number };

const oldDefinition: OldToolDefinition<Params, Details, State> = {
	name: "typed_tool",
	label: "Typed tool",
	description: "A typed fixture tool.",
	parameters: params,
	permission: {
		version: 1,
		describe: () => ({
			readPaths: [],
			writePaths: [],
			networkEndpoints: [],
			effects: [],
		}),
	},
	execute: async () => ({ content: [], details: { changes: [] } }),
	renderCall(args, _theme, context) {
		expectTypeOf(args).toEqualTypeOf<Static<Params>>();
		expectTypeOf(args.prompt).toEqualTypeOf<string>();
		expectTypeOf(args.retries).toEqualTypeOf<number | undefined>();
		expectTypeOf(context).toEqualTypeOf<ToolRenderContext<State, Static<Params>>>();
		expectTypeOf(context.args).toEqualTypeOf<Static<Params>>();
		expectTypeOf(context.state).toEqualTypeOf<State>();
		expectTypeOf(context.cwd).toEqualTypeOf<string>();
		return new Text(args.prompt, 0, 0);
	},
	renderResult(result, options, _theme, context) {
		expectTypeOf(result).toEqualTypeOf<AgentToolResult<Details>>();
		expectTypeOf(result.details).toEqualTypeOf<Details>();
		expectTypeOf(options).toEqualTypeOf<RootToolRenderResultOptions>();
		expectTypeOf(context.state).toEqualTypeOf<State>();
		expectTypeOf(context.isPartial).toEqualTypeOf<boolean>();
		return new Text(result.details.changes.join(","), 0, 0);
	},
};

function acceptsRootDefinition(definition: RootToolDefinition<Params, Details, State>): void {
	type RootCall = NonNullable<RootToolDefinition<Params, Details, State>["renderCall"]>;
	type RootResult = NonNullable<RootToolDefinition<Params, Details, State>["renderResult"]>;

	expectTypeOf<Parameters<RootCall>[0]>().toEqualTypeOf<Static<Params>>();
	expectTypeOf<Parameters<RootCall>[1]>().toEqualTypeOf<Theme>();
	expectTypeOf<Parameters<RootCall>[2]>().toEqualTypeOf<ToolRenderContext<State, Static<Params>>>();
	expectTypeOf<ReturnType<RootCall>>().toEqualTypeOf<Component>();

	expectTypeOf<Parameters<RootResult>[0]>().toEqualTypeOf<AgentToolResult<Details>>();
	expectTypeOf<Parameters<RootResult>[1]>().toEqualTypeOf<RootToolRenderResultOptions>();
	expectTypeOf<Parameters<RootResult>[2]>().toEqualTypeOf<Theme>();
	expectTypeOf<Parameters<RootResult>[3]>().toEqualTypeOf<ToolRenderContext<State, Static<Params>>>();
	expectTypeOf<ReturnType<RootResult>>().toEqualTypeOf<Component>();

	expect(definition.name).toBe("typed_tool");
}

describe("ToolExecutionComponent public type contracts", () => {
	it("keeps the old and root component constructors and update methods callable", () => {
		expect(RootToolExecutionComponent).toBe(OldToolExecutionComponent);

		type ConstructorArgs = ConstructorParameters<typeof RootToolExecutionComponent>;
		expectTypeOf<ConstructorArgs[0]>().toEqualTypeOf<string>();
		expectTypeOf<ConstructorArgs[1]>().toEqualTypeOf<string>();
		expectTypeOf<ConstructorArgs[2]>().toEqualTypeOf<any>();
		expectTypeOf<ConstructorArgs[3]>().toEqualTypeOf<RootToolExecutionOptions | undefined>();
		expectTypeOf<ConstructorArgs[4]>().toEqualTypeOf<RootToolDefinition<any, any> | undefined>();
		expectTypeOf<ConstructorArgs[5]>().toEqualTypeOf<TUI>();
		expectTypeOf<ConstructorArgs[6]>().toEqualTypeOf<string>();

		const constructorArgs: ConstructorArgs = [
			"typed_tool",
			"typed-call",
			{ prompt: "hello" },
			{ showImages: false, imageWidthCells: 24 },
			oldDefinition,
			null as unknown as TUI,
			"/tmp/typed-cwd",
		];
		expect(constructorArgs[0]).toBe("typed_tool");
		expect(constructorArgs[6]).toBe("/tmp/typed-cwd");

		// @ts-expect-error the public constructor requires a working directory at the end.
		const missingCwd: ConstructorArgs = [
			"typed_tool",
			"typed-call",
			{ prompt: "hello" },
			{},
			oldDefinition,
			null as unknown as TUI,
		];
		expect(missingCwd).toHaveLength(6);

		type ResultPayload = {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		};

		expectTypeOf<OldToolExecutionComponent["updateArgs"]>().toEqualTypeOf<(args: any) => void>();
		expectTypeOf<OldToolExecutionComponent["updateResult"]>().toEqualTypeOf<
			(result: ResultPayload, isPartial?: boolean) => void
		>();
		expectTypeOf<OldToolExecutionComponent["markExecutionStarted"]>().toEqualTypeOf<() => void>();
		expectTypeOf<OldToolExecutionComponent["setArgsComplete"]>().toEqualTypeOf<() => void>();
		expectTypeOf<OldToolExecutionComponent["setExpanded"]>().toEqualTypeOf<(expanded: boolean) => void>();
		expectTypeOf<OldToolExecutionComponent["setShowImages"]>().toEqualTypeOf<(show: boolean) => void>();
		expectTypeOf<OldToolExecutionComponent["setImageWidthCells"]>().toEqualTypeOf<(width: number) => void>();
		expectTypeOf<OldToolExecutionComponent["render"]>().toEqualTypeOf<(width: number) => string[]>();
		expectTypeOf<RootToolExecutionComponent["updateResult"]>().toEqualTypeOf<
			OldToolExecutionComponent["updateResult"]
		>();

		// @ts-expect-error updateResult requires the public result discriminator.
		const missingIsError: ResultPayload = { content: [] };
		expect(missingIsError.content).toEqual([]);

		// @ts-expect-error isPartial is an optional boolean.
		const invalidIsPartial: Parameters<OldToolExecutionComponent["updateResult"]>[1] = "yes";
		expect(invalidIsPartial).toBe("yes");

		// @ts-expect-error imageWidthCells is a number.
		const invalidOptions: RootToolExecutionOptions = { imageWidthCells: "24" };
		expect(invalidOptions.imageWidthCells).toBe("24");
	});

	it("preserves typed renderer argument, result, and state generics through root and old paths", () => {
		const rootDefinition: RootToolDefinition<Params, Details, State> = oldDefinition;
		const hostDefinition: HostToolDefinition<Params, Details, State> = rootDefinition;
		acceptsRootDefinition(rootDefinition);
		expect(rootDefinition).toBe(oldDefinition);
		expect(hostDefinition).toBe(oldDefinition);

		type RootCall = NonNullable<RootToolDefinition<Params, Details, State>["renderCall"]>;
		type RootResult = NonNullable<RootToolDefinition<Params, Details, State>["renderResult"]>;
		type OldCall = NonNullable<OldToolDefinition<Params, Details, State>["renderCall"]>;
		expectTypeOf<RootCall>().toEqualTypeOf<OldCall>();
		expectTypeOf<Parameters<RootResult>[0]>().toEqualTypeOf<AgentToolResult<Details>>();
		expectTypeOf<Parameters<RootResult>[3]>().toEqualTypeOf<ToolRenderContext<State, Static<Params>>>();
	});
});
