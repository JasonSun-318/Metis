import type { ThinkingLevel } from "@metis/agent-core";
import type { AgentMode } from "../agent-mode.ts";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";
import type { PermissionPreset } from "../permissions/settings.ts";
import type { DurablePromptInput } from "../runtime-recovery.ts";
import type { AgentRoleSnapshot } from "./agent-type-registry.ts";

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
export const MAX_AGENT_INPUT_UTF8_BYTES = 64 * 1024;
export const MAX_AGENT_QUEUED_TASKS = 32;
export const MAX_AGENT_TASKS = 256;
export const MAX_AGENT_MAILBOX_PENDING_EVENTS = 256;
export const MAX_AGENT_MAILBOX_DELIVERY_EVENTS = 8;
export const MAX_AGENT_MAILBOX_DELIVERY_UTF8_BYTES = 32 * 1024;
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
	readonly mode?: AgentMode;
	readonly roleSnapshot?: AgentRoleSnapshot;
	readonly agentId: string;
	readonly name: string;
	readonly agentType: string;
	readonly initialTask: string;
	readonly tools: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly permissionPreset: PermissionPreset;
	readonly model: AgentModelRef;
	readonly thinkingLevel: ThinkingLevel;
	readonly cwd: string;
	readonly forkTurns: AgentForkTurns;
	readonly timeoutSeconds: number;
	readonly mayDelegate: boolean;
}

export interface AgentTaskSummary {
	readonly instructionRevision?: number;
	readonly consumedInstructionRevision?: number;
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
	readonly retry?: AgentSession["retryState"];
	readonly model?: AgentModelRef;
	readonly mode?: AgentMode;
	readonly roleSnapshot?: AgentRoleSnapshot;
	readonly runControl?: AgentRunControl;
	readonly agentId: string;
	readonly name: string;
	readonly agentType: string;
	readonly depth: number;
	readonly status: AgentStatus;
	readonly archived: boolean;
	readonly tools: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
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
	| "TOOL_SNAPSHOT_UNAVAILABLE"
	| "USER_PAUSED"
	| "REQUEST_ID_CONFLICT";

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
	readonly messageId?: string;
	readonly textOffset?: number;
	readonly agentId?: string;
	readonly taskId?: string;
	readonly beforeEventId?: string;
	readonly limit?: number;
}

export type InspectAgentsResult =
	| {
			readonly kind: "message";
			readonly agentId: string;
			readonly taskId: string;
			readonly messageId: string;
			readonly origin: AgentMessageOrigin;
			readonly text: string;
			readonly imageCount: number;
			readonly state: AgentDeliveryState;
			readonly instructionRevision: number;
			readonly nextTextOffset?: number;
	  }
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
	readonly deletedAt: string;
}

export interface AgentMailboxTerminalEvent {
	readonly instructionRevision?: number;
	readonly consumedInstructionRevision?: number;
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
	| {
			readonly type: "activity";
			readonly agentId: string;
			readonly taskId: string;
			readonly event: AgentVisibleActivity;
	  }
	| {
			readonly type: "approval_required";
			readonly summary: AgentSummary;
			readonly taskId: string;
			readonly toolName: string;
	  }
	| { readonly type: "notification_ready"; readonly event: AgentMailboxEvent; readonly wake?: boolean }
	| { readonly type: "notification_failed"; readonly event: AgentMailboxEvent; readonly error: string };

export type AgentMessageOrigin =
	| { readonly kind: "user" }
	| { readonly kind: "agent"; readonly sessionId: string; readonly sourceItemId?: string }
	| { readonly kind: "system"; readonly eventId: string };
export type AgentMessageActor = Exclude<AgentMessageOrigin, { kind: "system" }>;
export type AgentDeliveryMode = "auto" | "steer" | "queue";
export type AgentDeliveryState = "accepted" | "queued" | "delivered" | "cancelled" | "failed";
export interface AgentRunControl {
	readonly state: "enabled" | "user_paused" | "interrupted";
	readonly scope: "self" | "subtree";
	readonly requestId: string;
}
export interface AgentSubmitMessageInput {
	readonly agentId: string;
	readonly requestId: string;
	readonly delivery?: AgentDeliveryMode;
	readonly input: DurablePromptInput;
}
export interface AgentMessageReceipt {
	readonly agentId: string;
	readonly taskId: string;
	readonly messageId: string;
	readonly requestId: string;
	readonly delivery: "steer" | "start" | "queue";
	readonly state: AgentDeliveryState;
	readonly instructionRevision: number;
}
export interface AgentQueuedMessage {
	readonly messageId: string;
	readonly revision: string;
	readonly state: "queued" | "paused" | "sending";
	readonly input: DurablePromptInput;
}
export interface AgentDeleteQueuedMessageInput {
	readonly agentId: string;
	readonly requestId: string;
	readonly messageId: string;
	readonly expectedRevision: string;
}
export interface AgentSendQueuedMessageInput extends AgentDeleteQueuedMessageInput {
	readonly delivery: "steer" | "start";
}
export interface AgentControlInput {
	readonly agentId: string;
	readonly action: "stop" | "resume";
	readonly scope: "self" | "subtree";
	readonly requestId: string;
}
export interface AgentControlReceipt extends AgentRunControl {
	readonly agentId: string;
}
export interface AgentMailboxInterventionEvent {
	readonly type: "intervention";
	readonly eventId: string;
	readonly taskId: string;
	readonly agentId: string;
	readonly parentSessionId: string;
	readonly name: string;
	readonly completedAt: string;
	readonly messageId: string;
	readonly instructionRevision: number;
	readonly delivery: "steer" | "start" | "queue";
	readonly state: AgentDeliveryState;
	readonly text: string;
	readonly imageCount?: number;
}
export interface AgentMailboxRunControlEvent {
	readonly type: "run_control";
	readonly eventId: string;
	readonly taskId: string;
	readonly agentId: string;
	readonly parentSessionId: string;
	readonly name: string;
	readonly completedAt: string;
	readonly action: "stop" | "resume";
	readonly state: AgentRunControl["state"];
	readonly scope: AgentRunControl["scope"];
}
export type AgentMailboxEvent = AgentMailboxTerminalEvent | AgentMailboxInterventionEvent | AgentMailboxRunControlEvent;
