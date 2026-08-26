import type { ThinkingLevel } from "@metis/agent-core";
import type { AgentMode } from "../agent-mode.ts";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { PermissionMode } from "../permission-mode.ts";

export const SUBAGENT_ACTIVATION_TOOL_NAME = "activate_subagents" as const;

export interface ActivateSubagentsResult {
	readonly activated: true;
	readonly alreadyActivated: boolean;
}

export const SUBAGENT_TOOL_NAMES = [
	"spawn_agent",
	"inspect_agents",
	"message_agent",
	"interrupt_agent",
	"close_agent",
] as const;

export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];
export type SubagentStatus = "queued" | "running" | "done" | "failed" | "stopped" | "close_failed" | "closed";
export type SubagentForkTurns = number | "all";
export type SubagentTerminalStatus = "done" | "failed" | "stopped";

export interface SubagentMailboxTerminalEvent {
	readonly eventId: string;
	readonly runId: string;
	readonly agentId: string;
	readonly name: string;
	readonly type: "terminal";
	readonly status: SubagentTerminalStatus;
	readonly finalMessage?: string;
	readonly error?: string;
	readonly completedAt: string;
}

export type SubagentMailboxEvent = SubagentMailboxTerminalEvent;

export interface SubagentModelRef {
	readonly provider: string;
	readonly modelId: string;
}

export interface SubagentConfig {
	readonly agentId: string;
	readonly name: string;
	readonly task: string;
	readonly taskSummary: string;
	readonly mode: AgentMode;
	readonly tools: readonly string[];
	readonly permissionMode: PermissionMode;
	readonly model: SubagentModelRef;
	readonly thinkingLevel: ThinkingLevel;
	readonly cwd: string;
	readonly forkTurns: SubagentForkTurns;
	readonly timeoutSeconds: number;
	readonly role?: string;
	readonly developerInstructions?: string;
}

export interface SubagentUsage {
	readonly model: SubagentModelRef;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly elapsedMs: number;
	readonly toolCalls?: number;
	readonly cost?: number;
}

export interface SubagentDisplayConfig {
	readonly mode: AgentMode;
	readonly tools: readonly string[];
	readonly permissionMode: PermissionMode;
	readonly model: SubagentModelRef;
	readonly thinkingLevel: ThinkingLevel;
	readonly cwd: string;
	readonly forkTurns: SubagentForkTurns;
	readonly timeoutSeconds: number;
}

export interface SubagentSummary {
	readonly agentId: string;
	readonly runId?: string;
	readonly name: string;
	readonly status: SubagentStatus;
	readonly background?: boolean;
	readonly taskSummary: string;
	readonly configuration?: SubagentDisplayConfig;
	readonly finalSummary?: string;
	readonly error?: string;
	readonly residualPath?: string;
	readonly usage?: SubagentUsage;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface SubagentTombstone {
	readonly agentId: string;
	readonly name: string;
	readonly status: "closed";
	readonly taskSummary: string;
	readonly finalSummary?: string;
	readonly closedAt: string;
}

export type SubagentVisibleActivity = Extract<
	AgentSessionEvent,
	{ type: "message_start" | "message_update" | "message_end" }
>;

export type SubagentManagerEvent =
	| { readonly type: "updated"; readonly summary: SubagentSummary }
	| {
			readonly type: "activity";
			readonly agentId: string;
			readonly turnId?: string;
			readonly event: SubagentVisibleActivity;
	  }
	| { readonly type: "approval_required"; readonly summary: SubagentSummary; readonly toolName: string }
	| { readonly type: "notification_ready"; readonly event: SubagentMailboxEvent }
	| { readonly type: "notification_failed"; readonly event: SubagentMailboxEvent; readonly error: string };

export const AGENT_TOOL_NAMES = [
	"spawn_agent",
	"inspect_agents",
	"send_message",
	"followup_task",
	"wait_agents",
	"interrupt_agent",
] as const;

export const AGENT_TYPES = ["default", "explorer", "worker", "reviewer"] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
export type AgentType = (typeof AGENT_TYPES)[number];
export type AgentStatus = "queued" | "running" | "done" | "failed" | "stopped";
export type AgentTaskStatus = AgentStatus;
export type AgentForkTurns = number | "all";

export interface AgentModelRef {
	readonly provider: string;
	readonly modelId: string;
}

export interface AgentUsage {
	readonly model: AgentModelRef;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly elapsedMs: number;
	readonly toolCalls?: number;
	readonly cost?: number;
}

export interface AgentRelation {
	readonly parentSessionId: string;
	readonly rootSessionId: string;
	readonly agentPath: readonly string[];
}

export interface AgentConfig extends AgentRelation {
	readonly agentId: string;
	readonly name: string;
	readonly agentType: AgentType;
	readonly initialTask: string;
	readonly tools: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly permissionMode: PermissionMode;
	readonly model: AgentModelRef;
	readonly thinkingLevel: ThinkingLevel;
	readonly cwd: string;
	readonly forkTurns: AgentForkTurns;
	readonly timeoutSeconds: number;
	readonly mayDelegate: boolean;
}

export interface AgentTaskSummary {
	readonly taskId: string;
	readonly status: AgentTaskStatus;
	readonly taskSummary: string;
	readonly finalMessage?: string;
	readonly error?: string;
	readonly usage?: AgentUsage;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface AgentSummary extends AgentRelation {
	readonly agentId: string;
	readonly name: string;
	readonly agentType: AgentType;
	readonly depth: number;
	readonly status: AgentStatus;
	readonly archived: boolean;
	readonly currentTask?: AgentTaskSummary;
	readonly latestTask?: AgentTaskSummary;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export type AgentTraceEvent =
	| {
			readonly eventId: string;
			readonly taskId: string;
			readonly timestamp: string;
			readonly kind: "llm";
			readonly text: string;
			readonly truncated?: true;
			readonly originalBytes?: number;
	  }
	| {
			readonly eventId: string;
			readonly taskId: string;
			readonly timestamp: string;
			readonly kind: "tool";
			readonly toolName: string;
			readonly status: "running" | "success" | "failed";
	  }
	| {
			readonly eventId: string;
			readonly taskId: string;
			readonly timestamp: string;
			readonly kind: "final";
			readonly text: string;
			readonly truncated?: true;
			readonly originalBytes?: number;
	  };

export type AgentErrorCode =
	| "INVALID_INPUT"
	| "UNKNOWN_AGENT"
	| "UNKNOWN_TASK"
	| "UNKNOWN_CURSOR"
	| "NOT_DESCENDANT"
	| "INVALID_STATE"
	| "QUEUE_FULL"
	| "DEPTH_LIMIT"
	| "MODEL_UNAVAILABLE"
	| "TOOL_SNAPSHOT_UNAVAILABLE";

export class AgentError extends Error {
	readonly code: AgentErrorCode;

	constructor(code: AgentErrorCode, message: string) {
		super(message);
		this.name = "AgentError";
		this.code = code;
	}
}

export interface AgentUsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly elapsedMs: number;
	readonly cost?: number;
}

export interface InspectAgentsInput {
	readonly agentId?: string;
	readonly taskId?: string;
	readonly beforeEventId?: string;
	readonly limit?: number;
}

export type InspectAgentsResult =
	| { readonly kind: "list"; readonly agents: readonly AgentSummary[]; readonly usage: AgentUsageTotals }
	| {
			readonly kind: "trace";
			readonly agent: AgentSummary;
			readonly taskId: string;
			readonly events: readonly AgentTraceEvent[];
			readonly nextBeforeEventId?: string;
	  };

export interface InterruptAgentResult {
	readonly agentId: string;
	readonly taskId?: string;
	readonly status: "done" | "failed" | "stopped";
	readonly cancelledTaskIds: readonly string[];
}

export interface DeleteAgentResult {
	readonly agentId: string;
	readonly status: "deleted" | "delete_failed";
	readonly residualPath?: string;
	readonly error?: string;
}

export interface AgentTombstone {
	readonly agentId: string;
	readonly name: string;
	readonly status: "deleted";
	readonly taskSummary: string;
	readonly finalMessage?: string;
	readonly deletedAt: string;
}

export interface AgentMailboxTerminalEvent {
	readonly eventId: string;
	readonly taskId: string;
	readonly agentId: string;
	readonly parentSessionId: string;
	readonly name: string;
	readonly type: "terminal";
	readonly status: "done" | "failed" | "stopped";
	readonly finalMessage?: string;
	readonly error?: string;
	readonly completedAt: string;
}

export type AgentManagerEvent =
	| { readonly type: "updated"; readonly summary: AgentSummary }
	| { readonly type: "activity"; readonly agentId: string; readonly taskId: string; readonly event: AgentTraceEvent }
	| {
			readonly type: "approval_required";
			readonly summary: AgentSummary;
			readonly taskId: string;
			readonly toolName: string;
	  }
	| { readonly type: "notification_ready"; readonly event: AgentMailboxTerminalEvent }
	| { readonly type: "notification_failed"; readonly event: AgentMailboxTerminalEvent; readonly error: string };
