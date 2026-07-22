import type { ThinkingLevel } from "@arcmind/agent-core";
import { Text } from "@arcmind/tui";
import { Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { AgentSession } from "../agent-session.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import type { SubagentManager } from "./manager.ts";

const RealThinkingLevel = Type.Union(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)),
);

const Spawn = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128 }),
		task: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
		tools: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 128, uniqueItems: true }),
		role: Type.Optional(Type.String({ minLength: 1, maxLength: 8 * 1024 })),
		developerInstructions: Type.Optional(Type.String({ minLength: 1, maxLength: 64 * 1024 })),
		permissionMode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("auto"), Type.Literal("full")])),
		model: Type.Optional(Type.String({ pattern: "^[^/]+/[^/]+$" })),
		thinkingLevel: Type.Optional(RealThinkingLevel),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		readPaths: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32, uniqueItems: true }),
		),
		writePaths: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32, uniqueItems: true }),
		),
		forkTurns: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 1_000 }), Type.Literal("all")])),
		timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_800 })),
	},
	{ additionalProperties: false },
);

const Inspect = Type.Object(
	{
		agentId: Type.Optional(Type.String({ minLength: 1 })),
		beforeEntryId: Type.Optional(Type.String({ minLength: 1 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);

const Message = Type.Object(
	{
		agentId: Type.String({ minLength: 1 }),
		mode: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
		message: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
	},
	{ additionalProperties: false },
);

const Wait = Type.Object(
	{
		agentIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10, uniqueItems: true })),
	},
	{ additionalProperties: false },
);

const AgentId = Type.Object({ agentId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const COMPACT_AGENT_LIMIT = 5;
const COMPACT_TEXT_LINES = 10;
const COMPACT_TEXT_CHARS = 2_000;

function result(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
		...(isError ? { isError: true } : {}),
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function agentSummary(value: unknown): string | undefined {
	const agent = record(value);
	if (!agent) return undefined;
	const name = typeof agent.name === "string" ? agent.name : undefined;
	const agentId = typeof agent.agentId === "string" ? agent.agentId : undefined;
	const status = typeof agent.status === "string" ? agent.status : undefined;
	const label = name && agentId ? `${name} (${agentId})` : (name ?? agentId ?? "Agent");
	return status ? `${label} · ${status}` : label;
}

function compactResult(value: unknown): string {
	const details = record(value);
	if (!details) return "Completed";
	if (Array.isArray(details.agents)) {
		const summaries = details.agents.map(agentSummary).filter((line): line is string => line !== undefined);
		if (summaries.length === 0) return "No agents";
		const lines = summaries.slice(0, COMPACT_AGENT_LIMIT);
		if (summaries.length > lines.length) lines.push(`… ${summaries.length - lines.length} more`);
		if (Array.isArray(details.journal)) lines[lines.length - 1] += ` · ${details.journal.length} recent entries`;
		return lines.join("\n");
	}
	if (Array.isArray(details.updatedAgentIds)) {
		const ids = details.updatedAgentIds.filter((id): id is string => typeof id === "string");
		return ids.length > 0 ? `Updated: ${ids.join(", ")}` : "No live agents";
	}
	const summary = agentSummary(details);
	const suffix = [details.delivery, details.reason]
		.filter((part): part is string => typeof part === "string")
		.join(" · ");
	return suffix ? `${summary ?? "Completed"} · ${suffix}` : (summary ?? "Completed");
}

function textResult(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function compactTextResult(
	result: { content: readonly { type: string; text?: string }[] },
	emptyOutput: "Completed" | "Failed",
): string {
	const output = textResult(result);
	if (!output) return emptyOutput;
	const characterPreview = output.slice(0, COMPACT_TEXT_CHARS);
	const lines = characterPreview.split("\n");
	const preview = lines.slice(0, COMPACT_TEXT_LINES).join("\n");
	return output.length > characterPreview.length || lines.length > COMPACT_TEXT_LINES ? `${preview}\n…` : preview;
}

function fullResult(result: { content: readonly { type: string; text?: string }[]; details?: unknown }): string {
	return result.details !== undefined ? JSON.stringify(result.details, null, 2) : textResult(result);
}

const renderSubagentResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, context) => {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const output = options.expanded
		? fullResult(result)
		: context.isError || result.details === undefined
			? compactTextResult(result, context.isError ? "Failed" : "Completed")
			: compactResult(result.details);
	text.setText(
		options.expanded
			? theme.fg("toolOutput", output)
			: `${theme.fg("toolOutput", output)} ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
	);
	return text;
};

export interface SubagentToolHost {
	getManager(): SubagentManager | undefined;
	getSession(): AgentSession;
}

export function createSubagentTools(host: SubagentToolHost): ToolDefinition[] {
	const manager = (): SubagentManager => {
		const value = host.getManager();
		if (!value) throw new Error("Subagent manager is unavailable");
		return value;
	};
	const requireUltra = (): void => {
		if (host.getSession().getThinkingSelection() !== "ultra")
			throw new Error("Ultra is required for this subagent operation");
	};
	return [
		defineTool({
			name: "spawn_agent",
			label: "Spawn agent",
			description: "Create one isolated child agent for independent bounded work. Requires Ultra.",
			parameters: Spawn,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				requireUltra();
				return result(
					await manager().spawn({ ...params, thinkingLevel: params.thinkingLevel as ThinkingLevel | undefined }),
				);
			},
		}),
		defineTool({
			name: "inspect_agents",
			label: "Inspect agents",
			description: "List child summaries or inspect one owned child's recent durable activity.",
			parameters: Inspect,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				return result(await manager().inspect(params));
			},
		}),
		defineTool({
			name: "message_agent",
			label: "Message agent",
			description: "Steer a running child or queue a follow-up that resumes a cold child. Requires Ultra.",
			parameters: Message,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				requireUltra();
				return result(await manager().message(params));
			},
		}),
		defineTool({
			name: "wait_agents",
			label: "Wait for agents",
			description:
				"Wait only when the next critical step depends on a new child terminal event and no useful independent work remains. Completed children notify automatically; do not poll. Returns IDs, never transcripts.",
			parameters: Wait,
			renderResult: renderSubagentResult,
			async execute(_id, params, signal) {
				return result(await manager().wait(params, signal));
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt agent",
			description: "Stop queued or running child work while preserving its recoverable session.",
			parameters: AgentId,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				return result(await manager().interrupt(params.agentId));
			},
		}),
		defineTool({
			name: "close_agent",
			label: "Close agent",
			description: "Permanently delete one child session and retain only its parent tombstone.",
			parameters: AgentId,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				return result(await manager().close(params.agentId));
			},
		}),
	];
}
