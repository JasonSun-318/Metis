import type { ThinkingLevel } from "@arcmind/agent-core";
import { Text } from "@arcmind/tui";
import { Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { AgentSession } from "../agent-session.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import type { SubagentManager } from "./manager.ts";
import { type ActivateSubagentsResult, SUBAGENT_ACTIVATION_TOOL_NAME } from "./types.ts";

const REAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const Activate = Type.Object({}, { additionalProperties: false });

const Spawn = Type.Object(
	{
		name: Type.String({
			minLength: 1,
			maxLength: 128,
			description: "Unique short name for this child within the parent session.",
		}),
		task: Type.String({
			minLength: 1,
			maxLength: 2 * 1024 * 1024,
			description:
				"Self-contained assignment with the objective, owned scope, non-goals, expected handoff, and focused verification.",
		}),
		tools: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
			maxItems: 128,
			uniqueItems: true,
			description: "Minimum subset of the parent's active tools required for the assignment.",
		}),
		role: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 8 * 1024,
				description: "Optional subordinate role guidance encoded as assignment data.",
			}),
		),
		developerInstructions: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 64 * 1024,
				description: "Optional assignment constraints subordinate to the runtime-owned child contract.",
			}),
		),
		permissionMode: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("auto"), Type.Literal("full")], {
				description:
					"Optional child permission mode; cannot be broader than the parent and defaults to the parent mode.",
			}),
		),
		model: Type.Optional(
			Type.String({
				pattern: "^[^/]+/[^/]+$",
				description: "Optional provider/modelId; defaults to the parent's current model.",
			}),
		),
		thinkingLevel: Type.Optional(
			Type.Union(
				REAL_THINKING_LEVELS.map((level) => Type.Literal(level)),
				{
					description:
						"Optional supported real thinking level; defaults to the parent's actual real thinking level.",
				},
			),
		),
		cwd: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Working directory used for relative path resolution; it grants no read or write authority.",
			}),
		),
		readPaths: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 32,
				uniqueItems: true,
				description: "Project directories the child may read; defaults to [cwd].",
			}),
		),
		writePaths: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 32,
				uniqueItems: true,
				description:
					"Project directories the child may write; each must be inside a read path and the list defaults to [cwd].",
			}),
		),
		forkTurns: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: 1_000 }), Type.Literal("all")], {
				description: 'Number of visible parent turns to copy, or "all"; omit to copy none.',
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 1_800,
				description: "Maximum runtime in seconds, from 1 through 1800.",
			}),
		),
	},
	{ additionalProperties: false },
);

const Inspect = Type.Object(
	{
		agentId: Type.Optional(Type.String({ minLength: 1, description: "Owned child ID; omit to list all children." })),
		beforeEntryId: Type.Optional(
			Type.String({ minLength: 1, description: "Durable journal cursor; returns entries before this ID." }),
		),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 100, description: "Maximum results to return; defaults to 20." }),
		),
	},
	{ additionalProperties: false },
);

const Message = Type.Object(
	{
		agentId: Type.String({ minLength: 1, description: "Owned child ID." }),
		mode: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")], {
			description: "Use steer for a running child or follow_up to queue or resume work.",
		}),
		message: Type.String({
			minLength: 1,
			maxLength: 2 * 1024 * 1024,
			description: "New bounded instructions for the child.",
		}),
	},
	{ additionalProperties: false },
);

const Wait = Type.Object(
	{
		agentIds: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				maxItems: 10,
				uniqueItems: true,
				description: "Owned child IDs to wait for; omit to wait for any live owned child.",
			}),
		),
	},
	{ additionalProperties: false },
);

const AgentId = Type.Object(
	{ agentId: Type.String({ minLength: 1, description: "Owned child ID." }) },
	{ additionalProperties: false },
);
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
	if (details.activated === true) {
		return details.alreadyActivated === true ? "Subagents already active" : "Subagents activated";
	}
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
	activateSubagents(): ActivateSubagentsResult;
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
			name: SUBAGENT_ACTIVATION_TOOL_NAME,
			label: "Activate subagents",
			description:
				"Enable subagent tools for a complex task when the work can be divided into independent, bounded assignments or requires broad multi-file exploration. Call this once before the first delegation. Do not use it for simple tasks, known-location lookups, or work that must be completed sequentially. After activation, use spawn_agent and avoid duplicating delegated work.",
			promptSnippet: "Enable subagents for complex work that can be delegated independently",
			parameters: Activate,
			executionMode: "sequential",
			renderResult: renderSubagentResult,
			async execute() {
				requireUltra();
				return result(host.activateSubagents());
			},
		}),
		defineTool({
			name: "spawn_agent",
			label: "Spawn agent",
			description:
				"Create one child agent for independent, bounded work. Use a unique name, a self-contained task, the minimum necessary tools, and narrow read/write roots.",
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
			description:
				"List owned child agents or inspect one child's recent durable activity. Use it to verify handoffs or inspect state; do not poll running agents.",
			parameters: Inspect,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				return result(await manager().inspect(params));
			},
		}),
		defineTool({
			name: "message_agent",
			label: "Message agent",
			description:
				"Steer a running child or send a follow-up that resumes a completed, failed, or stopped child. Reuse an existing child when its responsibility has not changed.",
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
				"Wait only when the next step depends on a new terminal event and no useful independent work remains. Completion notifications arrive automatically; do not poll.",
			parameters: Wait,
			renderResult: renderSubagentResult,
			async execute(_id, params, signal) {
				return result(await manager().wait(params, signal));
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt agent",
			description: "Stop queued or running child work while preserving its session for later follow-up.",
			parameters: AgentId,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				return result(await manager().interrupt(params.agentId));
			},
		}),
		defineTool({
			name: "close_agent",
			label: "Close agent",
			description:
				"Permanently delete a child session after its transcript and follow-up history are no longer needed.",
			parameters: AgentId,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				return result(await manager().close(params.agentId));
			},
		}),
	];
}
