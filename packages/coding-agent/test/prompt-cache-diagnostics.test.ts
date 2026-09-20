import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, observePromptCacheRequest } from "@metis/ai";
import type { PromptCacheObservation } from "@metis/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizePromptCacheUsage } from "../src/core/cache-stats.ts";
import { SessionManager } from "../src/core/session-manager.ts";
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
	it("associates snapshots with responses, persists on reopen, and never sends them as context", async () => {
		const h = createCacheSession(root);
		fixture = h;
		h.settings.applyOverrides({ promptCache: { diagnostics: true } });
		const originalStream = h.agent.streamFn;
		let fail = false;
		h.agent.streamFn = async (model, context, options) => {
			await observePromptCacheRequest(
				model,
				{ system: context.systemPrompt, messages: context.messages, tools: context.tools },
				options,
			);
			if (!fail) return originalStream(model, context, options);
			const stream = createAssistantMessageEventStream();
			const message = {
				...fauxAssistantMessage("", { stopReason: "aborted" }),
				api: model.api,
				model: model.id,
				provider: model.provider,
			};
			stream.push({ type: "error", reason: "aborted", error: message });
			stream.end();
			return stream;
		};
		await h.session.prompt("first");
		await h.session.prompt("second");
		fail = true;
		await h.session.prompt("abort");
		fail = false;
		h.settings.applyOverrides({ promptCache: { diagnostics: false } });
		await h.session.prompt("unobserved");
		const assistants = h.manager.getBranch().filter((e) => e.type === "message" && e.message.role === "assistant");
		expect(assistants).toHaveLength(4);
		for (const entry of assistants.slice(0, 3)) {
			expect(entry.type === "message" && entry.cacheRequest?.boundary).toBe("adapter-payload");
		}
		expect(assistants[3]?.type === "message" && assistants[3].cacheRequest).toBeUndefined();
		expect(JSON.stringify(h.captured)).not.toContain("adapter-payload");
		const file = h.manager.getSessionFile()!;
		h.close();
		fixture = undefined;
		const reopened = SessionManager.open(file);
		try {
			const saved = reopened.getBranch().filter((e) => e.type === "message" && e.cacheRequest);
			expect(saved).toHaveLength(3);
			expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain("adapter-payload");
		} finally {
			reopened.close();
		}
	});
});
