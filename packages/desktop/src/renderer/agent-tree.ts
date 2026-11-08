import type { AgentSummaryView } from "@metis/app-protocol";

export interface AgentTreeNode {
	readonly agent: AgentSummaryView;
	readonly children: readonly AgentTreeNode[];
}

export function buildAgentTree(agents: readonly AgentSummaryView[], rootSessionId: string): readonly AgentTreeNode[] {
	const byParent = new Map<string, AgentSummaryView[]>();
	const visited = new Set<string>();
	for (const agent of agents) {
		const siblings = byParent.get(agent.parentSessionId) ?? [];
		siblings.push(agent);
		byParent.set(agent.parentSessionId, siblings);
	}
	const buildAgent = (agent: AgentSummaryView): AgentTreeNode | undefined => {
		if (visited.has(agent.agentId)) return undefined;
		visited.add(agent.agentId);
		const children = (byParent.get(agent.agentId) ?? [])
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.map(buildAgent)
			.filter((node): node is AgentTreeNode => node !== undefined);
		return { agent, children };
	};
	const tree = (byParent.get(rootSessionId) ?? [])
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
		.map(buildAgent)
		.filter((node): node is AgentTreeNode => node !== undefined);
	for (const orphan of agents) {
		const node = buildAgent(orphan);
		if (node) tree.push(node);
	}
	return tree;
}
