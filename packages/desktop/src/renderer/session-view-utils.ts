import { type InteractionView, type ItemView, RPC_ERROR_CODES } from "@metis/app-protocol";
import { rpcErrorCode } from "./rpc-error.ts";

export function firstInteractionForSession(
	interactionOrder: readonly string[],
	interactionsById: ReadonlyMap<string, InteractionView>,
	sessionId: string | undefined,
): InteractionView | undefined {
	if (!sessionId) return undefined;
	for (const interactionId of interactionOrder) {
		const interaction = interactionsById.get(interactionId);
		if (interaction?.sessionId === sessionId) return interaction;
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
