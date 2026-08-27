import { AgentError, type AgentSummary, MAX_AGENT_MAILBOX_DELIVERY_EVENTS, type WaitAgentsResult } from "./types.ts";

export interface AgentWaitHandle {
	readonly actorId: string;
	readonly ids: ReadonlySet<string>;
	snapshot(): WaitAgentsResult | undefined;
	resolve(result: WaitAgentsResult): void;
	reject(error: Error): void;
	dispose(): void;
}

const TERMINAL_EVENT_ID = /^agent:([^:]+):([^:]+):terminal$/;

export function terminalEventIdentity(
	eventId: string,
): { readonly agentId: string; readonly taskId: string } | undefined {
	const match = TERMINAL_EVENT_ID.exec(eventId);
	return match?.[1] && match[2] ? { agentId: match[1], taskId: match[2] } : undefined;
}

export function normalizeWaitAgentIds(requested: readonly string[]): readonly string[] {
	const ids = [...requested];
	if (ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length) {
		throw new AgentError("INVALID_INPUT", "wait_agents requires 1-8 unique agent IDs");
	}
	return ids;
}

function isTerminalAgent(status: AgentSummary["status"]): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}

export function waitAgentsSnapshot(
	summaries: readonly AgentSummary[],
	selected: ReadonlySet<string>,
	pendingEventIds: Iterable<string>,
	attentionByAgentId: ReadonlyMap<string, { readonly taskId: string; readonly toolName: string }>,
): WaitAgentsResult | undefined {
	const agents = summaries.filter((summary) => selected.has(summary.agentId));
	for (const agent of agents) {
		const attention = attentionByAgentId.get(agent.agentId);
		if (attention) {
			return {
				timedOut: false,
				agents,
				mailboxEventIds: [],
				attention: {
					agentId: agent.agentId,
					taskId: attention.taskId,
					kind: "approval_required",
					toolName: attention.toolName,
				},
			};
		}
	}
	const mailboxEventIds = [...pendingEventIds]
		.filter((eventId) => {
			const identity = terminalEventIdentity(eventId);
			return identity !== undefined && selected.has(identity.agentId);
		})
		.slice(0, MAX_AGENT_MAILBOX_DELIVERY_EVENTS);
	if (mailboxEventIds.length > 0 || agents.some((agent) => isTerminalAgent(agent.status))) {
		return { timedOut: false, agents, mailboxEventIds };
	}
	return undefined;
}

export function resolveWaiters(waiters: Iterable<AgentWaitHandle>, agentId?: string): void {
	for (const waiter of [...waiters]) {
		if (agentId && !waiter.ids.has(agentId)) continue;
		const result = waiter.snapshot();
		if (result) waiter.resolve(result);
	}
}
