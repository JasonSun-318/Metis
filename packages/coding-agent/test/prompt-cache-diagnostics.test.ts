import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@metis/ai";
import type { PromptCacheObservation } from "@metis/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizePromptCacheUsage } from "../src/core/cache-stats.ts";
import { type CacheSessionFixture, createCacheSession } from "./cache-session-fixtures.ts";

describe("summarizePromptCacheUsage", () => {
	it("weights cache reads using normalized ordinary+read+write input", () => {
		const base = fauxAssistantMessage("ok").usage;
		const result = summarizePromptCacheUsage([
			{ ...base, input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cacheReported: true },
			{ ...base, input: 10, output: 500, cacheRead: 0, cacheWrite: 0, cacheReported: true },
		]);
		expect(result.inputTokens).toBe(1010);
		expect(result.hitRatio).toBeCloseTo(900 / 1010);
		expect(result.reportedRequests).toBe(2);
	});

	it("does not report unavailable usage as a measured zero hit", () => {
		const base = fauxAssistantMessage("ok").usage;
		expect(summarizePromptCacheUsage([{ ...base, cacheReported: false }]).hitRatio).toBeUndefined();
	});

	it("lists legacy records without the reporting flag as unreported", () => {
		const base = fauxAssistantMessage("ok").usage;
		const result = summarizePromptCacheUsage([
			{ ...base, input: 100, cacheRead: 50 },
			{ ...base, input: 100, cacheRead: 0, cacheReported: true },
		]);
		expect(result.reportedRequests).toBe(1);
		expect(result.unreportedRequests).toBe(1);
		expect(result.inputTokens).toBe(100);
		expect(result.cacheReadTokens).toBe(0);
	});

	it("keeps cache writes in the denominator but out of the hit numerator", () => {
		const base = fauxAssistantMessage("ok").usage;
		const result = summarizePromptCacheUsage([
			{ ...base, input: 0, cacheRead: 0, cacheWrite: 1000, cacheReported: true },
		]);
		expect(result.inputTokens).toBe(1000);
		expect(result.cacheWriteTokens).toBe(1000);
		expect(result.hitRatio).toBe(0);
	});
});

describe("AgentSession prompt-cache diagnostics", () => {
	let root: string;
	let fixture: CacheSessionFixture | undefined;

	const observation = (reason: PromptCacheObservation["reason"], bytes = 100): PromptCacheObservation => ({
		checkpoint: {
			version: 1,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			settingsDigest: `settings-${reason}`,
			historyBoundary: { originId: "entry-1", ordinal: 0, prefixDigest: "p" },
		},
		reason,
		reusableInputBytes: bytes,
		stableInputBytes: bytes,
	});

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-cache-diag-"));
	});
	afterEach(() => {
		fixture?.close();
		fixture = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("retains recent observations only when diagnostics are enabled", async () => {
		const h = createCacheSession(root);
		fixture = h;
		h.settings.applyOverrides({ promptCache: { diagnostics: true } });
		await h.session.prompt("first");
		h.agent.onPromptCachePrepared?.(observation("append"));
		expect(h.session.getPromptCacheDiagnostics()).toHaveLength(1);
		expect(h.session.getPromptCacheDiagnostics()[0]?.reason).toBe("append");
	});

	it("keeps the list empty with diagnostics disabled while requests still complete", async () => {
		const h = createCacheSession(root);
		fixture = h;
		await h.session.prompt("first");
		h.agent.onPromptCachePrepared?.(observation("append"));
		expect(h.session.getPromptCacheDiagnostics()).toEqual([]);
	});

	it("caps the history at 64 entries and returns a copy", async () => {
		const h = createCacheSession(root);
		fixture = h;
		h.settings.applyOverrides({ promptCache: { diagnostics: true } });
		for (let i = 0; i < 70; i++) {
			h.agent.onPromptCachePrepared?.(observation("append", i));
		}
		const diagnostics = h.session.getPromptCacheDiagnostics();
		expect(diagnostics).toHaveLength(64);
		expect(diagnostics[0]?.reusableInputBytes).toBe(6);
		expect(diagnostics.at(-1)?.reusableInputBytes).toBe(69);
		(diagnostics as PromptCacheObservation[]).pop();
		expect(h.session.getPromptCacheDiagnostics()).toHaveLength(64);
	});
});
