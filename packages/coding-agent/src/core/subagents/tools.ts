import { Text } from "@metis/tui";
import { Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { AgentSession } from "../agent-session.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import type { SubagentManager } from "./manager.ts";
import { AGENT_TYPES, type InspectAgentsResult } from "./types.ts";

function actorId(session: AgentSession): string {
	return session.sessionManager.getSessionId();
}

const AgentTypeLiteral = Type.Union(AGENT_TYPES.map((agentType) => Type.Literal(agentType)));

const Spawn = Type.Object(
	{
		name: Type.String({
			minLength: 1,
			maxLength: 128,
			description:
				"Unique human-readable 3-5 word session title for this child; describe its responsibility, not its first instruction.",
		}),
		task: Type.String({
			minLength: 1,
			maxLength: 2 * 1024 * 1024,
			description:
				"Self-contained assignment with the objective, owned scope, non-goals, expected handoff, and focused verification.",
		}),
		agentType: Type.Optional(
			Type.Union([AgentTypeLiteral], {
				description: "Optional built-in role; defaults to default when omitted.",
			}),
		),
		forkTurns: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: 1_000 }), Type.Literal("all")], {
				description: 'Number of your visible turns to copy, or "all"; omit to copy none.',
			}),
		),
		model: Type.Optional(
			Type.String({
				pattern: "^[^/]+/[^/]+$",
				description: "Optional provider/modelId; defaults to your current model.",
			}),
		),
	},
	{ additionalProperties: false },
);

const Inspect = Type.Object(
	{
		agentId: Type.Optional(Type.String({ minLength: 1, description: "Owned child ID; omit to list all children." })),
		taskId: Type.Optional(Type.String({ minLength: 1, description: "Task history entry to inspect." })),
		beforeEventId: Type.Optional(
			Type.String({ minLength: 1, description: "Visible activity cursor; returns older events." }),
		),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 100, description: "Maximum results to return; defaults to 20." }),
		),
	},
	{ additionalProperties: false },
);

const SendMessage = Type.Object(
	{
		agentId: Type.String({ minLength: 1, description: "Owned child ID." }),
		message: Type.String({
			minLength: 1,
			maxLength: 2 * 1024 * 1024,
			description: "New bounded instructions for the running task.",
		}),
	},
	{ additionalProperties: false },
);

const FollowUp = Type.Object(
	{
		agentId: Type.String({ minLength: 1, description: "Owned child ID." }),
		task: Type.String({
			minLength: 1,
			maxLength: 2 * 1024 * 1024,
			description: "Self-contained follow-up assignment that always creates a new task.",
		}),
	},
	{ additionalProperties: false },
);

const Wait = Type.Object(
	{
		agentIds: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			maxItems: 8,
			uniqueItems: true,
			description: "One through eight owned child IDs to watch.",
		}),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 10,
				maximum: 300_000,
				description: "Wait timeout in milliseconds; defaults to 30000.",
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

function result(value: unknown, isError = false, content = JSON.stringify(value, null, 2)) {
	return {
		content: [{ type: "text" as const, text: content }],
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

function inspectText(inspected: InspectAgentsResult): string {
	if (inspected.kind === "list") {
		if (inspected.agents.length === 0) return "No agent sessions.";
		return inspected.agents
			.map((agent) => {
				const task = agent.currentTask ?? agent.latestTask;
				return `Agent ${JSON.stringify(agent.name)} (${agent.agentId}) · ${agent.agentType} · ${agent.status}${
					task ? `\nTask ${task.taskId} · ${task.taskSummary}` : ""
				}`;
			})
			.join("\n");
	}
	const events = inspected.events.map((event) => {
		if (event.kind === "tool") return `[Tool ${event.status}] ${event.toolName}`;
		if (event.kind === "final") return `[Final] ${event.text}`;
		return `[LLM] ${event.text}`;
	});
	return [`Agent ${inspected.agent.name} (${inspected.agent.agentId})`, "", ...events].join("\n");
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
	return [
		defineTool({
			name: "spawn_agent",
			label: "Spawn agent",
			description:
				"Create one child agent for independent, bounded work. Use a unique name, a self-contained task, and the narrowest fitting agent type.",
			parameters: Spawn,
			renderResult: renderSubagentResult,
			async execute(_id, params, signal) {
				const actor = actorId(host.getSession());
				const receipt = await manager().spawn(
					actor,
					{
						name: params.name,
						task: params.task,
						agentType: params.agentType,
						forkTurns: params.forkTurns,
						model: params.model,
					},
					signal,
				);
				return result(receipt);
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
				const inspected = await manager().inspect(actorId(host.getSession()), {
					agentId: params.agentId,
					taskId: params.taskId,
					beforeEventId: params.beforeEventId,
					limit: params.limit,
				});
				return result(inspected, false, inspectText(inspected));
			},
		}),
		defineTool({
			name: "send_message",
			label: "Send message",
			description: "Steer a running child task without creating a new task.",
			parameters: SendMessage,
			renderResult: renderSubagentResult,
			async execute(_id, params, signal) {
				signal?.throwIfAborted();
				return result(
					await manager().sendMessage(actorId(host.getSession()), {
						agentId: params.agentId,
						message: params.message,
					}),
					false,
				);
			},
		}),
		defineTool({
			name: "followup_task",
			label: "Follow up task",
			description: "Queue a new bounded task for an existing child agent.",
			parameters: FollowUp,
			renderResult: renderSubagentResult,
			async execute(_id, params, signal) {
				const actor = actorId(host.getSession());
				const receipt = await manager().followUpTask(actor, { agentId: params.agentId, task: params.task }, signal);
				return result(receipt);
			},
		}),
		defineTool({
			name: "wait_agents",
			label: "Wait for agents",
			description:
				"Wait only when the next critical step depends on a new child terminal event or approval and no useful independent work remains. Completed children notify automatically; do not poll. Returns IDs, never transcripts.",
			parameters: Wait,
			renderResult: renderSubagentResult,
			async execute(_id, params, signal) {
				const session = host.getSession();
				const waited = await manager().waitAgents(actorId(session), params, signal);
				session.stageAgentMailboxDelivery(waited.mailboxEventIds);
				return result(waited);
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt agent",
			description: "Stop queued or running child work while preserving its session for later follow-up.",
			parameters: AgentId,
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				return result(await manager().interrupt(actorId(host.getSession()), params.agentId));
			},
		}),
	];
}
