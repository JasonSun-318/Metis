import type { ThinkingLevel } from "@arcmind/agent-core";
import { Type } from "typebox";
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

function result(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
		...(isError ? { isError: true } : {}),
	};
}

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
			async execute(_id, params) {
				return result(await manager().inspect(params));
			},
		}),
		defineTool({
			name: "message_agent",
			label: "Message agent",
			description: "Steer a running child or queue a follow-up that resumes a cold child. Requires Ultra.",
			parameters: Message,
			async execute(_id, params) {
				requireUltra();
				return result(await manager().message(params));
			},
		}),
		defineTool({
			name: "wait_agents",
			label: "Wait for agents",
			description: "Wait until any selected child changes state; with no IDs, observe all non-closed children.",
			parameters: Wait,
			async execute(_id, params, signal) {
				return result(await manager().wait(params, signal));
			},
		}),
		defineTool({
			name: "interrupt_agent",
			label: "Interrupt agent",
			description: "Stop queued or running child work while preserving its recoverable session.",
			parameters: AgentId,
			async execute(_id, params) {
				return result(await manager().interrupt(params.agentId));
			},
		}),
		defineTool({
			name: "close_agent",
			label: "Close agent",
			description: "Permanently delete one child session and retain only its parent tombstone.",
			parameters: AgentId,
			async execute(_id, params) {
				return result(await manager().close(params.agentId));
			},
		}),
	];
}
