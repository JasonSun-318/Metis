import { randomUUID } from "node:crypto";
import type { AgentMode } from "../agent-mode.ts";
import { getMemorySqlitePath } from "../auto-memory.ts";
import {
	awaitWithAbort,
	hasDurableMemoryIntent,
	MEMORY_EXTRACT_TIMEOUT_MS,
	type MemoryExtractActiveRun,
	type MemoryExtractMode,
	type MemoryExtractResult,
	type MemoryExtractStatusSnapshot,
	type RunMemoryExtractOptions,
	runMemoryExtract,
} from "./memory-extract.ts";
import { memoryProjectIdentity } from "./memory-project.ts";
import {
	backfillMemoryEmbeddings,
	MEMORY_RETRIEVE_TIMEOUT_MS,
	type RetrievedMemoryFact,
	searchMemories,
} from "./memory-search.ts";
import {
	type EmbeddingSettings,
	MEMORY_EMBEDDING_CREDENTIAL_ID,
	MEMORY_RERANK_CREDENTIAL_ID,
	type RerankSettings,
} from "./memory-service-settings.ts";
import { type MemoryStore, openMemoryStore } from "./memory-store.ts";
import type { MemoryExtractRun, MemoryHealth } from "./memory-types.ts";

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

export interface RetrievedAutoMemory {
	readonly scope: "global" | "project";
	readonly text: string;
}

export interface SessionMemoryExtractInput {
	readonly mode: MemoryExtractMode;
	readonly trigger: string;
	readonly evidence: string;
	readonly cursorEntryId: string | null;
	readonly signal: AbortSignal;
}

export interface SessionMemoryCompactionInput {
	readonly evidence: string;
	readonly reason: "manual" | "threshold" | "overflow";
	readonly signal: AbortSignal;
}

export interface SessionMemoryRuntimeDependencies {
	readonly agentDir?: string;
	readonly cwd: () => string;
	readonly sessionId: () => string;
	readonly mode: () => AgentMode;
	readonly enabled: () => boolean;
	readonly engine: () => "index" | "extract";
	readonly hasModel: () => boolean;
	readonly lastUserText: () => string;
	readonly collectEvidence: (cursorEntryId: string | null) => {
		readonly evidence: string;
		readonly cursorEntryId: string | null;
	};
	readonly createExtractOptions: (
		input: SessionMemoryExtractInput,
	) => RunMemoryExtractOptions | undefined | Promise<RunMemoryExtractOptions | undefined>;
	readonly refreshPrompt: () => void;
	readonly applyRetrieved: (memories: readonly RetrievedAutoMemory[]) => void;
	readonly getEmbeddingSettings: () => EmbeddingSettings | undefined;
	readonly getRerankSettings: () => RerankSettings | undefined;
	readonly getCredential: (id: string) => Promise<string | undefined>;
	readonly openStore?: typeof openMemoryStore;
	readonly runExtract?: typeof runMemoryExtract;
	readonly search?: typeof searchMemories;
	readonly backfill?: typeof backfillMemoryEmbeddings;
	readonly extractTimeoutMs?: () => number;
	readonly cleanupTimeoutMs?: number;
}

export interface SessionMemoryRuntimeSnapshot extends MemoryExtractStatusSnapshot {
	readonly health: MemoryHealth[];
}

/** Owns every asynchronous long-term-memory activity scoped to one AgentSession. */
export class SessionMemoryRuntime {
	private readonly dependencies: SessionMemoryRuntimeDependencies;
	private readonly openStore: typeof openMemoryStore;
	private readonly runExtract: typeof runMemoryExtract;
	private readonly search: typeof searchMemories;
	private readonly backfill: typeof backfillMemoryEmbeddings;
	private generation = 0;
	private acceptingWork = true;
	private disposed = false;
	private disposePromise?: Promise<void>;
	private userTurnsSinceExtract = 0;
	private activeExtract?: MemoryExtractActiveRun;
	private extractPromise?: Promise<MemoryExtractResult>;
	private extractAbort?: AbortController;
	private backfillPromise?: Promise<void>;
	private backfillAbort?: AbortController;
	private retrieval?: { query: string; promise: Promise<readonly RetrievedAutoMemory[]>; abort: AbortController };

	constructor(dependencies: SessionMemoryRuntimeDependencies) {
		this.dependencies = dependencies;
		this.openStore = dependencies.openStore ?? openMemoryStore;
		this.runExtract = dependencies.runExtract ?? runMemoryExtract;
		this.search = dependencies.search ?? searchMemories;
		this.backfill = dependencies.backfill ?? backfillMemoryEmbeddings;
		this.startBackfill();
	}

	async prepareTurn(query: string): Promise<readonly RetrievedAutoMemory[]> {
		if (!this.canRun() || this.dependencies.engine() !== "extract") {
			if (this.canMutate(this.generation)) {
				this.dependencies.applyRetrieved([]);
				if (this.dependencies.engine() === "index") this.dependencies.refreshPrompt();
			}
			return [];
		}
		this.startBackfill();
		if (this.retrieval?.query === query) return this.retrieval.promise;

		const generation = this.generation;
		const abort = new AbortController();
		const promise = this.retrieve(query, generation, abort.signal)
			.catch(() => [] as readonly RetrievedAutoMemory[])
			.then((memories) => {
				if (!this.canMutate(generation)) return [];
				this.dependencies.applyRetrieved(memories);
				this.dependencies.refreshPrompt();
				this.startBackfill();
				return memories;
			})
			.finally(() => {
				if (this.retrieval?.promise === promise) this.retrieval = undefined;
			});
		this.retrieval = { query, promise, abort };
		return promise;
	}

	afterTurn(): void {
		if (!this.canRun() || !this.dependencies.hasModel()) return;
		this.userTurnsSinceExtract++;
		if (this.userTurnsSinceExtract < 4 && !hasDurableMemoryIntent(this.dependencies.lastUserText())) return;
		if (this.activeExtract?.extractMode === "reconcile") return;
		if (this.extractPromise && this.activeExtract?.extractMode === "commit") return;
		void this.launchExtract("commit", "turn", "", null).catch(() => undefined);
	}

	async withCompaction<T>(input: SessionMemoryCompactionInput, work: () => Promise<T>): Promise<T> {
		input.signal.throwIfAborted();
		if (!this.canRun() || !this.dependencies.hasModel()) return work();
		if (this.extractPromise && this.activeExtract?.extractMode === "commit") {
			await this.extractPromise.catch(() => undefined);
		}
		if (!this.canRun()) return work();
		const extract =
			this.extractPromise && this.activeExtract?.extractMode === "reconcile"
				? this.extractPromise
				: this.launchExtract("reconcile", input.reason, input.evidence, null, input.signal);
		try {
			return await work();
		} finally {
			await extract.catch(() => undefined);
		}
	}

	snapshot(limit = 10): SessionMemoryRuntimeSnapshot {
		let recent: MemoryExtractRun[] = [];
		let health: MemoryHealth[] = [];
		const agentDir = this.dependencies.agentDir;
		if (agentDir) {
			try {
				const store = this.openStore(getMemorySqlitePath(agentDir));
				try {
					recent = store.listExtractRuns(limit);
					const backfillRunning = store.getActiveBackfillLease(Date.now()) !== null;
					health = store
						.listHealth()
						.filter((row) => row.operation !== "backfill" || row.status !== "running" || backfillRunning);
				} finally {
					store.close();
				}
			} catch {
				recent = [];
				health = [];
			}
		}
		return {
			enabled: this.dependencies.enabled(),
			...(this.activeExtract ? { active: { ...this.activeExtract } } : {}),
			recent,
			health,
		};
	}

	async waitForIdle(): Promise<void> {
		const pending = [this.extractPromise, this.backfillPromise, this.retrieval?.promise].filter(
			(value) => value !== undefined,
		) as Promise<unknown>[];
		await Promise.allSettled(pending);
	}

	async waitForExtract(): Promise<void> {
		await this.extractPromise?.catch(() => undefined);
	}

	async quiesce(reason: string): Promise<void> {
		this.acceptingWork = false;
		this.generation++;
		this.extractAbort?.abort(reason);
		this.backfillAbort?.abort(reason);
		this.retrieval?.abort.abort(reason);
		await this.drainBounded(reason);
	}

	resume(): void {
		if (this.disposed) return;
		this.acceptingWork = true;
		this.schedulePendingExtract();
		this.startBackfill();
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.disposePromise = this.quiesce("session-dispose");
		return this.disposePromise;
	}

	private canRun(): boolean {
		return (
			this.acceptingWork && !this.disposed && this.dependencies.agentDir !== undefined && this.dependencies.enabled()
		);
	}

	private canMutate(generation: number): boolean {
		return this.acceptingWork && !this.disposed && this.generation === generation;
	}

	private schedulePendingExtract(): void {
		if (this.extractPromise || !this.canRun() || !this.dependencies.hasModel()) return;
		void this.launchExtract("commit", "settings-refresh", "", null).catch(() => undefined);
	}

	private launchExtract(
		mode: MemoryExtractMode,
		trigger: string,
		evidence: string,
		cursorEntryId: string | null,
		externalSignal?: AbortSignal,
	): Promise<MemoryExtractResult> {
		if (this.extractPromise && this.activeExtract?.extractMode === mode) return this.extractPromise;
		if (!this.canRun() || !this.dependencies.hasModel())
			return Promise.resolve(this.skipped("Memory extract unavailable"));

		const generation = this.generation;
		const abort = new AbortController();
		this.extractAbort = abort;
		const timeoutMs = this.dependencies.extractTimeoutMs?.() ?? MEMORY_EXTRACT_TIMEOUT_MS;
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = AbortSignal.any([abort.signal, timeout, ...(externalSignal ? [externalSignal] : [])]);
		const active: MemoryExtractActiveRun = {
			id: randomUUID(),
			sessionId: this.dependencies.sessionId(),
			mode: this.dependencies.mode(),
			extractMode: mode,
			cwd: this.dependencies.cwd(),
			trigger,
			startedAt: new Date().toISOString(),
		};
		this.activeExtract = active;

		const work = Promise.resolve().then(async () => {
			try {
				return mode === "commit"
					? await this.drainExtract(trigger, generation, signal)
					: await this.invokeExtract({ mode, trigger, evidence, cursorEntryId, signal }, generation);
			} catch (error) {
				const result =
					abort.signal.aborted || externalSignal?.aborted
						? this.skipped("Aborted", active.id)
						: timeout.aborted
							? this.failed(`Timed out after ${timeoutMs}ms`, active.id)
							: this.failed(error instanceof Error ? error.message : String(error), active.id);
				if (this.canMutate(generation)) this.recordLifecycleFailure(result, active);
				return result;
			}
		});
		const tracked = work
			.then((result) => {
				if (result.status === "success" && this.canMutate(generation)) this.dependencies.refreshPrompt();
				return result;
			})
			.finally(() => {
				if (this.activeExtract?.id === active.id) this.activeExtract = undefined;
				if (this.extractAbort === abort) this.extractAbort = undefined;
			});
		this.extractPromise = tracked;
		void tracked.catch(() => undefined);
		return tracked.finally(() => {
			if (this.extractPromise === tracked) this.extractPromise = undefined;
		});
	}

	private async drainExtract(trigger: string, generation: number, signal: AbortSignal): Promise<MemoryExtractResult> {
		let last = this.skipped("No pending evidence");
		while (!signal.aborted && this.canMutate(generation) && this.dependencies.enabled()) {
			const cursor = this.withStore((store) => store.getExtractCursor(this.dependencies.sessionId()));
			const batch = this.dependencies.collectEvidence(cursor);
			if (!batch.cursorEntryId) {
				this.userTurnsSinceExtract = 0;
				return last;
			}
			last = await this.invokeExtract(
				{
					mode: "commit",
					trigger,
					evidence: batch.evidence,
					cursorEntryId: batch.cursorEntryId,
					signal,
				},
				generation,
			);
			if (last.status !== "success") return last;
			signal.throwIfAborted();
			if (!this.canMutate(generation)) return this.skipped("Stale memory generation", last.runId);
			this.withStore((store) =>
				store.setExtractCursor(this.dependencies.sessionId(), batch.cursorEntryId!, new Date().toISOString()),
			);
			await awaitWithAbort(new Promise<void>((resolve) => setImmediate(resolve)), signal);
		}
		signal.throwIfAborted();
		return last;
	}

	private async invokeExtract(input: SessionMemoryExtractInput, generation: number): Promise<MemoryExtractResult> {
		const options = await awaitWithAbort(
			Promise.resolve(this.dependencies.createExtractOptions(input)),
			input.signal,
		);
		if (!options || !this.canMutate(generation)) return this.skipped("Memory extract unavailable");
		const originalOpenStore = options.openStore ?? this.openStore;
		return await awaitWithAbort(
			this.runExtract({
				...options,
				openStore: (path) => this.guardStore(originalOpenStore(path), generation),
				signal: input.signal,
			}),
			input.signal,
		);
	}

	private startBackfill(): void {
		if (!this.canRun() || this.dependencies.engine() !== "extract" || this.backfillPromise) return;
		const embeddingSettings = this.dependencies.getEmbeddingSettings();
		if (!embeddingSettings) return;
		const generation = this.generation;
		const abort = new AbortController();
		this.backfillAbort?.abort("superseded");
		this.backfillAbort = abort;
		const agentDir = this.dependencies.agentDir!;
		const work = Promise.resolve()
			.then(async () => {
				const embeddingApiKey = await this.dependencies.getCredential(MEMORY_EMBEDDING_CREDENTIAL_ID);
				if (!embeddingApiKey || !this.canMutate(generation)) return;
				const store = this.guardStore(this.openStore(getMemorySqlitePath(agentDir)), generation);
				try {
					if (abort.signal.aborted) return;
					await this.backfill({ store, embeddingSettings, embeddingApiKey, signal: abort.signal });
				} finally {
					store.close();
				}
			})
			.catch(() => undefined)
			.finally(() => {
				if (this.backfillAbort === abort) this.backfillAbort = undefined;
				if (this.backfillPromise === work) this.backfillPromise = undefined;
			});
		this.backfillPromise = work;
	}

	private async retrieve(
		query: string,
		generation: number,
		signal: AbortSignal,
	): Promise<readonly RetrievedAutoMemory[]> {
		const agentDir = this.dependencies.agentDir;
		const embeddingSettings = this.dependencies.getEmbeddingSettings();
		if (!agentDir || !embeddingSettings) return [];
		const embeddingApiKey = await this.dependencies.getCredential(MEMORY_EMBEDDING_CREDENTIAL_ID);
		if (!embeddingApiKey || !this.canMutate(generation)) return [];
		const rerankSettings = this.dependencies.getRerankSettings();
		const rerankApiKey = rerankSettings
			? await this.dependencies.getCredential(MEMORY_RERANK_CREDENTIAL_ID)
			: undefined;
		if (!this.canMutate(generation)) return [];
		const store = this.guardStore(this.openStore(getMemorySqlitePath(agentDir)), generation);
		try {
			const hits: RetrievedMemoryFact[] = await this.search({
				store,
				query,
				projectKey: memoryProjectIdentity(this.dependencies.cwd()).projectKey,
				embeddingSettings,
				embeddingApiKey,
				...(rerankSettings ? { rerankSettings } : {}),
				...(rerankApiKey ? { rerankApiKey } : {}),
				retrieveTimeoutMs: MEMORY_RETRIEVE_TIMEOUT_MS,
				signal,
			});
			if (!this.canMutate(generation)) return [];
			return hits.map((hit) => ({ scope: hit.scope, text: hit.text }));
		} finally {
			store.close();
		}
	}

	private async drainBounded(reason: string): Promise<void> {
		const extract = this.extractPromise;
		const backfill = this.backfillPromise;
		const retrieval = this.retrieval?.promise;
		const pending = [extract, backfill, retrieval].filter((value) => value !== undefined) as Promise<unknown>[];
		if (pending.length === 0) return;
		const timeoutMs = this.dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled(pending),
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						timedOut = true;
						resolve();
					}, timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (!timedOut) return;
		if (this.extractPromise === extract) this.extractPromise = undefined;
		if (this.backfillPromise === backfill) this.backfillPromise = undefined;
		if (this.retrieval?.promise === retrieval) this.retrieval = undefined;
		this.recordCleanupTimeout(reason, timeoutMs);
	}

	private recordCleanupTimeout(reason: string, timeoutMs: number): void {
		try {
			this.withStore((store) =>
				store.recordHealth({
					operation: "extract",
					status: "error",
					updatedAt: new Date().toISOString(),
					reason: `Memory cleanup for ${reason} exceeded ${timeoutMs}ms; stale work was detached`,
				}),
			);
		} catch {
			// Cleanup remains bounded even when derived health cannot be written.
		}
	}

	private recordLifecycleFailure(result: MemoryExtractResult, active: MemoryExtractActiveRun): void {
		try {
			this.withStore((store) => {
				store.recordExtractRun({
					id: result.runId,
					startedAt: active.startedAt,
					trigger: active.trigger,
					status: result.status,
					reason: result.reason ?? null,
				});
				store.recordHealth({
					operation: "extract",
					status: "error",
					updatedAt: new Date().toISOString(),
					reason:
						result.status === "skipped"
							? "Aborted; pending evidence will retry"
							: (result.reason ?? "Extract failed"),
				});
			});
		} catch {
			// The durable cursor still proves that failed work was not acknowledged.
		}
	}

	private withStore<T>(work: (store: MemoryStore) => T): T {
		const store = this.openStore(getMemorySqlitePath(this.dependencies.agentDir!));
		try {
			return work(store);
		} finally {
			store.close();
		}
	}

	private guardStore(store: MemoryStore, generation: number): MemoryStore {
		const allowedAfterInvalidation = new Set<keyof MemoryStore>(["close", "releaseBackfillLease"]);
		const runtime = this;
		return new Proxy(store, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (!allowedAfterInvalidation.has(property as keyof MemoryStore) && !runtime.canMutate(generation)) {
						throw new DOMException("Stale memory generation", "AbortError");
					}
					return Reflect.apply(value, target, args);
				};
			},
		}) as MemoryStore;
	}

	private skipped(reason: string, runId: string = randomUUID()): MemoryExtractResult {
		return { status: "skipped", reason, runId };
	}

	private failed(reason: string, runId: string = randomUUID()): MemoryExtractResult {
		return { status: "failed", reason, runId };
	}
}
