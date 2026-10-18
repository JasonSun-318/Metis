import type { AgentMessage, AgentToolResult } from "@metis/agent-core";
import type { Component } from "@metis/tui";
import type { Static, TSchema } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import type { AgentSession, SessionManager, ToolDefinition } from "../src/host.ts";
import type {
	AgentSessionConfig,
	PromptOptions,
	AgentSession as RootAgentSession,
	SessionManager as RootSessionManager,
	ToolDefinition as RootToolDefinition,
	SessionContext,
	SessionStats,
	SessionTreeNode,
	ToolInfo,
	ToolRenderResultOptions,
} from "../src/index.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

describe("coding-agent public type contracts", () => {
	it("keeps host re-exports aligned with the root session and tool-definition surfaces", () => {
		expectTypeOf<AgentSession>().toEqualTypeOf<RootAgentSession>();
		expectTypeOf<SessionManager>().toEqualTypeOf<RootSessionManager>();
		expectTypeOf<ToolDefinition>().toEqualTypeOf<RootToolDefinition>();
	});

	it("keeps tool render contracts explicit", () => {
		expectTypeOf<ToolRenderResultOptions>().toEqualTypeOf<{ expanded: boolean; isPartial: boolean }>();
		expectTypeOf<ToolDefinition["renderCall"]>().toEqualTypeOf<
			| ((args: Static<TSchema>, theme: Theme, context: ToolRenderContext<any, Static<TSchema>>) => Component)
			| undefined
		>();
		expectTypeOf<ToolDefinition["renderResult"]>().toEqualTypeOf<
			| ((
					result: AgentToolResult<unknown>,
					options: ToolRenderResultOptions,
					theme: Theme,
					context: ToolRenderContext<any, Static<TSchema>>,
			  ) => Component)
			| undefined
		>();
		expectTypeOf<ToolInfo>().toMatchObjectType<{
			name: string;
			description: string;
			parameters: TSchema;
			promptGuidelines?: string[];
			sourceInfo: SourceInfo;
		}>();
	});

	it("keeps session prompt, context and stats contracts explicit", () => {
		expectTypeOf<AgentSession["prompt"]>().toEqualTypeOf<(text: string, options?: PromptOptions) => Promise<void>>();
		expectTypeOf<AgentSessionConfig["cwd"]>().toEqualTypeOf<string>();
		expectTypeOf<SessionManager["buildSessionContext"]>().toEqualTypeOf<() => SessionContext>();
		expectTypeOf<SessionManager["getTree"]>().toEqualTypeOf<() => SessionTreeNode[]>();
		expectTypeOf<SessionContext>().toEqualTypeOf<{
			messages: AgentMessage[];
			thinkingLevel: string;
			model: { provider: string; modelId: string } | null;
		}>();
		expectTypeOf<SessionStats["tokens"]>().toEqualTypeOf<{
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		}>();
	});

	it("rejects stale render and session fields", () => {
		// @ts-expect-error ToolRenderResultOptions requires isPartial.
		const options: ToolRenderResultOptions = { expanded: true };
		// @ts-expect-error SessionContext requires messages.
		const context: SessionContext = { thinkingLevel: "off", model: null };
		expect(options.expanded).toBe(true);
		expect(context.thinkingLevel).toBe("off");
	});
});
