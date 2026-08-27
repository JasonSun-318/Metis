import { AgentError, type AgentSummary, type WaitAgentsResult } from "./types.ts";

export interface AgentWaitHandle {
	readonly actorId: string;
	readonly ids: ReadonlySet<string>;
	snapshot(): WaitAgentsResult | undefined;
	resolve(result: WaitAgentsResult): void;
	reject(error: Error): void;
	dispose(): void;
}

const TERMINAL_EVENT_ID = /^agent:([^:]+):[^:]+:terminal$/;

export function terminalEventAgentId(eventId: string): string | undefined {
	return TERMINAL_EVENT_ID.exec(eventId)?.[1];
}

export function normalizeWaitAgentIds(requested: readonly string[]): readonly string[] {
	const ids = [...requested];
	if (ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length) {
		throw new AgentError("INVALID_INPUT", "wait_agents requires 1-8 unique agent IDs");
	}
	return ids;
}

export function selectedLiveAgents(summaries: readonly AgentSummary[], selected: ReadonlySet<string>): boolean {
	return summaries.some(
		(summary) => selected.has(summary.agentId) && (summary.status === "queued" || summary.status === "running"),
	);
}

export function pendingMailboxAgentIds(
	pendingEventIds: Iterable<string>,
	selected: ReadonlySet<string>,
): readonly string[] {
	const updated = new Set<string>();
	for (const eventId of pendingEventIds) {
		const agentId = terminalEventAgentId(eventId);
		if (agentId && selected.has(agentId)) updated.add(agentId);
	}
	return [...updated];
}

export function pendingApprovalAgentIds(
	blockedAgentIds: Iterable<string>,
	selected: ReadonlySet<string>,
): readonly string[] {
	return [...new Set([...blockedAgentIds].filter((agentId) => selected.has(agentId)))];
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
	const mailboxEventIds = [...pendingEventIds].filter((eventId) => {
		const agentId = terminalEventAgentId(eventId);
		return agentId !== undefined && selected.has(agentId);
	});
	if (mailboxEventIds.length > 0 || !selectedLiveAgents(summaries, selected)) {
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
