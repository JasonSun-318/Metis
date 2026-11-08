import { type AssistantMessage, isContextOverflow, isRetryableAssistantError } from "@metis/ai";

export interface RetryPolicySettings {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly baseDelayMs: number;
}

/**
 * Context overflow is handled by compaction, not retry; everything else follows
 * the provider/transport transient-error classifier.
 */
export function isRetryableAssistantMessage(message: AssistantMessage, contextWindow: number): boolean {
	if (isContextOverflow(message, contextWindow)) return false;
	return isRetryableAssistantError(message);
}

export interface RetryDecisionInput {
	readonly message: AssistantMessage;
	readonly contextWindow: number;
	readonly settings: RetryPolicySettings;
	readonly attempt: number;
	readonly signalAborted: boolean;
	readonly stopAfterAbort: boolean;
	readonly runtimeTeardownRequested: boolean;
	readonly durableRecoveryRequired: boolean;
}

export function canRetryAssistantMessage(input: RetryDecisionInput): boolean {
	if (!input.settings.enabled) return false;
	if (input.attempt >= input.settings.maxRetries) return false;
	if (input.signalAborted || input.stopAfterAbort) return false;
	if (input.runtimeTeardownRequested || input.durableRecoveryRequired) return false;
	return isRetryableAssistantMessage(input.message, input.contextWindow);
}

/** Exponential backoff capped at 30s. `attempt` is 1-based. */
export function retryDelayMs(attempt: number, baseDelayMs: number): number {
	return Math.min(30_000, baseDelayMs * 2 ** (attempt - 1));
}

export interface RetryProgress {
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly delayMs: number;
}

export function retryProgress(attempt: number, settings: RetryPolicySettings): RetryProgress | undefined {
	if (attempt === 0) return undefined;
	return {
		attempt,
		maxAttempts: settings.maxRetries,
		delayMs: retryDelayMs(attempt, settings.baseDelayMs),
	};
}
