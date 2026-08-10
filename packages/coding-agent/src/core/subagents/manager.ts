import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@metis/agent-core";
import { getSupportedThinkingLevels, type Model } from "@metis/ai/compat";
import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionRuntime } from "../agent-session-runtime.ts";
import { narrowPermissionMode, type PermissionMode } from "../permission-mode.ts";
import type { RequestPermissionApproval } from "../permission-policy.ts";
import { createSessionId } from "../session-id.ts";
import { type FileEntry, SessionManager } from "../session-manager.ts";
import { defaultSubagentScheduler, type SubagentSchedulerApi } from "./scheduler.ts";
import { type SubagentDiskRecord, SubagentStore, type SubagentStoreApi } from "./store.ts";
import {
	SUBAGENT_ACTIVATION_TOOL_NAME,
	SUBAGENT_TOOL_NAMES,
	type SubagentConfig,
	type SubagentForkTurns,
	type SubagentMailboxEvent,
	type SubagentManagerEvent,
	type SubagentStatus,
	type SubagentSummary,
	type SubagentTerminalStatus,
	type SubagentTombstone,
	type SubagentUsage,
} from "./types.ts";

export interface SpawnSubagentInput {
	readonly name: string;
	readonly task: string;
	readonly tools: readonly string[];
	readonly background: boolean;
	readonly role?: string;
	readonly developerInstructions?: string;
	readonly permissionMode?: PermissionMode;
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly cwd?: string;
	readonly forkTurns?: SubagentForkTurns;
	readonly timeoutSeconds?: number;
}

interface SubagentRunResultBase {
	readonly agentId: string;
	readonly runId: string;
	readonly name: string;
	readonly taskSummary: string;
	readonly mode: "chat" | "code";
	readonly tools: readonly string[];
	readonly permissionMode: PermissionMode;
	readonly cwd: string;
	readonly forkTurns: SubagentForkTurns;
}

/** Background calls return receipts; foreground calls return exact-run terminal results. */
export type SpawnSubagentResult =
	| (SubagentRunResultBase & {
			readonly background: true;
			readonly status: "queued" | "running";
	  })
	| (SubagentRunResultBase & {
			readonly background: false;
			readonly status: SubagentTerminalStatus;
			readonly finalSummary?: string;
			readonly error?: string;
			readonly usage?: SubagentUsage;
	  });

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

export type MessageSubagentInput =
	| { readonly agentId: string; readonly mode: "steer"; readonly message: string }
	| {
			readonly agentId: string;
			readonly mode: "follow_up";
			readonly message: string;
			readonly background: boolean;
	  };

export type MessageSubagentResult =
	| { readonly agentId: string; readonly runId: string; readonly status: "running"; readonly delivery: "accepted" }
	| {
			readonly agentId: string;
			readonly runId: string;
			readonly background: true;
			readonly status: "queued" | "running";
			readonly delivery: "accepted" | "queued";
	  }
	| {
			readonly agentId: string;
			readonly runId: string;
			readonly background: false;
			readonly status: SubagentTerminalStatus;
			readonly finalSummary?: string;
			readonly error?: string;
			readonly usage?: SubagentUsage;
	  };

export interface CloseSubagentResult {
	readonly agentId: string;
	readonly status: "closed" | "close_failed";
	readonly alreadyClosed?: boolean;
	readonly residualPath?: string;
	readonly error?: string;
}

export interface ChildRuntimeFactoryInput {
	readonly config: SubagentConfig;
	readonly permissionModeCeiling: () => PermissionMode;
	readonly sessionManager: SessionManager;
	readonly onPermissionRequest?: RequestPermissionApproval;
}

export type CreateChildRuntime = (input: ChildRuntimeFactoryInput) => Promise<AgentSessionRuntime>;

export interface SubagentManagerOptions {
	readonly parentSessionManager: SessionManager;
	readonly agentDir: string;
	readonly getWorkspaceRoots: () => readonly string[];
	readonly scheduler?: SubagentSchedulerApi;
	readonly store?: SubagentStoreApi;
	readonly createChildRuntime: CreateChildRuntime;
	readonly onPermissionRequest?: RequestPermissionApproval;
	readonly now?: () => number;
	readonly createId?: () => string;
}

export interface SubagentManagerApi {
	attachParent(session: AgentSession): void;
	spawn(input: SpawnSubagentInput, signal?: AbortSignal): Promise<SpawnSubagentResult>;
	inspect(input: InspectSubagentsInput): Promise<InspectSubagentsResult>;
	message(input: MessageSubagentInput, signal?: AbortSignal): Promise<MessageSubagentResult>;
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
	readonly runId: string;
	readonly startedAt: number;
	readonly settled: Promise<void>;
	resolveSettled(): void;
	readonly completion: Promise<void>;
	resolveCompletion(): void;
	stopReason?: "interrupted" | "parent_unloaded";
	lifecycleError?: Error;
	unsubscribe(): void;
}

interface StartingChild {
	readonly ready: Promise<void>;
	resolveReady(): void;
}

interface ForegroundRunAdmission {
	readonly join: true;
	readonly agentId: string;
	readonly runId: string;
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

function isTerminal(status: SubagentStatus): status is SubagentTerminalStatus {
	return status === "done" || status === "failed" || status === "stopped";
}

function terminalMailboxEvent(record: SubagentDiskRecord): SubagentMailboxEvent {
	return {
		eventId: `subagent:${record.agentId}:${record.runId}:terminal`,
		runId: record.runId,
		agentId: record.agentId,
		name: record.name,
		type: "terminal",
		status: record.status as SubagentTerminalStatus,
		...(record.finalSummary ? { finalMessage: utf8Prefix(record.finalSummary, 4 * 1024) } : {}),
		...(record.error ? { error: utf8Prefix(record.error, 4 * 1024) } : {}),
		completedAt: record.updatedAt,
	};
}

function summaryFromRecord(record: SubagentDiskRecord, permissionMode?: PermissionMode): SubagentSummary {
	const config = record.config;
	return {
		agentId: record.agentId,
		runId: record.runId,
		name: record.name,
		status: record.status,
		background: record.background,
		taskSummary: record.taskSummary,
		...(config
			? {
					configuration: {
						mode: config.mode,
						tools: config.tools,
						permissionMode: permissionMode ?? config.permissionMode,
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
	private readonly getWorkspaceRoots: () => readonly string[];
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
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly scheduledRuns = new Map<string, { key: string; runId: string }>();
	private readonly childPermissionCeilings = new Map<string, PermissionMode>();
	private readonly unsubscribeParentPermissions: () => void;
	private parent?: AgentSession;
	private unloaded = false;
	private requestSequence = 0;
	private scheduleSequence = 0;

	constructor(options: SubagentManagerOptions) {
		this.parentSessionManager = options.parentSessionManager;
		this.agentDir = options.agentDir;
		this.getWorkspaceRoots = options.getWorkspaceRoots;
		this.scheduler = options.scheduler ?? defaultSubagentScheduler;
		this.store = options.store ?? new SubagentStore(options.parentSessionManager, options.agentDir);
		this.createChildRuntime = options.createChildRuntime;
		this.onPermissionRequest = options.onPermissionRequest;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? createSessionId;
		this.recoverInterruptedWork();
		const parentMode = this.parentSessionManager.getPermissionSettings().mode;
		for (const record of this.store.list().agents) {
			const config = this.store.load(record.agentId).config;
			this.childPermissionCeilings.set(
				record.agentId,
				narrowPermissionMode(config?.permissionMode ?? "ask", parentMode),
			);
		}
		this.unsubscribeParentPermissions = this.parentSessionManager.subscribePermissionSettings((next) => {
			if (next.mode === "ask") this.downgradeChildrenToAsk();
		});
		if (parentMode === "ask") {
			try {
				this.downgradeChildrenToAsk();
			} catch (error) {
				this.unsubscribeParentPermissions();
				throw error;
			}
		}
	}

	attachParent(session: AgentSession): void {
		if (session.sessionManager.getSessionId() !== this.parentSessionManager.getSessionId()) {
			throw new Error("Subagent manager parent session mismatch");
		}
		this.parent = session;
		this.recoverMailboxEvents();
	}

	async spawn(input: SpawnSubagentInput, signal?: AbortSignal): Promise<SpawnSubagentResult> {
		signal?.throwIfAborted();
		this.assertActive();
		if (typeof input.background !== "boolean") throw new Error("Subagent background must be a boolean");
		const parent = this.requireParent();
		if (parent.mode !== "code") throw new Error("Subagents can start only from a Code session");
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
		if (listing.agents.length >= 10) throw new Error("A parent session may own at most 10 non-closed subagents");
		const names = new Set(this.listSummaries().map((summary) => summary.name));
		if (names.has(input.name)) throw new Error(`Subagent name has already been used: ${input.name}`);
		if (new Set(input.tools).size !== input.tools.length) throw new Error("Subagent tools must be unique");
		const reserved = new Set<string>([SUBAGENT_ACTIVATION_TOOL_NAME, ...SUBAGENT_TOOL_NAMES, "set_tasks"]);
		const active = new Set(parent.getActiveToolNames());
		for (const tool of input.tools) {
			if (!tool || tool.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(tool)) {
				throw new Error(`Invalid subagent tool name: ${JSON.stringify(tool)}`);
			}
			if (reserved.has(tool)) throw new Error(`Subagent tool is reserved: ${tool}`);
			if (!active.has(tool)) throw new Error(`Subagent tool is not active in the parent: ${tool}`);
		}
		const parentMode = parent.sessionManager.getPermissionSettings().mode;
		const permissionMode = input.permissionMode ?? parentMode;
		if (parentMode === "ask" && permissionMode === "full") {
			throw new Error("Child permissions cannot be broader than parent permissions");
		}
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
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel,
			cwd,
			forkTurns: input.forkTurns ?? 0,
			timeoutSeconds,
			...(input.role === undefined ? {} : { role: input.role }),
			...(input.developerInstructions === undefined ? {} : { developerInstructions: input.developerInstructions }),
		};
		this.store.create(config, parent.messages);
		this.childPermissionCeilings.set(config.agentId, permissionMode);
		const runId = this.createId();
		this.store.appendState(config.agentId, {
			type: "subagent_state",
			agentId: config.agentId,
			runId,
			status: "queued",
			background: input.background,
		});
		const admission = this.schedule(config.agentId, runId);
		const base: SubagentRunResultBase = {
			agentId: config.agentId,
			runId,
			name: config.name,
			taskSummary: config.taskSummary,
			mode: config.mode,
			tools: config.tools,
			permissionMode: config.permissionMode,
			cwd: config.cwd,
			forkTurns: config.forkTurns,
		};
		if (input.background) return { ...base, background: true, status: admission };
		const terminal = await this.awaitRun(config.agentId, runId, signal);
		if (!isTerminal(terminal.status)) throw new Error(`Foreground subagent run ${runId} did not finish`);
		return {
			...base,
			background: false,
			status: terminal.status,
			...(terminal.finalSummary ? { finalSummary: terminal.finalSummary } : {}),
			...(terminal.error ? { error: terminal.error } : {}),
			...(terminal.usage ? { usage: terminal.usage } : {}),
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

	async message(input: MessageSubagentInput, signal?: AbortSignal): Promise<MessageSubagentResult> {
		const admission = await this.serialize<MessageSubagentResult | ForegroundRunAdmission>(
			input.agentId,
			async () => {
				signal?.throwIfAborted();
				if (this.requireParent().mode !== "code") {
					throw new Error("Legacy Chat subagents are cleanup-only and cannot receive messages");
				}
				this.assertOperable(input.agentId);
				if (!input.message || new TextEncoder().encode(input.message).byteLength > 2 * 1024 * 1024) {
					throw new Error("Subagent message must be non-empty and at most 2 MiB");
				}
				if (input.mode === "follow_up" && typeof input.background !== "boolean") {
					throw new Error("Subagent follow-up background must be a boolean");
				}
				let current = this.store.load(input.agentId);
				const scheduled = this.scheduledRuns.get(input.agentId);
				if (input.mode === "follow_up" && current.status === "queued" && scheduled) {
					const messageId = this.requestId("follow-up", input.agentId);
					this.setLiveRunBackground(current, input.background);
					this.store.appendFollowUp(input.agentId, {
						type: "subagent_follow_up",
						agentId: input.agentId,
						runId: scheduled.runId,
						messageId,
						text: input.message,
						state: "queued",
					});
					return input.background
						? {
								agentId: input.agentId,
								runId: scheduled.runId,
								background: true,
								status: "queued",
								delivery: "queued",
							}
						: { join: true, agentId: input.agentId, runId: scheduled.runId };
				}
				if (!this.isScheduledQueued(input.agentId)) await this.starting.get(input.agentId)?.ready;
				signal?.throwIfAborted();
				this.assertOperable(input.agentId);
				const hot = this.hot.get(input.agentId);
				if (input.mode === "steer") {
					if (!hot) throw new Error("Steer requires a running subagent; use follow_up to resume cold work");
					await hot.runtime.submitPrompt({
						requestId: this.requestId("steer", input.agentId),
						text: input.message,
						streamingBehavior: "steer",
					});
					return { agentId: input.agentId, runId: hot.runId, status: "running", delivery: "accepted" };
				}
				const messageId = this.requestId("follow-up", input.agentId);
				current = this.store.load(input.agentId);
				if (hot && current.runId === hot.runId && current.status === "running") {
					this.setLiveRunBackground(current, input.background, hot);
					hot.runtime.session.sessionManager.appendSubagentControl({
						type: "subagent_follow_up",
						agentId: input.agentId,
						runId: hot.runId,
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
						runId: hot.runId,
						messageId,
						text: input.message,
						state: "accepted",
					});
					return input.background
						? {
								agentId: input.agentId,
								runId: hot.runId,
								background: true,
								status: "running",
								delivery: "accepted",
							}
						: { join: true, agentId: input.agentId, runId: hot.runId };
				}
				if (current.status !== "done" && current.status !== "failed" && current.status !== "stopped") {
					throw new Error(
						current.status === "close_failed"
							? "Subagent close failed; retry close before other operations"
							: "Subagent is queued; wait for it to start",
					);
				}
				const runId = this.createId();
				this.store.appendFollowUp(input.agentId, {
					type: "subagent_follow_up",
					agentId: input.agentId,
					runId,
					messageId,
					text: input.message,
					state: "queued",
				});
				this.store.appendState(input.agentId, {
					type: "subagent_state",
					agentId: input.agentId,
					runId,
					status: "queued",
					reason: "recovered",
					background: input.background,
				});
				const status = this.schedule(input.agentId, runId);
				return input.background
					? { agentId: input.agentId, runId, background: true, status, delivery: "queued" }
					: { join: true, agentId: input.agentId, runId };
			},
		);
		if (!("join" in admission)) return admission;
		const terminal = await this.awaitRun(admission.agentId, admission.runId, signal);
		if (!isTerminal(terminal.status)) throw new Error(`Foreground subagent run ${admission.runId} did not finish`);
		return {
			agentId: admission.agentId,
			runId: admission.runId,
			background: false,
			status: terminal.status,
			...(terminal.finalSummary ? { finalSummary: terminal.finalSummary } : {}),
			...(terminal.error ? { error: terminal.error } : {}),
			...(terminal.usage ? { usage: terminal.usage } : {}),
		};
	}

	interrupt(agentId: string): Promise<SubagentSummary> {
		return this.serialize(agentId, async () => {
			this.assertOperable(agentId);
			const queuedRunId = this.scheduledRuns.get(agentId)?.runId;
			if (this.cancelScheduled(agentId)) {
				this.cancelQueuedFollowUps(agentId);
				const record = this.store.appendState(agentId, {
					type: "subagent_state",
					agentId,
					runId: queuedRunId ?? this.store.load(agentId).runId,
					status: "stopped",
					reason: "interrupted",
				});
				return this.publishTerminal(record);
			}
			await this.starting.get(agentId)?.ready;
			this.assertOperable(agentId);
			const hot = this.hot.get(agentId);
			if (!hot) return this.findSummary(agentId);
			hot.stopReason = "interrupted";
			await hot.runtime.interrupt({ requestId: this.requestId("interrupt", agentId) });
			await hot.completion;
			if (hot.lifecycleError) throw hot.lifecycleError;
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
				const cancelledScheduled = this.cancelScheduled(agentId);
				if (cancelledScheduled) this.cancelQueuedFollowUps(agentId);
				await this.starting.get(agentId)?.ready;
				const hot = this.hot.get(agentId);
				if (hot) {
					hot.stopReason = "interrupted";
					await hot.runtime.interrupt({ requestId: this.requestId("close", agentId) });
					await hot.completion;
				} else this.cancelQueuedFollowUps(agentId);
				const result = await this.store.finishClose(agentId);
				if (result.status === "closed") {
					this.childPermissionCeilings.delete(agentId);
					this.emitUpdate(this.findSummary(agentId));
					return { agentId, status: "closed" };
				}
				this.emitUpdate(this.findSummary(agentId));
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
		const active = this.store.list().agents.map((record) => {
			const loaded = this.store.load(record.agentId);
			return summaryFromRecord(loaded, this.childPermissionCeilings.get(record.agentId));
		});
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
		this.unsubscribeParentPermissions();
		const errors: unknown[] = [];
		for (const record of this.store.list().agents) {
			try {
				const cancelledScheduled = this.cancelScheduled(record.agentId);
				if (cancelledScheduled) this.cancelQueuedFollowUps(record.agentId);
				await this.starting.get(record.agentId)?.ready;
				const hot = this.hot.get(record.agentId);
				if (hot) {
					hot.stopReason = reason;
					await hot.runtime.interrupt({ requestId: this.requestId("unload", record.agentId) });
					await hot.completion;
					if (hot.lifecycleError) errors.push(hot.lifecycleError);
				} else {
					const current = this.store.load(record.agentId);
					if (current.status !== "queued" && current.status !== "running") continue;
					this.cancelQueuedFollowUps(record.agentId);
					this.store.appendState(record.agentId, {
						type: "subagent_state",
						agentId: record.agentId,
						runId: current.runId,
						status: "stopped",
						reason,
					});
				}
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to unload subagents");
	}

	private schedule(agentId: string, runId: string): "queued" | "running" {
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
		this.scheduledRuns.set(agentId, { key, runId });
		this.starting.set(agentId, starting);
		try {
			return this.scheduler.enqueue({
				key,
				parentSessionId: this.parentSessionManager.getSessionId(),
				start: async () => {
					try {
						await this.runChild(agentId, runId, starting);
					} finally {
						if (this.scheduledRuns.get(agentId)?.key === key) this.scheduledRuns.delete(agentId);
					}
				},
			});
		} catch (error) {
			if (this.scheduledRuns.get(agentId)?.key === key) this.scheduledRuns.delete(agentId);
			starting.resolveReady();
			if (this.starting.get(agentId) === starting) this.starting.delete(agentId);
			throw error;
		}
	}

	private cancelScheduled(agentId: string): boolean {
		const scheduled = this.scheduledRuns.get(agentId);
		if (!scheduled || !this.scheduler.cancel(scheduled.key)) return false;
		if (this.scheduledRuns.get(agentId)?.key === scheduled.key) this.scheduledRuns.delete(agentId);
		const starting = this.starting.get(agentId);
		starting?.resolveReady();
		if (starting && this.starting.get(agentId) === starting) this.starting.delete(agentId);
		return true;
	}

	private isScheduledQueued(agentId: string): boolean {
		const scheduled = this.scheduledRuns.get(agentId);
		return scheduled !== undefined && this.scheduler.isQueued(scheduled.key);
	}

	private async runChild(agentId: string, runId: string, starting: StartingChild): Promise<void> {
		try {
			let terminal: SubagentDiskRecord | undefined;
			try {
				if (this.closing.has(agentId) || this.unloaded) return;
				terminal = await this.runChildLifecycle(agentId, runId, starting.resolveReady);
			} catch (error) {
				if (!this.closing.has(agentId)) {
					try {
						const errorText = error instanceof Error ? error.message : String(error);
						terminal = this.store.appendState(agentId, {
							type: "subagent_state",
							agentId,
							runId,
							status: "failed",
							reason: "error",
							error: utf8Prefix(errorText, 64 * 1024),
						});
					} catch {
						// The child journal itself is unavailable; store diagnostics retain the failure.
					}
				}
			}
			if (terminal) this.publishTerminal(terminal);
		} finally {
			const hot = this.hot.get(agentId);
			this.hot.delete(agentId);
			hot?.resolveCompletion();
			starting.resolveReady();
			if (this.starting.get(agentId) === starting) this.starting.delete(agentId);
		}
	}

	private async runChildLifecycle(
		agentId: string,
		runId: string,
		markReady: () => void,
	): Promise<SubagentDiskRecord | undefined> {
		const record = this.store.load(agentId);
		const config = record.config!;
		const childManager = (await import("../session-manager.ts")).SessionManager.open(record.path);
		let runtime: AgentSessionRuntime | undefined;
		try {
			const onPermissionRequest: RequestPermissionApproval = async (request) => {
				const summary = this.findSummary(agentId);
				this.emitApprovalRequired(summary, request.action.toolName);
				if (!this.onPermissionRequest) {
					throw new Error("No interactive parent session owner is available");
				}
				return this.onPermissionRequest({
					...request,
					actor: {
						type: "subagent",
						id: config.agentId,
						name: config.name,
					},
				});
			};
			runtime = await this.createChildRuntime({
				config,
				permissionModeCeiling: () => this.childPermissionCeilings.get(agentId) ?? "ask",
				sessionManager: childManager,
				onPermissionRequest,
			});
			this.persistRuntimeCeiling(runtime, agentId);
			const configuredTools = new Set(config.tools);
			const activeTools = runtime.session.getActiveToolNames();
			const missingTools = config.tools.filter((tool) => !activeTools.includes(tool));
			const unexpectedTools = activeTools.filter((tool) => !configuredTools.has(tool));
			if (missingTools.length > 0 || unexpectedTools.length > 0) {
				throw new Error(
					`Child runtime tool snapshot mismatch (missing: ${missingTools.join(", ") || "none"}; unexpected: ${unexpectedTools.join(", ") || "none"})`,
				);
			}
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
				runId,
				startedAt: this.now(),
				settled,
				resolveSettled,
				completion,
				resolveCompletion,
				unsubscribe: () => undefined,
			};
			const childSession = runtime.session;
			hot.unsubscribe = childSession.subscribe((event) => {
				if (event.type === "agent_settled") hot.resolveSettled();
				if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
					this.emitEvent({
						type: "activity",
						agentId,
						...(childSession.activeDurableTurnId ? { turnId: childSession.activeDurableTurnId } : {}),
						event,
					});
				}
			});
			this.hot.set(agentId, hot);
			markReady();
			this.persistRuntimeCeiling(runtime, agentId);
			const running = this.appendHotState(runtime, { type: "subagent_state", agentId, runId, status: "running" });
			this.emitUpdate(
				summaryFromRecord(
					{ ...record, status: "running", updatedAt: new Date(this.now()).toISOString() },
					this.childPermissionCeilings.get(agentId),
				),
			);
			void running;
			const journal = runtime.session.sessionManager.getDurableJournalSnapshot();
			const initialRun = !journal.some(
				(entry) => entry.type === "subagent_state" && entry.agentId === agentId && entry.runId !== runId,
			);
			const queued = journal.filter(
				(entry) => entry.type === "subagent_follow_up" && entry.agentId === agentId && entry.state === "queued",
			);
			const initial = !initialRun && queued[0]?.type === "subagent_follow_up" ? queued[0] : undefined;
			const text = initialRun ? config.task : initial?.text;
			if (!text) throw new Error("Cold subagent run is missing its queued follow-up");
			const requestId = initial?.messageId ?? this.requestId("initial", agentId);
			await runtime.submitPrompt({ requestId, text });
			if (initial) {
				runtime.session.sessionManager.appendSubagentControl({
					type: "subagent_follow_up",
					agentId: initial.agentId,
					runId,
					messageId: initial.messageId,
					text: initial.text,
					state: "accepted",
				});
			}
			const remaining = initialRun ? queued : queued.slice(1);
			for (const follow of remaining) {
				if (follow.type !== "subagent_follow_up") continue;
				await runtime.submitPrompt({
					requestId: follow.messageId,
					text: follow.text,
					streamingBehavior: "followUp",
				});
				runtime.session.sessionManager.appendSubagentControl({
					type: "subagent_follow_up",
					agentId: follow.agentId,
					runId,
					messageId: follow.messageId,
					text: follow.text,
					state: "accepted",
				});
			}
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<"timeout">((resolvePromise) => {
				timeout = setTimeout(() => resolvePromise("timeout"), config.timeoutSeconds * 1_000);
			});
			const outcome = await Promise.race([settled.then(() => "settled" as const), timedOut]);
			if (timeout) clearTimeout(timeout);
			if (outcome === "timeout") {
				hot.stopReason = undefined;
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
				toolCalls: stats.toolCalls,
				...(Number.isFinite(stats.cost) ? { cost: stats.cost } : {}),
			};
			const finalSummary = assistantText(runtime.session);
			const assistant = lastAssistant(runtime.session);
			const status =
				outcome === "timeout"
					? "failed"
					: hot.stopReason
						? "stopped"
						: assistant?.stopReason === "error"
							? "failed"
							: "done";
			const reason =
				outcome === "timeout"
					? "timeout"
					: (hot.stopReason ?? (assistant?.stopReason === "error" ? "error" : "completed"));
			const terminalError =
				assistant?.stopReason === "error"
					? (assistant.errorMessage ?? "Child model response ended with an error")
					: undefined;
			this.appendHotState(runtime, {
				type: "subagent_state",
				agentId,
				runId,
				status,
				reason,
				...(finalSummary ? { finalSummary } : {}),
				...(terminalError ? { error: utf8Prefix(terminalError, 64 * 1024) } : {}),
				usage,
			});
			hot.unsubscribe();
			await runtime.dispose();
			runtime = undefined;
			const terminal = this.store.load(agentId);
			return terminal;
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
			const errorText = lifecycleErrors
				.map((failure) => (failure instanceof Error ? failure.message : String(failure)))
				.join("; ");
			const firstError = lifecycleErrors[0];
			const lifecycleError =
				lifecycleErrors.length === 1 && firstError instanceof Error
					? firstError
					: new AggregateError(lifecycleErrors, "Subagent lifecycle cleanup failed");
			if (hot) hot.lifecycleError = lifecycleError;
			if (this.closing.has(agentId)) return undefined;
			return this.store.appendState(agentId, {
				type: "subagent_state",
				agentId,
				runId,
				status: hot?.stopReason ? "stopped" : "failed",
				reason: hot?.stopReason ?? "error",
				error: utf8Prefix(errorText, 64 * 1024),
			});
		}
	}

	private appendHotState(runtime: AgentSessionRuntime, entry: Parameters<SubagentStoreApi["appendState"]>[1]): string {
		return runtime.session.sessionManager.appendSubagentControl(entry);
	}

	private cancelQueuedFollowUps(agentId: string): void {
		for (const entry of this.store.readJournal(agentId)) {
			if (entry.type !== "subagent_follow_up" || entry.state !== "queued") continue;
			this.store.appendFollowUp(agentId, {
				type: "subagent_follow_up",
				agentId,
				runId: entry.runId,
				messageId: entry.messageId,
				text: entry.text,
				state: "cancelled",
			});
		}
	}

	private recoverInterruptedWork(): void {
		for (const record of this.store.list().agents) {
			if (record.status !== "queued" && record.status !== "running") continue;
			this.store.appendState(record.agentId, {
				type: "subagent_state",
				agentId: record.agentId,
				runId: record.runId,
				status: "stopped",
				reason: "parent_unloaded",
			});
			for (const entry of this.store.readJournal(record.agentId)) {
				if (entry.type !== "subagent_follow_up" || entry.state !== "queued") continue;
				this.store.appendFollowUp(record.agentId, {
					type: "subagent_follow_up",
					agentId: entry.agentId,
					runId: entry.runId,
					messageId: entry.messageId,
					text: entry.text,
					state: "cancelled",
				});
			}
		}
	}

	private downgradeChildrenToAsk(): void {
		const failures: unknown[] = [];
		for (const record of this.store.list().agents) {
			this.childPermissionCeilings.set(record.agentId, "ask");
		}
		for (const record of this.store.list().agents) {
			const hot = this.hot.get(record.agentId);
			if (hot) {
				try {
					if (hot.runtime.session.sessionManager.getPermissionSettings().mode !== "ask") {
						hot.runtime.session.sessionManager.setPermissionSettings({ mode: "ask" });
					}
				} catch (error) {
					hot.lifecycleError = error instanceof Error ? error : new Error(String(error));
					failures.push(error);
					void hot.runtime.interrupt({
						requestId: this.requestId("permission-downgrade", record.agentId),
					});
				}
				continue;
			}
			if (this.starting.has(record.agentId) && !this.isScheduledQueued(record.agentId)) continue;
			let manager: SessionManager | undefined;
			try {
				manager = SessionManager.open(record.path);
				if (manager.getPermissionSettings().mode !== "ask") manager.setPermissionSettings({ mode: "ask" });
			} catch (error) {
				failures.push(error);
			} finally {
				try {
					manager?.close();
				} catch (error) {
					failures.push(error);
				}
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "Failed to persist Ask permission for every child session");
		}
	}

	private persistRuntimeCeiling(runtime: AgentSessionRuntime, agentId: string): void {
		if (this.childPermissionCeilings.get(agentId) !== "ask") return;
		const manager = runtime.session.sessionManager;
		if (manager.getPermissionSettings().mode !== "ask") manager.setPermissionSettings({ mode: "ask" });
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
		const path = realpathSync(resolve(this.parentSessionManager.getCwd(), value));
		if (!statSync(path).isDirectory()) throw new Error("Subagent cwd must be an existing directory");
		if (!this.getWorkspaceRoots().some((root) => isInside(root, path))) {
			throw new Error("Subagent cwd must stay inside the parent workspace");
		}
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
		this.emitEvent({ type: "updated", summary });
		return summary;
	}

	private emitApprovalRequired(summary: SubagentSummary, toolName: string): void {
		this.emitEvent({ type: "approval_required", summary, toolName });
	}

	private emitEvent(event: SubagentManagerEvent): void {
		for (const listener of this.listeners) listener(event);
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

	private publishTerminal(record: SubagentDiskRecord): SubagentSummary {
		const summary = this.emitUpdate(summaryFromRecord(record, this.childPermissionCeilings.get(record.agentId)));
		if (!isTerminal(record.status) || !record.background || this.unloaded) return summary;

		const event = terminalMailboxEvent(record);
		try {
			if (this.requireParent().enqueueSubagentMailboxEvent(event)) {
				this.emitEvent({ type: "notification_ready", event });
			}
		} catch (error) {
			this.emitEvent({
				type: "notification_failed",
				event,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		return summary;
	}

	private recoverMailboxEvents(): void {
		for (const record of this.store.list().agents.map((item) => this.store.load(item.agentId))) {
			if (isTerminal(record.status) && record.background) this.publishTerminal(record);
		}
	}

	private setLiveRunBackground(record: SubagentDiskRecord, background: boolean, hot?: HotChild): SubagentDiskRecord {
		if (record.status !== "queued" && record.status !== "running") return record;
		if (record.background === background) return record;
		if (background) throw new Error("A foreground run cannot be detached to background");
		const state = {
			type: "subagent_state" as const,
			agentId: record.agentId,
			runId: record.runId,
			status: record.status,
			background: false,
		};
		if (hot?.runId === record.runId) this.appendHotState(hot.runtime, state);
		else this.store.appendState(record.agentId, state);
		const updated = this.store.load(record.agentId);
		this.emitUpdate(summaryFromRecord(updated, this.childPermissionCeilings.get(record.agentId)));
		return updated;
	}

	private async awaitRun(agentId: string, runId: string, signal?: AbortSignal): Promise<SubagentSummary> {
		try {
			for (;;) {
				signal?.throwIfAborted();
				const record = this.store.load(agentId);
				if (record.runId !== runId) throw new Error(`Subagent run changed while awaiting ${runId}`);
				if (isTerminal(record.status)) {
					return summaryFromRecord(record, this.childPermissionCeilings.get(agentId));
				}

				const hot = this.hot.get(agentId);
				const waiting = hot?.runId === runId ? hot.completion : this.starting.get(agentId)?.ready;
				if (!waiting) throw new Error(`Subagent run ${runId} has no live or scheduled owner`);
				await new Promise<void>((resolvePromise, rejectPromise) => {
					const onAbort = (): void =>
						rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
					if (signal?.aborted) {
						onAbort();
						return;
					}
					signal?.addEventListener("abort", onAbort, { once: true });
					void waiting
						.then(resolvePromise, rejectPromise)
						.finally(() => signal?.removeEventListener("abort", onAbort));
				});
			}
		} catch (error) {
			if (signal?.aborted) {
				const current = this.listSummaries().find((summary) => summary.agentId === agentId);
				if (current?.runId === runId && current.status !== "closed") await this.interrupt(agentId);
			}
			throw error;
		}
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
