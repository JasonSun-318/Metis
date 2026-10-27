import type { AgentSummaryView } from "@metis/app-protocol";

export interface AgentActivity {
	readonly running: boolean;
	readonly attentionRequired: boolean;
}

/** Execution state is independent of read/unread notifications and parent turns. */
export function isAgentRunning(agent: Pick<AgentSummaryView, "status" | "runControl" | "archived">): boolean {
	return (
		!agent.archived &&
		agent.runControl !== "user_paused" &&
		agent.runControl !== "interrupted" &&
		(agent.status === "running" || agent.status === "queued")
	);
}

export function agentActivity(
	agents: readonly AgentSummaryView[],
	attentionAgentIds?: ReadonlySet<string>,
): AgentActivity {
	return {
		running: agents.some(isAgentRunning),
		attentionRequired: agents.some((agent) => !agent.archived && attentionAgentIds?.has(agent.agentId)),
	};
}
