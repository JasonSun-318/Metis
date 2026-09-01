import { Text } from "@metis/tui";
import { Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { AgentSession } from "../agent-session.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { permissionClaim, permissionDescriptor } from "../tool-permission-adapter.ts";
import type { SubagentManager } from "./manager.ts";
import { utf8Prefix } from "./trace.ts";
import { type InspectAgentsResult, MAX_AGENT_INPUT_UTF8_BYTES } from "./types.ts";
import { terminalEventIdentity } from "./wait.ts";

function actorId(session: AgentSession): string {
	return session.sessionManager.getSessionId();
}

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
			maxLength: MAX_AGENT_INPUT_UTF8_BYTES,
			description:
				"Self-contained assignment with the objective, owned scope, non-goals, expected handoff, and focused verification.",
		}),
		agentType: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 64,
				pattern: "^[a-z][a-z0-9-]{0,63}$",
				description:
					"Optional role id: a built-in role (default, explorer, worker, reviewer) or a configured custom role. The agent_coordination prompt lists every available role with its tool, write, and delegation capabilities. Defaults to default.",
			}),
		),
		forkTurns: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1, maximum: 1_000 }), Type.Literal("all")], {
				description: 'Number of your visible turns to copy, or "all"; omit to copy none.',
			}),
		),
		model: Type.Optional(
			Type.String({
				maxLength: 512,
				pattern: "^[^/\\s]+/\\S+$",
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
			maxLength: MAX_AGENT_INPUT_UTF8_BYTES,
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
			maxLength: MAX_AGENT_INPUT_UTF8_BYTES,
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
				const usage = agent.tasks.reduce(
					(total, task) => ({
						input: total.input + (task.usage?.input ?? 0),
						output: total.output + (task.usage?.output ?? 0),
						toolCalls: total.toolCalls + (task.usage?.toolCalls ?? 0),
					}),
					{ input: 0, output: 0, toolCalls: 0 },
				);
				const lines = [
					`Agent ${JSON.stringify(agent.name)} (${agent.agentId}) · ${agent.agentType} · ${agent.status}`,
					`Relation parent=${agent.parentSessionId} depth=${agent.depth} · updated=${agent.updatedAt}`,
					`Capabilities tools=[${agent.tools.join(", ")}] · writes=${agent.writePolicy} · delegation=${agent.mayDelegate ? "allowed" : "denied"}`,
				];
				if (agent.currentTask) {
					lines.push(
						`Current task ${agent.currentTask.taskId} · ${agent.currentTask.status} · ${agent.currentTask.taskSummary}`,
					);
				}
				if (agent.latestTask && agent.latestTask.taskId !== agent.currentTask?.taskId) {
					lines.push(
						`Latest task ${agent.latestTask.taskId} · ${agent.latestTask.status} · ${agent.latestTask.taskSummary}`,
					);
				}
				lines.push(`Usage input=${usage.input} output=${usage.output} toolCalls=${usage.toolCalls}`);
				return lines.join("\n");
			})
			.join("\n\n");
	}
	const events = inspected.events.map((event) => {
		if (event.kind === "tool") return `[Tool ${event.status}] ${event.toolName}`;
		if (event.kind === "final") return `[Final] ${event.text}`;
		return `[LLM] ${event.text}`;
	});
	const task = inspected.agent.tasks.find((candidate) => candidate.taskId === inspected.taskId);
	return [
		`Agent ${inspected.agent.name} (${inspected.agent.agentId})`,
		`Capabilities tools=[${inspected.agent.tools.join(", ")}] · writes=${inspected.agent.writePolicy} · delegation=${inspected.agent.mayDelegate ? "allowed" : "denied"}`,
		`Task ${inspected.taskId}${task ? ` · ${task.status}` : ""}`,
		...(inspected.nextBeforeEventId ? [`Next before event ${inspected.nextBeforeEventId}`] : []),
		"",
		...events,
	].join("\n");
}

function inspectDetails(inspected: InspectAgentsResult): unknown {
	if (inspected.kind === "trace") {
		const task = inspected.agent.tasks.find((candidate) => candidate.taskId === inspected.taskId);
		return {
			kind: "trace",
			agent: {
				agentId: inspected.agent.agentId,
				name: inspected.agent.name,
				agentType: inspected.agent.agentType,
				status: inspected.agent.status,
				depth: inspected.agent.depth,
				parentSessionId: inspected.agent.parentSessionId,
				tools: inspected.agent.tools,
				writePolicy: inspected.agent.writePolicy,
				mayDelegate: inspected.agent.mayDelegate,
			},
			taskId: inspected.taskId,
			...(task
				? {
						task: {
							taskId: task.taskId,
							status: task.status,
							taskSummary: task.taskSummary,
							updatedAt: task.updatedAt,
						},
					}
				: {}),
			events: inspected.events,
			...(inspected.nextBeforeEventId ? { nextBeforeEventId: inspected.nextBeforeEventId } : {}),
		};
	}
	return {
		kind: "list",
		agents: inspected.agents.map((agent) => {
			const usage = agent.tasks.reduce(
				(total, task) => ({
					input: total.input + (task.usage?.input ?? 0),
					output: total.output + (task.usage?.output ?? 0),
					cacheRead: total.cacheRead + (task.usage?.cacheRead ?? 0),
					cacheWrite: total.cacheWrite + (task.usage?.cacheWrite ?? 0),
					elapsedMs: total.elapsedMs + (task.usage?.elapsedMs ?? 0),
					toolCalls: total.toolCalls + (task.usage?.toolCalls ?? 0),
				}),
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, elapsedMs: 0, toolCalls: 0 },
			);
			const compactTask = (task: typeof agent.currentTask) =>
				task
					? {
							taskId: task.taskId,
							status: task.status,
							taskSummary: task.taskSummary,
							updatedAt: task.updatedAt,
						}
					: undefined;
			return {
				agentId: agent.agentId,
				name: agent.name,
				agentType: agent.agentType,
				status: agent.status,
				depth: agent.depth,
				parentSessionId: agent.parentSessionId,
				tools: agent.tools,
				writePolicy: agent.writePolicy,
				mayDelegate: agent.mayDelegate,
				...(agent.currentTask ? { currentTask: compactTask(agent.currentTask) } : {}),
				...(agent.latestTask ? { latestTask: compactTask(agent.latestTask) } : {}),
				usage,
				updatedAt: agent.updatedAt,
			};
		}),
		usage: inspected.usage,
	};
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
			permission: permissionDescriptor(() => permissionClaim({ effects: ["external-side-effect"] })),
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
			permission: permissionDescriptor(() => permissionClaim()),
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				const inspected = await manager().inspect(actorId(host.getSession()), {
					agentId: params.agentId,
					taskId: params.taskId,
					beforeEventId: params.beforeEventId,
					limit: params.limit,
				});
				return result(inspectDetails(inspected), false, inspectText(inspected));
			},
		}),
		defineTool({
			name: "send_message",
			label: "Send message",
			description: "Steer a running child task without creating a new task.",
			parameters: SendMessage,
			permission: permissionDescriptor(() => permissionClaim({ effects: ["external-side-effect"] })),
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
			permission: permissionDescriptor(() => permissionClaim({ effects: ["external-side-effect"] })),
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
				"Wait only when the next critical step depends on a new child terminal event or approval and no useful independent work remains. Completed children notify automatically; do not poll. Returns compact identities, statuses, and terminal results, never transcripts.",
			parameters: Wait,
			permission: permissionDescriptor(() => permissionClaim()),
			renderResult: renderSubagentResult,
			async execute(_id, params, signal) {
				const session = host.getSession();
				const waited = await manager().waitAgents(actorId(session), params, signal);
				const deliveredEventIds = session.stageAgentMailboxDelivery(waited.mailboxEventIds);
				const terminalResults: Array<Record<string, unknown>> = [];
				const representedTasks = new Set<string>();
				const appendTerminal = (agentId: string, taskId: string) => {
					const key = `${agentId}\0${taskId}`;
					if (representedTasks.has(key)) return;
					const agent = waited.agents.find((candidate) => candidate.agentId === agentId);
					const task = agent?.tasks.find((candidate) => candidate.taskId === taskId);
					if (!task || (task.status !== "done" && task.status !== "failed" && task.status !== "stopped")) return;
					representedTasks.add(key);
					terminalResults.push({
						agentId,
						taskId,
						status: task.status,
						...(task.finalMessage ? { finalMessage: utf8Prefix(task.finalMessage, 4 * 1024) } : {}),
						...(task.error ? { error: utf8Prefix(task.error, 4 * 1024) } : {}),
					});
				};
				for (const eventId of deliveredEventIds) {
					const identity = terminalEventIdentity(eventId);
					if (identity) appendTerminal(identity.agentId, identity.taskId);
				}
				const agentsWithPendingEvents = new Set(
					waited.mailboxEventIds
						.map(terminalEventIdentity)
						.filter((identity): identity is NonNullable<typeof identity> => identity !== undefined)
						.map((identity) => identity.agentId),
				);
				for (const agent of waited.agents) {
					if (agentsWithPendingEvents.has(agent.agentId)) continue;
					const task = agent.currentTask ?? agent.latestTask;
					if (task) appendTerminal(agent.agentId, task.taskId);
				}
				return result({
					timedOut: waited.timedOut,
					agents: waited.agents.map((agent) => {
						const task = agent.currentTask ?? agent.latestTask;
						return {
							agentId: agent.agentId,
							status: agent.status,
							...(task?.taskId ? { taskId: task.taskId } : {}),
						};
					}),
					mailboxEventIds: deliveredEventIds,
					...(terminalResults.length > 0 ? { terminalResults } : {}),
					...(waited.attention ? { attention: waited.attention } : {}),
				});
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt agent",
			description: "Stop queued or running child work while preserving its session for later follow-up.",
			parameters: AgentId,
			permission: permissionDescriptor(() => permissionClaim({ effects: ["external-side-effect"] })),
			renderResult: renderSubagentResult,
			async execute(_id, params) {
				return result(await manager().interrupt(actorId(host.getSession()), params.agentId));
			},
		}),
	];
}
