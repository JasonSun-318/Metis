import type { PromptCacheRequestSnapshot } from "@metis/ai";
import { getLatestCacheHitPercent } from "./cache-stats.ts";
import type { SessionEntry } from "./session-manager.ts";

/** Only reports observable adapter changes, never infers the provider's internal cache decisions. */
export function comparePromptCacheRequests(
	previous: PromptCacheRequestSnapshot | undefined,
	current: PromptCacheRequestSnapshot | undefined,
) {
	if (!previous || !current) return { status: "missing-snapshot" as const };
	if (previous.version !== 1 || current.version !== 1 || previous.boundary !== current.boundary)
		return { status: "incompatible-snapshot" as const };
	if (previous.api !== current.api || previous.provider !== current.provider || previous.model !== current.model)
		return { status: "model-or-api-change" as const };
	if (previous.endpointDigest !== current.endpointDigest) return { status: "endpoint-change" as const };
	const changedSections = (["settings", "system", "tools"] as const).filter(
		(key) => previous[key].digest !== current[key].digest,
	);
	let matchingMessages = 0;
	while (
		matchingMessages < Math.min(previous.messages.length, current.messages.length) &&
		previous.messages[matchingMessages]!.digest === current.messages[matchingMessages]!.digest
	)
		matchingMessages++;
	const firstChangedMessage =
		matchingMessages < Math.min(previous.messages.length, current.messages.length) ? matchingMessages : undefined;
	const shortened = current.messageCount < previous.messageCount;
	if (changedSections.length || firstChangedMessage !== undefined || shortened)
		return {
			status: "request-changed" as const,
			changedSections,
			firstChangedMessage,
			...(shortened ? { historyShortened: true } : {}),
			matchingMessages,
		};
	if (!previous.complete || !current.complete) return { status: "truncated-snapshot" as const, matchingMessages };
	if (previous.messageCount === current.messageCount && previous.history.digest !== current.history.digest)
		return { status: "request-changed" as const, changedSections: ["history"], matchingMessages };
	return {
		status: previous.messageCount === current.messageCount ? ("identical" as const) : ("append" as const),
		matchingMessages,
	};
}

/** Read-only projection. Request metadata lives beside messages and never enters model context. */
export function buildPromptCacheReport(entries: readonly SessionEntry[]) {
	let previous: Extract<SessionEntry, { type: "message" }> | undefined;
	return entries.flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		const message = entry.message;
		const current = entry.cacheRequest;
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		const previousFailed =
			previous?.message.role === "assistant" && ["error", "aborted"].includes(previous.message.stopReason);
		const usage = message.usage;
		const reported = usage.cacheReported ?? usage.cacheRead + usage.cacheWrite > 0;
		const row = {
			timestamp: entry.timestamp,
			api: message.api,
			provider: message.provider,
			model: message.model,
			stopReason: message.stopReason,
			inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
			cacheReadTokens: reported ? usage.cacheRead : null,
			cacheWriteTokens: reported ? usage.cacheWrite : null,
			hitPercent: failed ? null : (getLatestCacheHitPercent([entry]) ?? null),
			requestIntervalMs:
				current && previous?.cacheRequest ? current.capturedAt - previous.cacheRequest.capturedAt : null,
			comparison: !previous
				? { status: "first-recorded-request" }
				: previousFailed
					? { status: "previous-request-failed" }
					: comparePromptCacheRequests(previous.cacheRequest, current),
		};
		previous = entry;
		return [row];
	});
}
