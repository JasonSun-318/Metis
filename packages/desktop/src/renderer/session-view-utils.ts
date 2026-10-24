import {
	type AgentSummaryView,
	type InteractionView,
	type ItemView,
	RPC_ERROR_CODES,
	type SessionSummary,
} from "@metis/app-protocol";
import { rpcErrorCode } from "./rpc-error.ts";

export type SessionIndicator = "attention" | "failed" | "completed" | "running" | "unread";

/** The status dot shown beside a session; notifications are suppressed while the user is looking at it. */
export function sessionIndicator(
	session: Partial<Pick<SessionSummary, "state" | "unread" | "attentionRequired" | "lastTurnOutcome">>,
	viewing: boolean,
): SessionIndicator | undefined {
	const notification = !viewing && session.unread;
	if (notification && session.attentionRequired) return "attention";
	if (notification && session.lastTurnOutcome === "failed") return "failed";
	if (notification && session.lastTurnOutcome === "completed") return "completed";
	if (session.state === "running") return "running";
	return notification ? "unread" : undefined;
}

/** Adapt agent task state to the same notification and viewing rules as a root session. */
export function agentIndicator(
	agent: Pick<AgentSummaryView, "status" | "runControl" | "archived">,
	{
		unread,
		attentionRequired,
		viewing,
	}: { readonly unread: boolean; readonly attentionRequired: boolean; readonly viewing: boolean },
): SessionIndicator | undefined {
	const stopped =
		agent.status === "stopped" ||
		agent.archived ||
		agent.runControl === "user_paused" ||
		agent.runControl === "interrupted";
	return sessionIndicator(
		{
			state: !stopped && (agent.status === "running" || agent.status === "queued") ? "running" : "idle",
			unread: attentionRequired || (!stopped && unread),
			attentionRequired,
			lastTurnOutcome:
				!stopped && agent.status === "done"
					? "completed"
					: !stopped && agent.status === "failed"
						? "failed"
						: undefined,
		},
		viewing,
	);
}

export const SESSION_INDICATOR_LABELS: Readonly<Record<SessionIndicator, string | undefined>> = {
	attention: "Needs attention",
	failed: "Failed",
	completed: "Completed",
	running: "Running",
	unread: undefined,
};

export function firstInteractionForSession(
	interactionOrder: readonly string[],
	interactionsById: ReadonlyMap<string, InteractionView>,
	sessionId: string | undefined,
): InteractionView | undefined {
	if (!sessionId) return undefined;
	for (const interactionId of interactionOrder) {
		const interaction = interactionsById.get(interactionId);
		if (interaction && (interaction.actorSessionId ?? interaction.sessionId) === sessionId) return interaction;
	}
	return undefined;
}

export function latestAssistantUsageKey(
	itemOrder: readonly string[],
	itemsById: ReadonlyMap<string, ItemView>,
): string {
	for (let i = itemOrder.length - 1; i >= 0; i--) {
		const item = itemsById.get(itemOrder[i]!);
		if (item?.role !== "assistant" || item.state !== "completed" || !item.usage) continue;
		const usage = item.usage;
		return `${item.itemId}:${usage.inputTokens ?? 0}:${usage.outputTokens ?? 0}:${usage.cacheReadTokens ?? 0}:${usage.cacheWriteTokens ?? 0}`;
	}
	return "";
}

export function queuedTurnActionError(cause: unknown): Error {
	const code = rpcErrorCode(cause);
	if (code === RPC_ERROR_CODES.CONFLICT) return new Error("This queued message changed. Review it and try again.");
	if (code === RPC_ERROR_CODES.BUSY) return new Error("The task state changed before this message could be sent.");
	if (code === RPC_ERROR_CODES.OVERLOADED) return new Error("The message queue is full.");
	if (code === RPC_ERROR_CODES.READ_ONLY_SESSION) return new Error("Scheduled sessions are read-only.");
	return cause instanceof Error ? cause : new Error("The queued message could not be changed.");
}
