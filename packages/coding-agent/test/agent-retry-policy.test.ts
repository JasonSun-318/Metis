import type { AssistantMessage } from "@metis/ai/compat";
import { describe, expect, it } from "vitest";
import {
	canRetryAssistantMessage,
	isRetryableAssistantMessage,
	type RetryPolicySettings,
	retryDelayMs,
	retryProgress,
} from "../src/core/agent-retry-policy.ts";

const SETTINGS: RetryPolicySettings = { enabled: true, maxRetries: 3, baseDelayMs: 1_000 };

function message(overrides: Record<string, unknown> = {}): AssistantMessage {
	return {
		role: "assistant",
		provider: "provider",
		model: "model",
		timestamp: 0,
		content: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "error",
		errorMessage: "overloaded",
		...overrides,
	} as unknown as AssistantMessage;
}

function decision(overrides: Partial<Parameters<typeof canRetryAssistantMessage>[0]> = {}) {
	return {
		message: message(),
		contextWindow: 100_000,
		settings: SETTINGS,
		attempt: 0,
		signalAborted: false,
		stopAfterAbort: false,
		runtimeTeardownRequested: false,
		durableRecoveryRequired: false,
		...overrides,
	};
}

describe("agent retry policy", () => {
	it("retries transient provider errors but not terminal ones", () => {
		expect(isRetryableAssistantMessage(message(), 100_000)).toBe(true);
		expect(isRetryableAssistantMessage(message({ errorMessage: "invalid api key" }), 100_000)).toBe(false);
		expect(isRetryableAssistantMessage(message({ stopReason: "stop" }), 100_000)).toBe(false);
	});

	it("treats context overflow as a compaction concern, not a retry", () => {
		expect(isRetryableAssistantMessage(message({ errorMessage: "prompt is too long" }), 100_000)).toBe(false);
	});

	it("requires the retry budget, an un-aborted run and no teardown", () => {
		expect(canRetryAssistantMessage(decision())).toBe(true);
		expect(canRetryAssistantMessage(decision({ settings: { ...SETTINGS, enabled: false } }))).toBe(false);
		expect(canRetryAssistantMessage(decision({ attempt: 3 }))).toBe(false);
		expect(canRetryAssistantMessage(decision({ signalAborted: true }))).toBe(false);
		expect(canRetryAssistantMessage(decision({ stopAfterAbort: true }))).toBe(false);
		expect(canRetryAssistantMessage(decision({ runtimeTeardownRequested: true }))).toBe(false);
		expect(canRetryAssistantMessage(decision({ durableRecoveryRequired: true }))).toBe(false);
		expect(canRetryAssistantMessage(decision({ message: message({ errorMessage: "invalid api key" }) }))).toBe(false);
	});

	it("uses exponential backoff capped at 30 seconds", () => {
		expect(retryDelayMs(1, 1_000)).toBe(1_000);
		expect(retryDelayMs(2, 1_000)).toBe(2_000);
		expect(retryDelayMs(3, 5_000)).toBe(20_000);
		expect(retryDelayMs(10, 5_000)).toBe(30_000);
	});

	it("reports progress only while retrying", () => {
		expect(retryProgress(0, SETTINGS)).toBeUndefined();
		expect(retryProgress(2, SETTINGS)).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 2_000 });
	});
});
