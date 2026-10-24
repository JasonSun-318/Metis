/** A child remains owned by its root session; it is never opened as an unrelated root. */
export interface AgentConversationTarget {
	readonly sessionId: string;
	readonly agentId: string;
	readonly name: string;
}

export function conversationTargetKey(target: { readonly sessionId: string; readonly agentId?: string }): string {
	return JSON.stringify([target.sessionId, target.agentId ?? null]);
}
