import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySqlitePath } from "../src/core/auto-memory.ts";
import type { MemoryExtractResult, RunMemoryExtractOptions } from "../src/core/memory/memory-extract.ts";
import type { backfillMemoryEmbeddings } from "../src/core/memory/memory-search.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import { SessionMemoryRuntime } from "../src/core/memory/session-memory-runtime.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createHarness(
	options: {
		runExtract?: (input: RunMemoryExtractOptions) => Promise<MemoryExtractResult>;
		search?: () => Promise<never>;
		backfill?: typeof backfillMemoryEmbeddings;
		engine?: "index" | "extract";
		enabled?: boolean;
		lastUserText?: string;
		extractTimeoutMs?: number;
		cleanupTimeoutMs?: number;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "metis-memory-runtime-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "memory"), { recursive: true });
	const evidence = [{ cursorEntryId: "entry-1", evidence: "remember alpha" }];
	let maximumConcurrency = 0;
	let concurrency = 0;
	const runExtract = vi.fn(async (input: RunMemoryExtractOptions): Promise<MemoryExtractResult> => {
		concurrency++;
		maximumConcurrency = Math.max(maximumConcurrency, concurrency);
		try {
			return options.runExtract
				? await options.runExtract(input)
				: { status: "success", runId: `run-${runExtract.mock.calls.length}` };
		} finally {
			concurrency--;
		}
	});
	const runtime = new SessionMemoryRuntime({
		agentDir,
		cwd: () => join(root, "project"),
		sessionId: () => "session-1",
		mode: () => "code",
		enabled: () => options.enabled ?? true,
		engine: () => options.engine ?? (options.search ? "extract" : "index"),
		hasModel: () => true,
		lastUserText: () => options.lastUserText ?? "please remember this",
		collectEvidence: (cursor) => {
			const next = cursor === null ? evidence[0] : evidence.find((item) => item.cursorEntryId > cursor);
			return next ?? { cursorEntryId: null, evidence: "" };
		},
		createExtractOptions: (input) => ({
			...input,
			agentDir,
			cwd: join(root, "project"),
			agentMode: "code",
			projectKey: "project-1",
			sessionId: "session-1",
			thinkingLevel: "off",
		}),
		refreshPrompt: vi.fn(),
		applyRetrieved: vi.fn(),
		getEmbeddingSettings: () => ({
			name: "test",
			provider: "test",
			baseUrl: "https://example.com/v1",
			api: "openai-compatible",
			modelId: "embed",
		}),
		getRerankSettings: () => undefined,
		getCredential: async () => "secret",
		runExtract,
		...(options.search ? { search: options.search } : {}),
		...(options.backfill ? { backfill: options.backfill } : {}),
		...(options.extractTimeoutMs === undefined ? {} : { extractTimeoutMs: () => options.extractTimeoutMs! }),
		...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
	});
	return {
		runtime,
		agentDir,
		evidence,
		runExtract,
		maximumConcurrency: () => maximumConcurrency,
	};
}

describe("SessionMemoryRuntime", () => {
	it("coalesces commit extraction and drains evidence appended during the run", async () => {
		let releaseFirst!: () => void;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const harness = createHarness({
			runExtract: async () => {
				if (harness.runExtract.mock.calls.length === 1) await first;
				return { status: "success", runId: `run-${harness.runExtract.mock.calls.length}` };
			},
		});
		harness.runtime.afterTurn();
		await vi.waitFor(() => expect(harness.runExtract).toHaveBeenCalledOnce());
		harness.evidence.push({ cursorEntryId: "entry-2", evidence: "remember beta" });
		harness.runtime.afterTurn();
		releaseFirst();
		await harness.runtime.waitForIdle();

		expect(harness.runExtract).toHaveBeenCalledTimes(2);
		expect(harness.maximumConcurrency()).toBe(1);
		const store = openMemoryStore(getMemorySqlitePath(harness.agentDir));
		try {
			expect(store.getExtractCursor("session-1")).toBe("entry-2");
		} finally {
			store.close();
		}
	});

	it("keeps compaction success when reconcile fails", async () => {
		const harness = createHarness({
			runExtract: async () => {
				throw new Error("offline");
			},
		});
		await expect(
			harness.runtime.withCompaction(
				{ evidence: "verified fact", reason: "manual", signal: new AbortController().signal },
				async () => "summary",
			),
		).resolves.toBe("summary");
	});

	it("returns no retrieved memories when search fails", async () => {
		const harness = createHarness({
			search: async () => {
				throw new Error("offline");
			},
		});
		await expect(harness.runtime.prepareTurn("query")).resolves.toEqual([]);
	});

	it("aborts and drains backfill before a settings refresh", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let signal: AbortSignal | undefined;
		const backfill = vi.fn(async (options: Parameters<typeof backfillMemoryEmbeddings>[0]) => {
			signal = options.signal;
			await held;
			return 0;
		});
		const harness = createHarness({ engine: "extract", backfill });
		await vi.waitFor(() => expect(backfill).toHaveBeenCalledOnce());

		let settled = false;
		const stopping = harness.runtime.quiesce("settings-refresh").then(() => {
			settled = true;
		});
		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBe("settings-refresh");
		expect(settled).toBe(false);
		release();
		await stopping;
	});

	it("does not advance the cursor after quiesce invalidates an extract", async () => {
		let release!: (result: MemoryExtractResult) => void;
		const held = new Promise<MemoryExtractResult>((resolve) => {
			release = resolve;
		});
		const harness = createHarness({ runExtract: async () => held });
		harness.runtime.afterTurn();
		await vi.waitFor(() => expect(harness.runExtract).toHaveBeenCalledOnce());

		await harness.runtime.quiesce("settings-refresh");
		release({ status: "success", runId: "late-success" });
		await Promise.resolve();
		const store = openMemoryStore(getMemorySqlitePath(harness.agentDir));
		try {
			expect(store.getExtractCursor("session-1")).toBeNull();
		} finally {
			store.close();
		}
	});

	it("bounds cleanup and blocks a detached backfill from mutating the store", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const backfill = vi.fn(async (options: Parameters<typeof backfillMemoryEmbeddings>[0]) => {
			await held;
			options.store.recordHealth({
				operation: "backfill",
				status: "ok",
				updatedAt: new Date().toISOString(),
				reason: "late mutation",
			});
			return 0;
		});
		const harness = createHarness({ engine: "extract", backfill, cleanupTimeoutMs: 5_000 });
		await vi.waitFor(() => expect(backfill).toHaveBeenCalledOnce());

		const disposed = harness.runtime.dispose();
		await vi.advanceTimersByTimeAsync(5_000);
		await expect(disposed).resolves.toBeUndefined();
		release();
		await vi.runAllTimersAsync();
		const store = openMemoryStore(getMemorySqlitePath(harness.agentDir));
		try {
			expect(store.listHealth()).not.toContainEqual(expect.objectContaining({ reason: "late mutation" }));
			expect(store.listHealth()).toContainEqual(
				expect.objectContaining({ operation: "extract", reason: expect.stringContaining("exceeded 5000ms") }),
			);
		} finally {
			store.close();
		}
		vi.useRealTimers();
	});

	it("throttles generic turns but runs durable-intent turns immediately", async () => {
		const generic = createHarness({ lastUserText: "fix this" });
		generic.runtime.afterTurn();
		generic.runtime.afterTurn();
		generic.runtime.afterTurn();
		await Promise.resolve();
		expect(generic.runExtract).not.toHaveBeenCalled();
		generic.runtime.afterTurn();
		await generic.runtime.waitForExtract();
		expect(generic.runExtract).toHaveBeenCalledOnce();

		const durable = createHarness({ lastUserText: "请记住以后用中文回复" });
		durable.runtime.afterTurn();
		await durable.runtime.waitForExtract();
		expect(durable.runExtract).toHaveBeenCalledOnce();
	});

	it("does not start background work while memory is disabled", async () => {
		const harness = createHarness({ enabled: false });
		harness.runtime.afterTurn();
		await expect(
			harness.runtime.withCompaction(
				{ evidence: "fact", reason: "manual", signal: new AbortController().signal },
				async () => "summary",
			),
		).resolves.toBe("summary");
		expect(harness.runExtract).not.toHaveBeenCalled();
	});

	it("exposes active status and clears it after extraction", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = createHarness({
			runExtract: async () => {
				await held;
				return { status: "success", runId: "active-run" };
			},
		});
		harness.runtime.afterTurn();
		await vi.waitFor(() => expect(harness.runtime.snapshot().active).toBeDefined());
		expect(harness.runtime.snapshot().active).toMatchObject({
			sessionId: "session-1",
			mode: "code",
			extractMode: "commit",
		});
		release();
		await harness.runtime.waitForExtract();
		expect(harness.runtime.snapshot().active).toBeUndefined();
	});

	it("times out an unresponsive extractor without advancing its cursor", async () => {
		const harness = createHarness({
			extractTimeoutMs: 10,
			runExtract: async () => new Promise<MemoryExtractResult>(() => {}),
		});
		harness.runtime.afterTurn();
		await harness.runtime.waitForExtract();
		const store = openMemoryStore(getMemorySqlitePath(harness.agentDir));
		try {
			expect(store.getExtractCursor("session-1")).toBeNull();
			expect(store.listHealth()).toContainEqual(expect.objectContaining({ operation: "extract", status: "error" }));
		} finally {
			store.close();
		}
	});

	it("resumes pending evidence after a settings refresh", async () => {
		const harness = createHarness({
			runExtract: async (options) => {
				if (harness.runExtract.mock.calls.length === 1) {
					await new Promise<void>((resolve) =>
						options.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
					return { status: "skipped", reason: "settings-refresh", runId: "aborted" };
				}
				return { status: "success", runId: "resumed" };
			},
		});
		harness.runtime.afterTurn();
		await vi.waitFor(() => expect(harness.runExtract).toHaveBeenCalledOnce());
		await harness.runtime.quiesce("settings-refresh");
		harness.runtime.resume();
		await vi.waitFor(() => expect(harness.runExtract).toHaveBeenCalledTimes(2));
		await harness.runtime.waitForExtract();
	});

	it("does not start a commit while reconcile is active", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = createHarness({
			runExtract: async () => {
				await held;
				return { status: "success", runId: "reconcile" };
			},
		});
		const compacting = harness.runtime.withCompaction(
			{ evidence: "fact", reason: "threshold", signal: new AbortController().signal },
			async () => "summary",
		);
		await vi.waitFor(() => expect(harness.runExtract).toHaveBeenCalledOnce());
		harness.runtime.afterTurn();
		expect(harness.runExtract).toHaveBeenCalledOnce();
		release();
		await compacting;
	});

	it("returns the same disposal promise and performs cleanup once", async () => {
		const harness = createHarness();
		const first = harness.runtime.dispose();
		const second = harness.runtime.dispose();
		expect(second).toBe(first);
		await first;
		harness.runtime.afterTurn();
		expect(harness.runExtract).not.toHaveBeenCalled();
	});
});
