import type { AssistantMessage, Model } from "@metis/ai/compat";

/**
 * Overflow/threshold decisions are only valid for the model that produced the
 * assistant message; a message from a smaller-context model must not trigger
 * compaction for the newly selected larger-context model.
 */
export function isSameModel(message: AssistantMessage, model: Model<any> | undefined): boolean {
	if (!model) return false;
	return message.provider === model.provider && message.model === model.id;
}

/**
 * A stale pre-compaction usage or error must not retrigger compaction on the
 * first prompt after compaction finished.
 */
export function isAssistantBeforeCompaction(
	assistantTimestamp: number,
	compactionTimestamp: number | undefined,
): boolean {
	return compactionTimestamp !== undefined && assistantTimestamp <= compactionTimestamp;
}
