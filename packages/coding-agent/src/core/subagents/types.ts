import type { ThinkingLevel } from "@metis/agent-core";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { PermissionMode } from "../permission-mode.ts";

export type AgentVisibleActivity = Extract<
	AgentSessionEvent,
	{ type: "message_start" | "message_update" | "message_end" }
>;

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
	readonly tasks: readonly AgentTaskSummary[];
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

export interface WaitAgentsInput {
	readonly agentIds: readonly string[];
	readonly timeoutMs?: number;
}

export interface WaitAgentsResult {
	readonly timedOut: boolean;
	readonly agents: readonly AgentSummary[];
	readonly mailboxEventIds: readonly string[];
	readonly attention?: {
		readonly agentId: string;
		readonly taskId: string;
		readonly kind: "approval_required";
		readonly toolName: string;
	};
}

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
	| { readonly type: "deleted"; readonly agentId: string; readonly deletedAgentIds: readonly string[] }
	| { readonly type: "activity"; readonly agentId: string; readonly taskId: string; readonly event: AgentTraceEvent }
	| {
			readonly type: "approval_required";
			readonly summary: AgentSummary;
			readonly taskId: string;
			readonly toolName: string;
	  }
	| { readonly type: "notification_ready"; readonly event: AgentMailboxTerminalEvent }
	| { readonly type: "notification_failed"; readonly event: AgentMailboxTerminalEvent; readonly error: string };
