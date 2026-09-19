import type { AssistantMessage } from "@metis/ai";
import { describe, expect, it } from "vitest";
import {
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
	getLatestCacheHitPercent,
	type ModelPriceSource,
	summarizePromptCacheUsage,
} from "../src/core/cache-stats.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const models: ModelPriceSource = {
	// $/million tokens; used as cache-read price fallback on full-miss turns
	find: () => ({ cost: { cacheRead: 0.3 } }),
};

function assistant(options: {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: Partial<typeof zeroCost>;
	model?: string;
	timestamp?: number;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "test",
		model: options.model ?? "test-model",
		usage: {
			input: options.input ?? 0,
			output: 10,
			cacheRead: options.cacheRead ?? 0,
			cacheWrite: options.cacheWrite ?? 0,
			totalTokens: 0,
			cost: { ...zeroCost, ...options.cost },
		},
		stopReason: "stop",
		timestamp: options.timestamp ?? 0,
	} as AssistantMessage;
}

function entry(message: AssistantMessage): SessionEntry {
	return { type: "message", id: "x", parentId: null, timestamp: "", message } as SessionEntry;
}

// Turn 1: fresh 100k cache write at $3.75/M
const turn1 = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, timestamp: 0 });
// Turn 2: healthy, everything read back at $0.30/M
const turn2 = assistant({
	cacheRead: 100_000,
	cacheWrite: 5_000,
	cost: { cacheRead: 0.03, cacheWrite: 0.019 },
	timestamp: 60_000,
});

describe("computeCacheWaste", () => {
	it("accumulates missed tokens and cost across turns", () => {
		// Turn 3: full miss, previous 105k prompt re-billed at $3.75/M write
		const turn3 = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const totals = computeCacheWaste([entry(turn1), entry(turn2), entry(turn3)], models);
		expect(totals.missedTokens).toBe(105_000);
		// 105k at ($3.75 - $0.30)/M
		expect(totals.missedCost).toBeCloseTo(0.36225, 5);
	});

	it("counts nothing for healthy sessions", () => {
		const totals = computeCacheWaste([entry(turn1), entry(turn2)], models);
		expect(totals.missedTokens).toBe(0);
		expect(totals.missedCost).toBe(0);
	});

	it("skips the turn after a compaction reset", () => {
		const reset = { type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry;
		const afterReset = assistant({ cacheWrite: 20_000, cost: { cacheWrite: 0.075 } });
		const totals = computeCacheWaste([entry(turn1), reset, entry(afterReset)], models);
		expect(totals.missedTokens).toBe(0);
	});

	it("counts misses caused by model switches", () => {
		const otherModel = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, model: "other-model" });
		const totals = computeCacheWaste([entry(turn1), entry(otherModel)], models);
		expect(totals.missedTokens).toBe(100_000);
		expect(totals.missCount).toBe(1);
	});

	it("skips providers that report no cache activity", () => {
		const a = assistant({ input: 100_000 });
		const b = assistant({ input: 110_000 });
		const totals = computeCacheWaste([entry(a), entry(b)], models);
		expect(totals.missedTokens).toBe(0);
	});
});

describe("collectCacheMisses", () => {
	it("maps counted misses to their assistant messages by reference", () => {
		const missTurn = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const misses = collectCacheMisses([entry(turn1), entry(turn2), entry(missTurn)], models);
		expect(misses.size).toBe(1);
		expect(misses.get(missTurn)?.missedTokens).toBe(105_000);
	});
});

describe("detectCacheMiss", () => {
	it("detects a miss on a just-completed message with idle time", () => {
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 });
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], missMessage, models);
		expect(miss).toBeDefined();
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.missedCost).toBeCloseTo(0.36225, 5);
		// 600s - 60s since the previous request
		expect(miss?.idleMs).toBe(540_000);
		expect(miss?.modelChanged).toBe(false);
	});

	it("flags model switches on detected misses", () => {
		const otherModel = assistant({
			cacheWrite: 110_000,
			cost: { cacheWrite: 0.4125 },
			model: "other-model",
			timestamp: 120_000,
		});
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], otherModel, models);
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.modelChanged).toBe(true);
	});

	it("returns undefined for healthy turns", () => {
		const healthy = assistant({
			cacheRead: 105_000,
			cacheWrite: 2_000,
			cost: { cacheRead: 0.0315, cacheWrite: 0.0075 },
			timestamp: 120_000,
		});
		expect(detectCacheMiss([entry(turn1), entry(turn2)], healthy, models)).toBeUndefined();
	});

	it("returns undefined for the first turn of a session", () => {
		expect(detectCacheMiss([], turn1, models)).toBeUndefined();
	});
});

describe("getLatestCacheHitPercent", () => {
	it("uses the latest request after cache activity has been reported", () => {
		expect(getLatestCacheHitPercent([entry(turn1), entry(turn2)])).toBeCloseTo(100_000 / 1050, 5);
		expect(getLatestCacheHitPercent([entry(turn1), entry(assistant({ input: 110_000 }))])).toBe(0);
		expect(getLatestCacheHitPercent([entry(assistant({ input: 100_000 }))])).toBeUndefined();
	});
});

it("does not let an unsuccessful request replace the latest completed cache statistic", () => {
	const failed = { ...assistant({ input: 100, cacheRead: 0 }), stopReason: "error" as const };
	expect(getLatestCacheHitPercent([entry(turn2), entry(failed)])).toBeCloseTo(100_000 / 1050, 5);
});

it("does not infer cache reporting for a different model from earlier requests", () => {
	expect(
		getLatestCacheHitPercent([entry(turn2), entry(assistant({ model: "no-cache-report", input: 100 }))]),
	).toBeUndefined();
});

it("distinguishes an explicit zero hit count from missing cache reporting", () => {
	const zero = assistant({ input: 100 });
	zero.usage.cacheReported = true;
	expect(getLatestCacheHitPercent([entry(zero)])).toBe(0);
	zero.usage.cacheReported = false;
	expect(getLatestCacheHitPercent([entry(turn2), entry(zero)])).toBeUndefined();
});

it("does not show the previous model's ratio when the selected model has changed", () => {
	expect(getLatestCacheHitPercent([entry(turn2)], { provider: "test", id: "other" })).toBeUndefined();
});

it("rejects invalid token counts instead of clamping a fabricated rate", () => {
	for (const input of [-1, NaN, Infinity]) {
		expect(getLatestCacheHitPercent([entry(assistant({ input, cacheRead: 100 }))])).toBeUndefined();
	}
});

describe("summarizePromptCacheUsage", () => {
	it("never infers reporting from non-zero cache fields on legacy records", () => {
		const legacy = assistant({ input: 50, cacheRead: 900 }).usage;
		const result = summarizePromptCacheUsage([legacy]);
		expect(result.reportedRequests).toBe(0);
		expect(result.unreportedRequests).toBe(1);
		expect(result.inputTokens).toBe(0);
		expect(result.hitRatio).toBeUndefined();
	});

	it("excludes output tokens from the ratio", () => {
		const usage = assistant({ input: 100, cacheRead: 300 }).usage;
		usage.output = 50_000;
		usage.cacheReported = true;
		const result = summarizePromptCacheUsage([usage]);
		expect(result.inputTokens).toBe(400);
		expect(result.hitRatio).toBeCloseTo(300 / 400);
	});
});
