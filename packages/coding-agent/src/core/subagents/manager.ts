import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@arcmind/agent-core";
import { getSupportedThinkingLevels, type Model } from "@arcmind/ai/compat";
import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionRuntime } from "../agent-session-runtime.ts";
import type { PermissionMode } from "../permission-mode.ts";
import type { RequestPermissionApproval } from "../permission-policy.ts";
import { createSessionId } from "../session-id.ts";
import type { FileEntry, SessionManager } from "../session-manager.ts";
import { defaultSubagentScheduler, type SubagentSchedulerApi } from "./scheduler.ts";
import { type SubagentDiskRecord, SubagentStore, type SubagentStoreApi } from "./store.ts";
import {
	SUBAGENT_TOOL_NAMES,
	type SubagentConfig,
	type SubagentForkTurns,
	type SubagentManagerEvent,
	type SubagentStatus,
	type SubagentSummary,
	type SubagentTombstone,
	type SubagentUsage,
} from "./types.ts";

export interface SpawnSubagentInput {
	readonly name: string;
	readonly task: string;
	readonly tools: readonly string[];
	readonly role?: string;
	readonly developerInstructions?: string;
	readonly permissionMode?: PermissionMode;
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly cwd?: string;
	readonly forkTurns?: SubagentForkTurns;
	readonly timeoutSeconds?: number;
}

export interface SpawnSubagentResult {
	readonly agentId: string;
	readonly name: string;
	readonly status: "queued" | "running";
	readonly taskSummary: string;
	readonly mode: "chat" | "code";
	readonly tools: readonly string[];
	readonly permissionMode: PermissionMode;
	readonly forkTurns: SubagentForkTurns;
}

export interface InspectSubagentsInput {
	readonly agentId?: string;
	readonly beforeEntryId?: string;
	readonly limit?: number;
}

export interface SubagentUsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly elapsedMs: number;
	readonly cost?: number;
}

export interface InspectSubagentsResult {
	readonly agents: readonly SubagentSummary[];
	readonly usage: SubagentUsageTotals;
	readonly journal?: readonly FileEntry[];
}

export interface MessageSubagentInput {
	readonly agentId: string;
	readonly mode: "steer" | "follow_up";
	readonly message: string;
}

export interface MessageSubagentResult {
	readonly agentId: string;
	readonly status: SubagentStatus;
	readonly delivery: "accepted" | "queued";
}

export interface WaitSubagentsInput {
	readonly agentIds?: readonly string[];
}

export interface WaitSubagentsResult {
	readonly agents: readonly SubagentSummary[];
}

export interface CloseSubagentResult {
	readonly agentId: string;
	readonly status: "closed" | "close_failed";
	readonly alreadyClosed?: boolean;
	readonly residualPath?: string;
	readonly error?: string;
}

export interface ChildRuntimeFactoryInput {
	readonly config: SubagentConfig;
	readonly sessionManager: SessionManager;
	readonly onPermissionRequest?: RequestPermissionApproval;
}

export type CreateChildRuntime = (input: ChildRuntimeFactoryInput) => Promise<AgentSessionRuntime>;

export interface SubagentManagerOptions {
	readonly parentSessionManager: SessionManager;
	readonly agentDir: string;
	readonly workspaceRoots: readonly string[];
	readonly scheduler?: SubagentSchedulerApi;
	readonly store?: SubagentStoreApi;
	readonly createChildRuntime: CreateChildRuntime;
	readonly onPermissionRequest?: RequestPermissionApproval;
	readonly now?: () => number;
	readonly createId?: () => string;
}

export interface SubagentManagerApi {
	attachParent(session: AgentSession): void;
	spawn(input: SpawnSubagentInput): Promise<SpawnSubagentResult>;
	inspect(input: InspectSubagentsInput): Promise<InspectSubagentsResult>;
	message(input: MessageSubagentInput): Promise<MessageSubagentResult>;
	wait(input: WaitSubagentsInput, signal?: AbortSignal): Promise<WaitSubagentsResult>;
	interrupt(agentId: string): Promise<SubagentSummary>;
	close(agentId: string): Promise<CloseSubagentResult>;
	readJournal(agentId: string): Promise<readonly FileEntry[]>;
	listSummaries(): readonly SubagentSummary[];
	getAggregateUsage(): SubagentUsageTotals;
	subscribe(listener: (event: SubagentManagerEvent) => void): () => void;
	recoverCloseMarkers(): Promise<void>;
	unload(reason: "parent_unloaded"): Promise<void>;
}

interface HotChild {
	readonly runtime: AgentSessionRuntime;
	readonly startedAt: number;
	readonly settled: Promise<void>;
	resolveSettled(): void;
	readonly completion: Promise<void>;
	resolveCompletion(): void;
	interrupted: boolean;
	unsubscribe(): void;
}

interface StartingChild {
	readonly ready: Promise<void>;
	resolveReady(): void;
}

interface Waiter {
	readonly ids: ReadonlySet<string>;
	resolve(): void;
	reject(error: Error): void;
	dispose(): void;
}

function utf8Prefix(value: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let end = maxBytes; end > 0; end--) {
		try {
			return decoder.decode(bytes.slice(0, end));
		} catch {
			// Move to the preceding complete code point.
		}
	}
	return "";
}

function taskSummary(task: string): string {
	const normalized = task.replace(/\s+/g, " ").trim();
	let end = Math.min(normalized.length, 240);
	if (end < normalized.length && /[\uD800-\uDBFF]/u.test(normalized[end - 1]!)) end -= 1;
	return normalized.slice(0, end);
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function lastAssistant(session: AgentSession): { stopReason?: string; errorMessage?: string } | undefined {
	return [...session.messages].reverse().find((candidate) => candidate.role === "assistant") as
		| { stopReason?: string; errorMessage?: string }
		| undefined;
}

function assistantText(session: AgentSession): string | undefined {
	const message = [...session.messages].reverse().find((candidate) => candidate.role === "assistant") as
		| { content?: unknown }
		| undefined;
	if (!message) return undefined;
	if (typeof message.content === "string") return utf8Prefix(message.content, 4 * 1024);
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
	return text ? utf8Prefix(text, 4 * 1024) : undefined;
}

function isInside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isTerminal(status: SubagentStatus): boolean {
	return (
		status === "done" ||
		status === "failed" ||
		status === "stopped" ||
		status === "close_failed" ||
		status === "closed"
	);
}

function summaryFromRecord(record: SubagentDiskRecord): SubagentSummary {
	const config = record.config;
	return {
		agentId: record.agentId,
		name: record.name,
		status: record.status,
		taskSummary: record.taskSummary,
		...(config
			? {
					configuration: {
						mode: config.mode,
						tools: config.tools,
						permissionMode: config.permissionMode,
						model: config.model,
						thinkingLevel: config.thinkingLevel,
						cwd: config.cwd,
						forkTurns: config.forkTurns,
						timeoutSeconds: config.timeoutSeconds,
					},
				}
			: {}),
		...(record.finalSummary ? { finalSummary: record.finalSummary } : {}),
		...(record.error ? { error: record.error } : {}),
		...(record.residualPath ? { residualPath: record.residualPath } : {}),
		...(record.usage ? { usage: record.usage } : {}),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export class SubagentManager implements SubagentManagerApi {
	private readonly parentSessionManager: SessionManager;
	private readonly agentDir: string;
	private readonly workspaceRoots: readonly string[];
	private readonly scheduler: SubagentSchedulerApi;
	private readonly store: SubagentStoreApi;
	private readonly createChildRuntime: CreateChildRuntime;
	private readonly onPermissionRequest?: RequestPermissionApproval;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly hot = new Map<string, HotChild>();
	private readonly starting = new Map<string, StartingChild>();
	private readonly closing = new Set<string>();
	private readonly listeners = new Set<(event: SubagentManagerEvent) => void>();
	private readonly waiters = new Set<Waiter>();
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly scheduleKeys = new Map<string, string>();
	private parent?: AgentSession;
	private unloaded = false;
	private requestSequence = 0;
	private scheduleSequence = 0;

	constructor(options: SubagentManagerOptions) {
		this.parentSessionManager = options.parentSessionManager;
		this.agentDir = options.agentDir;
		this.workspaceRoots = options.workspaceRoots.map((root) => realpathSync(root));
		this.scheduler = options.scheduler ?? defaultSubagentScheduler;
		this.store = options.store ?? new SubagentStore(options.parentSessionManager, options.agentDir);
		this.createChildRuntime = options.createChildRuntime;
		this.onPermissionRequest = options.onPermissionRequest;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? createSessionId;
		this.recoverInterruptedWork();
	}

	attachParent(session: AgentSession): void {
		if (session.sessionManager.getSessionId() !== this.parentSessionManager.getSessionId()) {
			throw new Error("Subagent manager parent session mismatch");
		}
		this.parent = session;
	}

	async spawn(input: SpawnSubagentInput): Promise<SpawnSubagentResult> {
		this.assertActive();
		const parent = this.requireParent();
		if (!input.name || input.name.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) {
			throw new Error("Subagent name must be 1-128 characters with no control characters");
		}
		const summary = taskSummary(input.task);
		if (!summary || utf8Length(input.task) > 2 * 1024 * 1024) {
			throw new Error("Subagent task must be non-empty and at most 2 MiB");
		}
		if (input.role !== undefined && (!input.role || utf8Length(input.role) > 8 * 1024)) {
			throw new Error("Subagent role must be non-empty and at most 8 KiB");
		}
		if (
			input.developerInstructions !== undefined &&
			(!input.developerInstructions || utf8Length(input.developerInstructions) > 64 * 1024)
		) {
			throw new Error("Subagent developer instructions must be non-empty and at most 64 KiB");
		}
		if (input.tools.length > 128) throw new Error("Subagent tools may contain at most 128 names");
		const listing = this.store.list();
		if (listing.diagnostics.length > 0) {
			throw new Error("Cannot create a subagent while an existing child session is unreadable");
		}
		const records = listing.agents;
		if (records.length >= 10) throw new Error("A parent session may own at most 10 non-closed subagents");
		const names = new Set(this.listSummaries().map((summary) => summary.name));
		if (names.has(input.name)) throw new Error(`Subagent name has already been used: ${input.name}`);
		if (new Set(input.tools).size !== input.tools.length) throw new Error("Subagent tools must be unique");
		const reserved = new Set<string>(SUBAGENT_TOOL_NAMES);
		const active = new Set(parent.getActiveToolNames());
		for (const tool of input.tools) {
			if (!tool || tool.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(tool)) {
				throw new Error(`Invalid subagent tool name: ${JSON.stringify(tool)}`);
			}
			if (reserved.has(tool)) throw new Error(`Subagent tool is reserved: ${tool}`);
			if (!active.has(tool)) throw new Error(`Subagent tool is not active in the parent: ${tool}`);
		}
		const parentPermissions = parent.sessionManager.getPermissionSettings();
		const permissionMode = input.permissionMode ?? parentPermissions.mode;
		const strength = { ask: 0, auto: 1, full: 2 } as const;
		if (strength[permissionMode] > strength[parentPermissions.mode])
			throw new Error("Child permissions cannot be broader than parent permissions");
		const model = this.resolveModel(parent, input.model);
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		const thinkingLevel = input.thinkingLevel ?? parent.thinkingLevel;
		if (!levels.includes(thinkingLevel))
			throw new Error(`Thinking level is unavailable for child model: ${thinkingLevel}`);
		const cwd = this.resolveCwd(input.cwd ?? parent.sessionManager.getCwd());
		const timeoutSeconds = input.timeoutSeconds ?? 1_800;
		if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1_800) {
			throw new Error("Subagent timeout must be an integer from 1 through 1800 seconds");
		}
		if (
			input.forkTurns !== undefined &&
			input.forkTurns !== "all" &&
			(!Number.isInteger(input.forkTurns) || input.forkTurns < 1 || input.forkTurns > 1_000)
		) {
			throw new Error('Subagent forkTurns must be "all" or an integer from 1 through 1000');
		}
		const config: SubagentConfig = {
			agentId: this.createId(),
			name: input.name,
			task: input.task,
			taskSummary: summary,
			mode: parent.mode,
			tools: [...input.tools],
			permissionMode,
			reviewerEnabled: parentPermissions.reviewerEnabled,
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel,
			cwd,
			forkTurns: input.forkTurns ?? 0,
			timeoutSeconds,
			...(input.role === undefined ? {} : { role: input.role }),
			...(input.developerInstructions === undefined ? {} : { developerInstructions: input.developerInstructions }),
		};
		this.store.create(config, parent.messages);
		const admission = this.schedule(config.agentId);
		return {
			agentId: config.agentId,
			name: config.name,
			status: admission,
			taskSummary: config.taskSummary,
			mode: config.mode,
			tools: config.tools,
			permissionMode: config.permissionMode,
			forkTurns: config.forkTurns,
		};
	}

	async inspect(input: InspectSubagentsInput): Promise<InspectSubagentsResult> {
		const limit = input.limit ?? 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Inspect limit must be from 1 through 100");
		if (!input.agentId) return { agents: this.listSummaries().slice(0, limit), usage: this.getAggregateUsage() };
		const summary = this.findSummary(input.agentId);
		if (summary.status === "closed") return { agents: [summary], usage: this.getAggregateUsage() };
		const entries = this.visibleJournal(input.agentId);
		const before = input.beforeEntryId
			? entries.findIndex((entry) => entry.type !== "session" && entry.id === input.beforeEntryId)
			: entries.length;
		if (input.beforeEntryId && before < 0) throw new Error(`Unknown child entry cursor: ${input.beforeEntryId}`);
		return { agents: [summary], usage: this.getAggregateUsage(), journal: entries.slice(0, before).slice(-limit) };
	}

	message(input: MessageSubagentInput): Promise<MessageSubagentResult> {
		return this.serialize(input.agentId, async () => {
			this.assertOperable(input.agentId);
			if (!input.message || new TextEncoder().encode(input.message).byteLength > 2 * 1024 * 1024) {
				throw new Error("Subagent message must be non-empty and at most 2 MiB");
			}
			if (!this.isScheduledQueued(input.agentId)) await this.starting.get(input.agentId)?.ready;
			this.assertOperable(input.agentId);
			const hot = this.hot.get(input.agentId);
			if (input.mode === "steer") {
				if (!hot) throw new Error("Steer requires a running subagent; use follow_up to resume cold work");
				await hot.runtime.submitPrompt({
					requestId: this.requestId("steer", input.agentId),
					text: input.message,
					streamingBehavior: "steer",
				});
				return { agentId: input.agentId, status: "running", delivery: "accepted" };
			}
			const messageId = this.requestId("follow-up", input.agentId);
			if (hot) {
				hot.runtime.session.sessionManager.appendSubagentControl({
					type: "subagent_follow_up",
					agentId: input.agentId,
					messageId,
					text: input.message,
					state: "queued",
				});
				await hot.runtime.submitPrompt({
					requestId: messageId,
					text: input.message,
					streamingBehavior: "followUp",
				});
				hot.runtime.session.sessionManager.appendSubagentControl({
					type: "subagent_follow_up",
					agentId: input.agentId,
					messageId,
					text: input.message,
					state: "accepted",
				});
				return { agentId: input.agentId, status: "running", delivery: "accepted" };
			}
			const current = this.store.load(input.agentId);
			if (current.status !== "done" && current.status !== "failed" && current.status !== "stopped") {
				throw new Error(
					current.status === "close_failed"
						? "Subagent close failed; retry close before other operations"
						: "Subagent is queued; wait for it to start",
				);
			}
			this.store.appendFollowUp(input.agentId, {
				type: "subagent_follow_up",
				agentId: input.agentId,
				messageId,
				text: input.message,
				state: "queued",
			});
			this.store.appendState(input.agentId, {
				type: "subagent_state",
				agentId: input.agentId,
				status: "queued",
				reason: "recovered",
			});
			const status = this.schedule(input.agentId);
			return { agentId: input.agentId, status, delivery: "queued" };
		});
	}

	wait(input: WaitSubagentsInput, signal?: AbortSignal): Promise<WaitSubagentsResult> {
		const summaries = this.listSummaries();
		const ids = input.agentIds
			? [...input.agentIds]
			: summaries.filter((summary) => summary.status !== "closed").map((summary) => summary.agentId);
		if (ids.length > 10 || new Set(ids).size !== ids.length)
			throw new Error("wait_agents accepts at most 10 unique agent IDs");
		for (const id of ids) this.findSummary(id);
		const selected = new Set(ids);
		const terminal = summaries.filter((summary) => selected.has(summary.agentId) && isTerminal(summary.status));
		if (terminal.length > 0 || selected.size === 0) return Promise.resolve({ agents: terminal });
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
		return new Promise<WaitSubagentsResult>((resolvePromise, rejectPromise) => {
			const onAbort = (): void =>
				waiter.reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
			const waiter: Waiter = {
				ids: selected,
				resolve: () => {
					waiter.dispose();
					resolvePromise({ agents: this.listSummaries().filter((summary) => selected.has(summary.agentId)) });
				},
				reject: (error) => {
					waiter.dispose();
					rejectPromise(error);
				},
				dispose: () => {
					this.waiters.delete(waiter);
					signal?.removeEventListener("abort", onAbort);
				},
			};
			this.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	interrupt(agentId: string): Promise<SubagentSummary> {
		return this.serialize(agentId, async () => {
			this.assertOperable(agentId);
			if (this.cancelScheduled(agentId)) {
				const record = this.store.appendState(agentId, {
					type: "subagent_state",
					agentId,
					status: "stopped",
					reason: "interrupted",
				});
				return this.emitUpdate(summaryFromRecord(record));
			}
			await this.starting.get(agentId)?.ready;
			this.assertOperable(agentId);
			const hot = this.hot.get(agentId);
			if (!hot) return this.findSummary(agentId);
			hot.interrupted = true;
			await hot.runtime.interrupt({ requestId: this.requestId("interrupt", agentId) });
			await hot.completion;
			return this.findSummary(agentId);
		});
	}

	close(agentId: string): Promise<CloseSubagentResult> {
		if (this.closedTombstones().some((tombstone) => tombstone.agentId === agentId)) {
			return Promise.resolve({ agentId, status: "closed", alreadyClosed: true });
		}
		if (this.closing.has(agentId)) throw new Error(`Subagent is already closing: ${agentId}`);
		this.store.load(agentId);
		this.closing.add(agentId);
		return this.serialize(agentId, async () => {
			try {
				const current = this.store.load(agentId);
				const tombstone: SubagentTombstone = {
					agentId,
					name: current.name,
					status: "closed",
					taskSummary: current.taskSummary,
					...(current.finalSummary ? { finalSummary: current.finalSummary } : {}),
					closedAt: new Date(this.now()).toISOString(),
				};
				this.store.beginClose(agentId, tombstone);
				this.cancelScheduled(agentId);
				await this.starting.get(agentId)?.ready;
				const hot = this.hot.get(agentId);
				if (hot) {
					hot.interrupted = true;
					await hot.runtime.interrupt({ requestId: this.requestId("close", agentId) });
					await hot.completion;
				}
				const result = await this.store.finishClose(agentId);
				if (result.status === "closed") {
					this.emitUpdate(this.findSummary(agentId));
					return { agentId, status: "closed" };
				}
				this.notify(this.findSummary(agentId));
				return { agentId, ...result };
			} finally {
				this.closing.delete(agentId);
			}
		});
	}

	async readJournal(agentId: string): Promise<readonly FileEntry[]> {
		this.assertOperable(agentId);
		return this.store.readJournal(agentId);
	}

	listSummaries(): readonly SubagentSummary[] {
		const active = this.store.list().agents.map((record) => summaryFromRecord(this.store.load(record.agentId)));
		const closed = this.closedTombstones().map(
			(tombstone): SubagentSummary => ({
				agentId: tombstone.agentId,
				name: tombstone.name,
				status: "closed",
				taskSummary: tombstone.taskSummary,
				...(tombstone.finalSummary ? { finalSummary: tombstone.finalSummary } : {}),
				createdAt: tombstone.closedAt,
				updatedAt: tombstone.closedAt,
			}),
		);
		return [...active, ...closed];
	}

	getAggregateUsage(): SubagentUsageTotals {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let elapsedMs = 0;
		let cost = 0;
		let hasCost = false;
		for (const summary of this.listSummaries()) {
			if (!summary.usage) continue;
			input += summary.usage.input;
			output += summary.usage.output;
			cacheRead += summary.usage.cacheRead;
			cacheWrite += summary.usage.cacheWrite;
			elapsedMs += summary.usage.elapsedMs;
			if (summary.usage.cost !== undefined) {
				cost += summary.usage.cost;
				hasCost = true;
			}
		}
		return { input, output, cacheRead, cacheWrite, elapsedMs, ...(hasCost ? { cost } : {}) };
	}

	subscribe(listener: (event: SubagentManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async recoverCloseMarkers(): Promise<void> {
		await this.store.recoverCloseMarkers();
	}

	async unload(reason: "parent_unloaded"): Promise<void> {
		if (this.unloaded) return;
		this.unloaded = true;
		for (const record of this.store.list().agents) {
			this.cancelScheduled(record.agentId);
			await this.starting.get(record.agentId)?.ready;
			const hot = this.hot.get(record.agentId);
			if (hot) {
				hot.interrupted = true;
				await hot.runtime.interrupt({ requestId: this.requestId("unload", record.agentId) });
				await hot.completion;
			} else if (record.status === "queued" || record.status === "running") {
				this.store.appendState(record.agentId, {
					type: "subagent_state",
					agentId: record.agentId,
					status: "stopped",
					reason,
				});
			}
		}
		for (const waiter of [...this.waiters]) waiter.reject(new Error("Subagent manager unloaded"));
	}

	private schedule(agentId: string): "queued" | "running" {
		const key = `${agentId}:${++this.scheduleSequence}`;
		let readyResolved = false;
		let resolveReadyPromise!: () => void;
		const starting: StartingChild = {
			ready: new Promise<void>((resolvePromise) => {
				resolveReadyPromise = resolvePromise;
			}),
			resolveReady: () => {
				if (readyResolved) return;
				readyResolved = true;
				resolveReadyPromise();
			},
		};
		this.scheduleKeys.set(agentId, key);
		this.starting.set(agentId, starting);
		try {
			return this.scheduler.enqueue({
				key,
				parentSessionId: this.parentSessionManager.getSessionId(),
				start: async () => {
					try {
						await this.runChild(agentId, starting);
					} finally {
						if (this.scheduleKeys.get(agentId) === key) this.scheduleKeys.delete(agentId);
					}
				},
			});
		} catch (error) {
			if (this.scheduleKeys.get(agentId) === key) this.scheduleKeys.delete(agentId);
			starting.resolveReady();
			if (this.starting.get(agentId) === starting) this.starting.delete(agentId);
			throw error;
		}
	}

	private cancelScheduled(agentId: string): boolean {
		const key = this.scheduleKeys.get(agentId);
		if (!key || !this.scheduler.cancel(key)) return false;
		if (this.scheduleKeys.get(agentId) === key) this.scheduleKeys.delete(agentId);
		const starting = this.starting.get(agentId);
		starting?.resolveReady();
		if (starting && this.starting.get(agentId) === starting) this.starting.delete(agentId);
		return true;
	}

	private isScheduledQueued(agentId: string): boolean {
		const key = this.scheduleKeys.get(agentId);
		return key !== undefined && this.scheduler.isQueued(key);
	}

	private async runChild(agentId: string, starting: StartingChild): Promise<void> {
		try {
			if (this.closing.has(agentId) || this.unloaded) return;
			await this.runChildLifecycle(agentId, starting.resolveReady);
		} catch (error) {
			if (!this.closing.has(agentId)) {
				try {
					const errorText = error instanceof Error ? error.message : String(error);
					const failed = this.store.appendState(agentId, {
						type: "subagent_state",
						agentId,
						status: "failed",
						reason: "error",
						error: utf8Prefix(errorText, 64 * 1024),
					});
					this.notify(summaryFromRecord(failed));
				} catch {
					// The child journal itself is unavailable; store diagnostics retain the failure.
				}
			}
		} finally {
			starting.resolveReady();
			if (this.starting.get(agentId) === starting) this.starting.delete(agentId);
		}
	}

	private async runChildLifecycle(agentId: string, markReady: () => void): Promise<void> {
		const record = this.store.load(agentId);
		const config = record.config!;
		const childManager = (await import("../session-manager.ts")).SessionManager.open(record.path);
		let runtime: AgentSessionRuntime | undefined;
		try {
			const onPermissionRequest: RequestPermissionApproval = async (request) => {
				const summary = this.findSummary(agentId);
				this.emitApprovalRequired(summary, request.action.toolName);
				if (!this.onPermissionRequest) {
					return { decision: "deny", reason: "No interactive parent session owner is available" };
				}
				return this.onPermissionRequest({
					...request,
					reason: `Subagent ${config.name} (${config.agentId}): ${request.reason}`,
				});
			};
			runtime = await this.createChildRuntime({
				config,
				sessionManager: childManager,
				onPermissionRequest,
			});
			let resolveSettled!: () => void;
			const settled = new Promise<void>((resolvePromise) => {
				resolveSettled = resolvePromise;
			});
			let resolveCompletion!: () => void;
			const completion = new Promise<void>((resolvePromise) => {
				resolveCompletion = resolvePromise;
			});
			const hot: HotChild = {
				runtime,
				startedAt: this.now(),
				settled,
				resolveSettled,
				completion,
				resolveCompletion,
				interrupted: false,
				unsubscribe: () => undefined,
			};
			hot.unsubscribe = runtime.session.subscribe((event) => {
				if (event.type === "agent_settled") hot.resolveSettled();
			});
			this.hot.set(agentId, hot);
			markReady();
			const running = this.appendHotState(runtime, { type: "subagent_state", agentId, status: "running" });
			this.notify(
				summaryFromRecord({ ...record, status: "running", updatedAt: new Date(this.now()).toISOString() }),
			);
			void running;
			const queued = runtime.session.sessionManager
				.getDurableJournalSnapshot()
				.filter(
					(entry) => entry.type === "subagent_follow_up" && entry.agentId === agentId && entry.state === "queued",
				);
			const initial = queued[0]?.type === "subagent_follow_up" ? queued[0] : undefined;
			const text = initial?.text ?? config.task;
			const requestId = initial?.messageId ?? this.requestId("initial", agentId);
			await runtime.submitPrompt({ requestId, text });
			if (initial) {
				runtime.session.sessionManager.appendSubagentControl({
					type: "subagent_follow_up",
					agentId: initial.agentId,
					messageId: initial.messageId,
					text: initial.text,
					state: "accepted",
				});
				for (const follow of queued.slice(1)) {
					if (follow.type !== "subagent_follow_up") continue;
					await runtime.submitPrompt({
						requestId: follow.messageId,
						text: follow.text,
						streamingBehavior: "followUp",
					});
					runtime.session.sessionManager.appendSubagentControl({
						type: "subagent_follow_up",
						agentId: follow.agentId,
						messageId: follow.messageId,
						text: follow.text,
						state: "accepted",
					});
				}
			}
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<"timeout">((resolvePromise) => {
				timeout = setTimeout(() => resolvePromise("timeout"), config.timeoutSeconds * 1_000);
			});
			const outcome = await Promise.race([settled.then(() => "settled" as const), timedOut]);
			if (timeout) clearTimeout(timeout);
			if (outcome === "timeout") {
				hot.interrupted = false;
				await runtime.interrupt({ requestId: this.requestId("timeout", agentId) });
			}
			const stats = runtime.session.getSessionStats();
			const model =
				runtime.session.model ?? ({ provider: config.model.provider, id: config.model.modelId } as Model<any>);
			const usage: SubagentUsage = {
				model: { provider: model.provider, modelId: model.id },
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				elapsedMs: Math.max(0, this.now() - hot.startedAt),
				...(Number.isFinite(stats.cost) ? { cost: stats.cost } : {}),
			};
			const finalSummary = assistantText(runtime.session);
			const assistant = lastAssistant(runtime.session);
			const status =
				outcome === "timeout"
					? "failed"
					: hot.interrupted
						? "stopped"
						: assistant?.stopReason === "error"
							? "failed"
							: "done";
			const reason =
				outcome === "timeout"
					? "timeout"
					: hot.interrupted
						? "interrupted"
						: assistant?.stopReason === "error"
							? "error"
							: "completed";
			const terminalError =
				assistant?.stopReason === "error"
					? (assistant.errorMessage ?? "Child model response ended with an error")
					: undefined;
			hot.unsubscribe();
			await runtime.dispose();
			runtime = undefined;
			const terminal = this.store.appendState(agentId, {
				type: "subagent_state",
				agentId,
				status,
				reason,
				...(finalSummary ? { finalSummary } : {}),
				...(terminalError ? { error: utf8Prefix(terminalError, 64 * 1024) } : {}),
				usage,
			});
			this.hot.delete(agentId);
			this.notify(summaryFromRecord(terminal));
			hot.resolveCompletion();
		} catch (error) {
			const hot = this.hot.get(agentId);
			hot?.unsubscribe();
			const lifecycleErrors: unknown[] = [error];
			try {
				if (runtime) await runtime.dispose();
				else childManager.close();
			} catch (cleanupError) {
				lifecycleErrors.push(cleanupError);
			}
			try {
				if (!this.closing.has(agentId)) {
					const errorText = lifecycleErrors
						.map((failure) => (failure instanceof Error ? failure.message : String(failure)))
						.join("; ");
					const failed = this.store.appendState(agentId, {
						type: "subagent_state",
						agentId,
						status: "failed",
						reason: "error",
						error: utf8Prefix(errorText, 64 * 1024),
					});
					this.notify(summaryFromRecord(failed));
				}
			} finally {
				this.hot.delete(agentId);
				hot?.resolveCompletion();
			}
		}
	}

	private appendHotState(runtime: AgentSessionRuntime, entry: Parameters<SubagentStoreApi["appendState"]>[1]): string {
		return runtime.session.sessionManager.appendSubagentControl(entry);
	}

	private recoverInterruptedWork(): void {
		for (const record of this.store.list().agents) {
			if (record.status !== "queued" && record.status !== "running") continue;
			this.store.appendState(record.agentId, {
				type: "subagent_state",
				agentId: record.agentId,
				status: "stopped",
				reason: "parent_unloaded",
			});
			for (const entry of this.store.readJournal(record.agentId)) {
				if (entry.type !== "subagent_follow_up" || entry.state !== "queued") continue;
				this.store.appendFollowUp(record.agentId, {
					type: "subagent_follow_up",
					agentId: entry.agentId,
					messageId: entry.messageId,
					text: entry.text,
					state: "cancelled",
				});
			}
		}
	}

	private resolveModel(parent: AgentSession, requested: string | undefined): Model<any> {
		if (!requested) {
			if (!parent.model) throw new Error("Parent session has no selected model");
			return parent.model;
		}
		const slash = requested.indexOf("/");
		if (slash <= 0 || slash === requested.length - 1 || requested.indexOf("/", slash + 1) !== -1) {
			throw new Error("Child model must use exact provider/modelId syntax");
		}
		const model = parent.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1));
		if (!model || !parent.modelRegistry.hasConfiguredAuth(model))
			throw new Error(`Child model is unavailable: ${requested}`);
		return model;
	}

	private resolveCwd(value: string): string {
		const path = realpathSync(resolve(value));
		if (!statSync(path).isDirectory()) throw new Error("Subagent cwd must be an existing directory");
		if (!this.workspaceRoots.some((root) => isInside(root, path)))
			throw new Error("Subagent cwd must stay inside an authorized workspace root");
		return path;
	}

	private closedTombstones(): SubagentTombstone[] {
		return this.parentSessionManager
			.getDurableJournalSnapshot()
			.filter(
				(entry): entry is Extract<typeof entry, { type: "subagent_closed" }> => entry.type === "subagent_closed",
			)
			.map((entry) => entry.tombstone);
	}

	private findSummary(agentId: string): SubagentSummary {
		const summary = this.listSummaries().find((candidate) => candidate.agentId === agentId);
		if (!summary) throw new Error(`Unknown subagent: ${agentId}`);
		return summary;
	}

	private emitUpdate(summary: SubagentSummary): SubagentSummary {
		const event: SubagentManagerEvent = { type: "updated", summary };
		for (const listener of this.listeners) listener(event);
		for (const waiter of [...this.waiters]) if (waiter.ids.has(summary.agentId)) waiter.resolve();
		return summary;
	}

	private emitApprovalRequired(summary: SubagentSummary, toolName: string): void {
		const event: SubagentManagerEvent = { type: "approval_required", summary, toolName };
		for (const listener of this.listeners) listener(event);
		for (const waiter of [...this.waiters]) if (waiter.ids.has(summary.agentId)) waiter.resolve();
		if (!this.parent) return;
		this.parent.sessionManager.appendCustomMessageEntry(
			"subagent_status",
			[
				{
					type: "text",
					text: utf8Prefix(
						`Subagent ${summary.name} (${summary.agentId}) requires approval for ${toolName}.`,
						16 * 1024,
					),
				},
			],
			true,
			{ agentId: summary.agentId, name: summary.name, status: summary.status, approvalRequired: true, toolName },
		);
	}

	private visibleJournal(agentId: string): FileEntry[] {
		const result: FileEntry[] = [];
		for (const entry of this.store.readJournal(agentId)) {
			if (entry.type === "message") {
				const copy = structuredClone(entry) as FileEntry & { message?: { content?: unknown; details?: unknown } };
				if (Array.isArray(copy.message?.content)) {
					copy.message.content = copy.message.content.filter(
						(block) =>
							typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "thinking",
					);
				}
				if (copy.message) delete copy.message.details;
				result.push(copy);
			} else if (entry.type === "custom_message" && entry.display) {
				const copy = structuredClone(entry) as FileEntry & { details?: unknown };
				delete copy.details;
				result.push(copy);
			}
		}
		return result;
	}

	private notify(summary: SubagentSummary): void {
		this.emitUpdate(summary);
		if (!this.parent || (summary.status !== "running" && !isTerminal(summary.status))) return;
		const detail = summary.finalSummary ?? summary.error;
		const text = utf8Prefix(
			`Subagent ${summary.name} (${summary.agentId}) is ${summary.status}${detail ? `: ${detail}` : "."}`,
			16 * 1024,
		);
		this.parent.sessionManager.appendCustomMessageEntry("subagent_status", [{ type: "text", text }], true, {
			agentId: summary.agentId,
			name: summary.name,
			status: summary.status,
		});
	}

	private serialize<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(agentId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		this.tails.set(agentId, next);
		void next.then(
			() => {
				if (this.tails.get(agentId) === next) this.tails.delete(agentId);
			},
			() => {
				if (this.tails.get(agentId) === next) this.tails.delete(agentId);
			},
		);
		return next;
	}

	private requestId(kind: string, agentId: string): string {
		return `subagent-${kind}-${agentId}-${++this.requestSequence}`;
	}

	private requireParent(): AgentSession {
		if (!this.parent) throw new Error("Subagent manager has no attached parent session");
		return this.parent;
	}

	private assertActive(): void {
		if (this.unloaded) throw new Error("Subagent manager is unloaded");
	}

	private assertOperable(agentId: string): void {
		this.assertActive();
		if (this.closing.has(agentId)) throw new Error(`Subagent is closing: ${agentId}`);
		const summary = this.findSummary(agentId);
		if (summary.status === "closed") throw new Error(`Subagent is closed: ${agentId}`);
	}
}
