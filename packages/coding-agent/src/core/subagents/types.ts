import type { ThinkingLevel } from "@arcmind/agent-core";
import type { AgentMode } from "../agent-mode.ts";
import type { PermissionMode } from "../permission-mode.ts";

export const SUBAGENT_TOOL_NAMES = [
	"spawn_agent",
	"inspect_agents",
	"message_agent",
	"wait_agents",
	"interrupt_agent",
	"close_agent",
] as const;

export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];
export type SubagentStatus = "queued" | "running" | "done" | "failed" | "stopped" | "close_failed" | "closed";
export type SubagentForkTurns = number | "all";

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
	readonly reviewerEnabled: boolean;
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
	readonly name: string;
	readonly status: SubagentStatus;
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

export type SubagentManagerEvent =
	| { readonly type: "updated"; readonly summary: SubagentSummary }
	| { readonly type: "approval_required"; readonly summary: SubagentSummary; readonly toolName: string };
