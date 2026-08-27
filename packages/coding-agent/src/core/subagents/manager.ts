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
import { effectiveAgentToolNames, MAX_AGENT_DEPTH, resolveAgentProfile } from "./profiles.ts";
import { defaultSubagentScheduler, type SubagentSchedulerApi } from "./scheduler.ts";
import {
	type AgentDiskRecord,
	AgentStore,
	type AgentStoreApi,
	agentStatusFromTasks,
	summarizeAgentTask,
} from "./store.ts";
import { agentTaskWindow, projectAgentTrace, utf8Length, utf8Prefix } from "./trace.ts";
import {
	AGENT_TOOL_NAMES,
	type AgentConfig,
	AgentError,
	type AgentForkTurns,
	type AgentMailboxTerminalEvent,
	type AgentManagerEvent,
	type AgentSummary,
	type AgentTaskSummary,
	type AgentTombstone,
	type AgentType,
	type AgentUsage,
	type AgentUsageTotals,
	type DeleteAgentResult,
	type InspectAgentsInput,
	type InspectAgentsResult,
	type InterruptAgentResult,
	MAX_AGENT_INPUT_UTF8_BYTES,
	MAX_AGENT_MAILBOX_PENDING_EVENTS,
	MAX_AGENT_QUEUED_TASKS,
	MAX_AGENT_TASKS,
	type WaitAgentsInput,
	type WaitAgentsResult,
} from "./types.ts";
import { type AgentWaitHandle, normalizeWaitAgentIds, resolveWaiters, waitAgentsSnapshot } from "./wait.ts";

export interface SpawnAgentInput {
	readonly name: string;
	readonly task: string;
	readonly agentType?: AgentType;
	readonly forkTurns?: AgentForkTurns;
	readonly model?: string;
}

export interface AgentTaskReceipt {
	readonly agentId: string;
	readonly taskId: string;
	readonly status: "queued" | "running";
}

export interface SpawnAgentReceipt extends AgentTaskReceipt {
	readonly name: string;
	readonly agentType: AgentType;
	readonly tools: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
}

export interface ChildRuntimeFactoryInput {
	readonly config: AgentConfig;
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
	readonly store?: AgentStoreApi;
	readonly createChildRuntime: CreateChildRuntime;
	readonly onPermissionRequest?: RequestPermissionApproval;
	readonly now?: () => number;
	readonly createId?: () => string;
}

export interface SubagentManagerApi {
	attachActor(session: AgentSession): () => void;
	spawn(actorId: string, input: SpawnAgentInput, signal?: AbortSignal): Promise<SpawnAgentReceipt>;
	inspect(actorId: string, input: InspectAgentsInput): Promise<InspectAgentsResult>;
	sendMessage(
		actorId: string,
		input: { readonly agentId: string; readonly message: string },
		signal?: AbortSignal,
	): Promise<{ readonly agentId: string; readonly taskId: string; readonly delivery: "accepted" }>;
	followUpTask(
		actorId: string,
		input: { readonly agentId: string; readonly task: string },
		signal?: AbortSignal,
	): Promise<AgentTaskReceipt>;
	interrupt(actorId: string, agentId: string): Promise<InterruptAgentResult>;
	waitAgents(actorId: string, input: WaitAgentsInput, signal?: AbortSignal): Promise<WaitAgentsResult>;
	setArchived(actorId: string, agentId: string, archived: boolean): Promise<AgentSummary>;
	deleteAgent(actorId: string, agentId: string): Promise<DeleteAgentResult>;
	listSummaries(actorId: string, includeArchived?: boolean): readonly AgentSummary[];
	listTasks(agentId: string): readonly AgentTaskSummary[];
	assertCanEnterPlan(actorId: string): void;
	readJournal(actorId: string, agentId: string): Promise<readonly FileEntry[]>;
	subscribe(listener: (event: AgentManagerEvent) => void): () => void;
	unload(reason: "parent_unloaded"): Promise<void>;
}

interface HotChild {
	readonly runtime: AgentSessionRuntime;
	readonly taskId: string;
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

interface AttachedActor {
	readonly session: AgentSession;
	readonly unsubscribePermissions: () => void;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function selectChildThinkingLevel(
	parentLevel: ThinkingLevel,
	supported: readonly ThinkingLevel[],
): ThinkingLevel | undefined {
	const parentRank = THINKING_LEVELS.indexOf(parentLevel);
	for (let index = parentRank; index >= 0; index -= 1) {
		const level = THINKING_LEVELS[index];
		if (level && supported.includes(level)) return level;
	}
	return undefined;
}

function taskAssistant(
	journal: readonly FileEntry[],
	taskId: string,
): { readonly content?: unknown; readonly stopReason?: string; readonly errorMessage?: string } | undefined {
	const window = agentTaskWindow(journal, taskId);
	if (!window) return undefined;
	const entry = journal
		.slice(window.start, window.end + 1)
		.reverse()
		.find((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
	return entry?.type === "message"
		? (entry.message as { readonly content?: unknown; readonly stopReason?: string; readonly errorMessage?: string })
		: undefined;
}

function assistantText(message: { readonly content?: unknown } | undefined): string | undefined {
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

function assistantHasToolCalls(message: { readonly content?: unknown } | undefined): boolean {
	return (
		Array.isArray(message?.content) &&
		message.content.some(
			(block) =>
				typeof block === "object" && block !== null && (block as { readonly type?: unknown }).type === "toolCall",
		)
	);
}

function isInside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isTerminalTaskStatus(status: AgentTaskSummary["status"]): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}

function terminalMailboxEvent(record: AgentDiskRecord, task: AgentTaskSummary): AgentMailboxTerminalEvent {
	return {
		eventId: `agent:${record.agentId}:${task.taskId}:terminal`,
		taskId: task.taskId,
		agentId: record.agentId,
		parentSessionId: record.config.parentSessionId,
		name: record.name,
		type: "terminal",
		status: task.status as "done" | "failed" | "stopped",
		...(task.finalMessage ? { finalMessage: utf8Prefix(task.finalMessage, 4 * 1024) } : {}),
		...(task.error ? { error: utf8Prefix(task.error, 4 * 1024) } : {}),
		completedAt: task.updatedAt,
	};
}

function taskText(journal: readonly FileEntry[], taskId: string): string {
	const entry = [...journal]
		.reverse()
		.find((candidate) => candidate.type === "agent_task" && candidate.taskId === taskId);
	if (!entry || entry.type !== "agent_task") throw new Error(`Unknown agent task: ${taskId}`);
	return entry.text;
}

export class SubagentManager implements SubagentManagerApi {
	private readonly parentSessionManager: SessionManager;
	private readonly agentDir: string;
	private readonly getWorkspaceRoots: () => readonly string[];
	private readonly scheduler: SubagentSchedulerApi;
	private readonly store: AgentStoreApi;
	private readonly createChildRuntime: CreateChildRuntime;
	private readonly onPermissionRequest?: RequestPermissionApproval;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly hot = new Map<string, HotChild>();
	private readonly starting = new Map<string, StartingChild>();
	private readonly deleting = new Set<string>();
	private readonly actors = new Map<string, AttachedActor>();
	private readonly listeners = new Set<(event: AgentManagerEvent) => void>();
	private readonly waiters = new Set<AgentWaitHandle>();
	private readonly approvalRequests = new Map<string, { readonly taskId: string; readonly toolName: string }>();
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly scheduledRuns = new Map<string, string>();
	private readonly childPermissionCeilings = new Map<string, PermissionMode>();
	private readonly rootSessionId: string;
	private unloaded = false;
	private requestSequence = 0;

	constructor(options: SubagentManagerOptions) {
		this.parentSessionManager = options.parentSessionManager;
		this.rootSessionId = options.parentSessionManager.getSessionId();
		this.agentDir = options.agentDir;
		this.getWorkspaceRoots = options.getWorkspaceRoots;
		this.scheduler = options.scheduler ?? defaultSubagentScheduler;
		this.store = options.store ?? new AgentStore(options.parentSessionManager, options.agentDir);
		this.createChildRuntime = options.createChildRuntime;
		this.onPermissionRequest = options.onPermissionRequest;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? createSessionId;
		this.recoverInterruptedWork();
		for (const record of this.store.listTree().agents) {
			this.childPermissionCeilings.set(record.agentId, record.config.permissionMode);
		}
	}

	attachActor(session: AgentSession): () => void {
		const sessionId = session.sessionManager.getSessionId();
		if (this.actors.has(sessionId)) {
			throw new Error(`Agent actor is already attached: ${sessionId}`);
		}
		const attached: AttachedActor = {
			session,
			unsubscribePermissions: session.sessionManager.subscribePermissionSettings((next) => {
				this.narrowDescendantsTo(sessionId, next.mode);
			}),
		};
		this.actors.set(sessionId, attached);
		if (
			sessionId === this.rootSessionId ||
			this.store.listTree().agents.some((record) => record.agentId === sessionId)
		) {
			this.narrowDescendantsTo(sessionId, session.sessionManager.getPermissionSettings().mode);
		}
		this.recoverMailboxEvents(session);
		return () => {
			const current = this.actors.get(sessionId);
			if (current === attached) {
				current.unsubscribePermissions();
				this.actors.delete(sessionId);
			}
		};
	}

	async spawn(actorId: string, input: SpawnAgentInput, signal?: AbortSignal): Promise<SpawnAgentReceipt> {
		signal?.throwIfAborted();
		this.assertActive();
		const actor = this.requireActor(actorId);
		if (actor.mode !== "code") throw new AgentError("INVALID_STATE", "Agents can start only from a Code session");
		if (
			!input.name ||
			input.name.trim() !== input.name ||
			input.name.length > 128 ||
			/[\u0000-\u001f\u007f-\u009f]/u.test(input.name)
		) {
			throw new AgentError(
				"INVALID_INPUT",
				"Agent name must be 1-128 trimmed characters with no control characters",
			);
		}
		if (actorId !== this.rootSessionId) this.assertOperable(actorId);
		const summary = summarizeAgentTask(input.task);
		if (!summary || utf8Length(input.task) > MAX_AGENT_INPUT_UTF8_BYTES) {
			throw new AgentError("INVALID_INPUT", "Agent task must be non-empty and at most 64 KiB");
		}
		if (
			input.forkTurns !== undefined &&
			input.forkTurns !== "all" &&
			(!Number.isInteger(input.forkTurns) || input.forkTurns < 1 || input.forkTurns > 1_000)
		) {
			throw new AgentError("INVALID_INPUT", 'Agent forkTurns must be "all" or an integer from 1 through 1000');
		}
		const tree = this.store.listTree();
		if (tree.diagnostics.length > 0) {
			throw new AgentError("INVALID_STATE", "Cannot create an agent while an existing child session is unreadable");
		}
		if (
			tree.agents.flatMap((record) => record.tasks).filter((task) => task.status === "queued").length >=
			MAX_AGENT_QUEUED_TASKS
		) {
			throw new AgentError("QUEUE_FULL", `Agent task queue is limited to ${MAX_AGENT_QUEUED_TASKS} tasks`);
		}
		const actorPath = this.actorPath(actorId);
		const depth = actorPath.length + 1;
		if (depth > MAX_AGENT_DEPTH) {
			throw new AgentError("DEPTH_LIMIT", `Agent depth cannot exceed ${MAX_AGENT_DEPTH}`);
		}
		const names = new Set(tree.agents.map((candidate) => candidate.name));
		for (const tombstone of this.store.listTombstones()) names.add(tombstone.name);
		if (names.has(input.name))
			throw new AgentError("INVALID_INPUT", `Agent name has already been used: ${input.name}`);
		const agentType = input.agentType ?? "default";
		const inheritedWriteDenied =
			actor.sessionManager.getCollaborationMode() === "plan" ||
			actor.sessionManager.getHeader()?.agent?.writePolicy === "deny";
		const profile = resolveAgentProfile({
			agentType,
			parentTools: actor.getDelegatableToolNames(inheritedWriteDenied ? "deny" : "inherit"),
			depth,
		});
		const parentMode = actor.sessionManager.getPermissionSettings().mode;
		const model = this.resolveModel(actor, input.model);
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		const thinkingLevel = selectChildThinkingLevel(actor.thinkingLevel, levels);
		if (!thinkingLevel) throw new AgentError("MODEL_UNAVAILABLE", "Child model has no supported thinking level");
		const cwd = this.resolveCwd(actor.sessionManager.getCwd());
		const agentId = this.createId();
		const taskId = this.createId();
		const config: AgentConfig = {
			agentId,
			name: input.name,
			agentType: profile.agentType,
			initialTask: input.task,
			tools: [...profile.tools],
			writePolicy: inheritedWriteDenied ? "deny" : profile.writePolicy,
			permissionMode: parentMode,
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel,
			cwd,
			forkTurns: input.forkTurns ?? 0,
			timeoutSeconds: 1_800,
			mayDelegate: profile.mayDelegate,
			parentSessionId: actorId,
			rootSessionId: this.rootSessionId,
			agentPath: [...actorPath, agentId],
		};
		this.store.create(config, actor.messages, taskId);
		this.childPermissionCeilings.set(agentId, parentMode);
		const status = this.scheduleNext(agentId) ?? "queued";
		this.emitUpdate(this.buildSummary(this.store.load(agentId)));
		return {
			agentId,
			taskId,
			status,
			name: config.name,
			agentType: config.agentType,
			tools: effectiveAgentToolNames(config),
			writePolicy: config.writePolicy,
			mayDelegate: config.mayDelegate,
		};
	}

	async inspect(actorId: string, input: InspectAgentsInput): Promise<InspectAgentsResult> {
		const limit = input.limit ?? 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new AgentError("INVALID_INPUT", "Inspect limit must be from 1 through 100");
		}
		if (!input.agentId) {
			if (input.taskId || input.beforeEventId) {
				throw new AgentError("INVALID_INPUT", "inspect_agents requires agentId with taskId or beforeEventId");
			}
			const summaries = this.listSummaries(actorId);
			return {
				kind: "list",
				agents: summaries.slice(0, limit),
				usage: this.aggregateUsage(summaries),
			};
		}
		const record = this.assertDescendant(actorId, input.agentId);
		const summary = this.buildSummary(record);
		const taskId = input.taskId ?? summary.currentTask?.taskId ?? summary.latestTask?.taskId;
		if (!taskId) throw new AgentError("UNKNOWN_TASK", `Agent has no tasks: ${input.agentId}`);
		if (input.taskId && !this.store.listTasks(input.agentId).some((task) => task.taskId === input.taskId)) {
			throw new AgentError("UNKNOWN_TASK", `Unknown agent task: ${input.taskId}`);
		}
		const trace = projectAgentTrace({
			journal: this.store.readJournal(input.agentId),
			taskId,
			beforeEventId: input.beforeEventId,
			limit,
		});
		return { kind: "trace", agent: summary, taskId, ...trace };
	}

	async sendMessage(
		actorId: string,
		input: { readonly agentId: string; readonly message: string },
		signal?: AbortSignal,
	): Promise<{ readonly agentId: string; readonly taskId: string; readonly delivery: "accepted" }> {
		signal?.throwIfAborted();
		this.assertDescendant(actorId, input.agentId);
		this.assertOperable(input.agentId);
		if (!input.message || utf8Length(input.message) > MAX_AGENT_INPUT_UTF8_BYTES) {
			throw new AgentError("INVALID_INPUT", "Agent message must be non-empty and at most 64 KiB");
		}
		const hot = this.hot.get(input.agentId);
		if (!hot) {
			throw new AgentError("INVALID_STATE", "send_message requires a running agent task");
		}
		const messageId = this.requestId("message", input.agentId);
		hot.runtime.session.sessionManager.appendAgentControl({
			type: "agent_message",
			agentId: input.agentId,
			taskId: hot.taskId,
			messageId,
			text: input.message,
			state: "accepted",
		});
		try {
			await hot.runtime.submitPrompt({ requestId: messageId, text: input.message, streamingBehavior: "steer" });
		} catch (error) {
			try {
				hot.runtime.session.sessionManager.appendAgentControl({
					type: "agent_message",
					agentId: input.agentId,
					taskId: hot.taskId,
					messageId,
					text: input.message,
					state: "cancelled",
				});
			} catch (compensationError) {
				throw new AggregateError(
					[error, compensationError],
					"Agent message admission and cancellation both failed",
				);
			}
			throw error;
		}
		return { agentId: input.agentId, taskId: hot.taskId, delivery: "accepted" };
	}

	async followUpTask(
		actorId: string,
		input: { readonly agentId: string; readonly task: string },
		signal?: AbortSignal,
	): Promise<AgentTaskReceipt> {
		signal?.throwIfAborted();
		const actor = this.requireActor(actorId);
		const record = this.assertDescendant(actorId, input.agentId);
		this.assertOperable(input.agentId);
		if (actor.sessionManager.getCollaborationMode() === "plan" && record.config.writePolicy !== "deny") {
			throw new AgentError("INVALID_STATE", "Writable agents cannot receive follow-up tasks in Plan mode");
		}
		const tree = this.store.listTree();
		const archivedIds = new Set(
			tree.agents.filter((candidate) => candidate.archived).map((candidate) => candidate.agentId),
		);
		if (record.config.agentPath.some((agentId) => archivedIds.has(agentId))) {
			throw new AgentError("INVALID_STATE", "Archived agents must be unarchived before follow-up tasks");
		}
		const summary = summarizeAgentTask(input.task);
		if (!summary || utf8Length(input.task) > MAX_AGENT_INPUT_UTF8_BYTES) {
			throw new AgentError("INVALID_INPUT", "Agent task must be non-empty and at most 64 KiB");
		}
		const tasks = this.store.listTasks(input.agentId);
		if (tasks.length >= MAX_AGENT_TASKS) {
			throw new AgentError("QUEUE_FULL", `Agent task history is limited to ${MAX_AGENT_TASKS} tasks`);
		}
		if (
			tree.agents.flatMap((candidate) => candidate.tasks).filter((task) => task.status === "queued").length >=
			MAX_AGENT_QUEUED_TASKS
		) {
			throw new AgentError("QUEUE_FULL", `Agent task queue is limited to ${MAX_AGENT_QUEUED_TASKS} tasks`);
		}
		const taskId = this.createId();
		const hot = this.hot.get(input.agentId);
		if (hot) {
			hot.runtime.session.sessionManager.appendAgentControl({
				type: "agent_task",
				agentId: input.agentId,
				taskId,
				text: input.task,
				taskSummary: summary,
				status: "queued",
			});
		} else {
			this.store.appendTask(input.agentId, { taskId, text: input.task, status: "queued" });
		}
		const status = this.scheduleNext(input.agentId) ?? "queued";
		this.emitUpdate(this.buildSummary(this.store.load(input.agentId)));
		return { agentId: input.agentId, taskId, status };
	}

	interrupt(actorId: string, agentId: string): Promise<InterruptAgentResult> {
		return this.serialize(agentId, () => this.interruptNow(actorId, agentId));
	}

	waitAgents(actorId: string, input: WaitAgentsInput, signal?: AbortSignal): Promise<WaitAgentsResult> {
		signal?.throwIfAborted();
		this.assertActive();
		this.requireActor(actorId);
		const timeoutMs = input.timeoutMs ?? 30_000;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) {
			throw new AgentError("INVALID_INPUT", "wait_agents timeoutMs must be from 10 through 300000");
		}
		const summaries = this.listSummaries(actorId, true);
		const ids = normalizeWaitAgentIds(input.agentIds);
		for (const id of ids) this.assertDescendant(actorId, id);
		const selected = new Set(ids);
		const immediate = this.waitAgentsSnapshot(actorId, summaries, selected);
		if (immediate) return Promise.resolve(immediate);
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
		}
		return new Promise<WaitAgentsResult>((resolvePromise, rejectPromise) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const onAbort = (): void =>
				waiter.reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
			const waiter: AgentWaitHandle = {
				actorId,
				ids: selected,
				snapshot: () => this.waitAgentsSnapshot(actorId, this.listSummaries(actorId, true), selected),
				resolve: (result) => {
					waiter.dispose();
					resolvePromise(result);
				},
				reject: (error) => {
					waiter.dispose();
					rejectPromise(error);
				},
				dispose: () => {
					this.waiters.delete(waiter);
					if (timeout) clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
				},
			};
			this.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
			timeout = setTimeout(() => {
				waiter.resolve({
					timedOut: true,
					agents: this.listSummaries(actorId, true).filter((summary) => selected.has(summary.agentId)),
					mailboxEventIds: [],
				});
			}, timeoutMs);
			const afterRegister = this.waitAgentsSnapshot(actorId, this.listSummaries(actorId, true), selected);
			if (afterRegister) waiter.resolve(afterRegister);
		});
	}

	deleteAgent(actorId: string, agentId: string): Promise<DeleteAgentResult> {
		return this.serialize(agentId, async () => {
			const target = this.assertDescendant(actorId, agentId);
			if (this.deleting.has(agentId)) {
				throw new AgentError("INVALID_STATE", `Agent is already deleting: ${agentId}`);
			}
			const subtree = this.store
				.listTree()
				.agents.filter((record) =>
					target.config.agentPath.every((id, index) => record.config.agentPath[index] === id),
				)
				.sort((left, right) => right.config.agentPath.length - left.config.agentPath.length);
			const overlap = subtree.find((record) => this.deleting.has(record.agentId));
			if (overlap) {
				throw new AgentError("INVALID_STATE", `Agent tree overlaps an active deletion: ${overlap.agentId}`);
			}
			for (const record of subtree) this.deleting.add(record.agentId);
			try {
				for (const record of subtree) {
					await this.interruptNow(actorId, record.agentId, { allowDeleting: true });
				}
				const tombstones = subtree.map(
					(record): AgentTombstone => ({
						agentId: record.agentId,
						name: record.name,
						status: "deleted",
						deletedAt: new Date(this.now()).toISOString(),
					}),
				);
				this.store.beginDeleteGroup(agentId, tombstones);
				const result = await this.store.finishDeleteGroup(agentId);
				for (const deletedId of result.deletedAgentIds) this.childPermissionCeilings.delete(deletedId);
				if (result.deletedAgentIds.length > 0) {
					this.emitEvent({ type: "deleted", agentId, deletedAgentIds: result.deletedAgentIds });
				}
				if (result.status !== "deleted") {
					return {
						agentId,
						status: result.status,
						...(result.residualPath ? { residualPath: result.residualPath } : {}),
						error: `Failed to delete agent tree: ${result.error ?? "unknown error"}`,
					};
				}
				return { agentId, status: "deleted" };
			} finally {
				for (const record of subtree) this.deleting.delete(record.agentId);
			}
		});
	}

	setArchived(actorId: string, agentId: string, archived: boolean): Promise<AgentSummary> {
		this.assertDescendant(actorId, agentId);
		return this.serialize(agentId, async () => {
			this.assertOperable(agentId);
			const record = this.store.load(agentId);
			const records = this.store.listTree().agents;
			const archivedIds = new Set(
				records.filter((candidate) => candidate.archived).map((candidate) => candidate.agentId),
			);
			if (!archived && record.config.agentPath.slice(0, -1).some((id) => archivedIds.has(id))) {
				throw new AgentError("INVALID_STATE", "Archived ancestors must be unarchived first");
			}
			const status = agentStatusFromTasks(record.tasks);
			const activeDescendant = records.some(
				(candidate) =>
					candidate.config.agentPath.length > record.config.agentPath.length &&
					record.config.agentPath.every((id, index) => candidate.config.agentPath[index] === id) &&
					["queued", "running"].includes(agentStatusFromTasks(candidate.tasks)),
			);
			if (status === "running" || status === "queued" || activeDescendant) {
				throw new AgentError("INVALID_STATE", "Only terminal agents can be archived");
			}
			this.store.setArchived(agentId, archived);
			return this.emitUpdate(this.buildSummary(this.store.load(agentId)));
		});
	}

	async readJournal(actorId: string, agentId: string): Promise<readonly FileEntry[]> {
		this.assertDescendant(actorId, agentId);
		this.assertKnown(agentId);
		return this.store.readJournal(agentId);
	}

	listSummaries(actorId: string, includeArchived = false): readonly AgentSummary[] {
		this.requireActor(actorId);
		const actorPath = this.actorPath(actorId);
		const records = this.store.listTree().agents;
		const archivedIds = new Set(records.filter((record) => record.archived).map((record) => record.agentId));
		return records
			.filter((record) => {
				if (!includeArchived && record.config.agentPath.some((id) => archivedIds.has(id))) return false;
				return this.isDescendantPath(actorPath, record.config.agentPath);
			})
			.map((record) => this.buildSummary(record))
			.sort(
				(left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.agentId.localeCompare(left.agentId),
			);
	}

	listTasks(agentId: string): readonly AgentTaskSummary[] {
		this.assertKnown(agentId);
		return this.store.listTasks(agentId);
	}

	assertCanEnterPlan(actorId: string): void {
		this.requireActor(actorId);
		const actorPath = this.actorPath(actorId);
		const writable = this.store
			.listTree()
			.agents.find(
				(record) =>
					this.isDescendantPath(actorPath, record.config.agentPath) &&
					record.config.writePolicy !== "deny" &&
					["queued", "running"].includes(agentStatusFromTasks(record.tasks)),
			);
		if (writable) {
			throw new AgentError("INVALID_STATE", `Stop writable agent ${writable.name} before entering Plan mode`);
		}
	}

	subscribe(listener: (event: AgentManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async unload(reason: "parent_unloaded"): Promise<void> {
		if (this.unloaded) return;
		this.unloaded = true;
		for (const waiter of [...this.waiters]) {
			waiter.reject(new AgentError("INVALID_STATE", "Agent manager is unloaded"));
		}
		this.waiters.clear();
		this.approvalRequests.clear();
		for (const actor of this.actors.values()) actor.unsubscribePermissions();
		this.actors.clear();
		const errors: unknown[] = [];
		for (const record of this.store.listTree().agents) {
			try {
				this.cancelScheduled(record.agentId);
				await this.starting.get(record.agentId)?.ready;
				const hot = this.hot.get(record.agentId);
				if (hot) {
					hot.stopReason = reason;
					await hot.runtime.interrupt({ requestId: this.requestId("unload", record.agentId) });
					await hot.completion;
					if (hot.lifecycleError) errors.push(hot.lifecycleError);
				}
				for (const task of this.store.listTasks(record.agentId)) {
					if (task.status !== "queued" && task.status !== "running") continue;
					this.appendTaskState(record.agentId, { taskId: task.taskId, status: "stopped", reason });
				}
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to unload agents");
	}

	private scheduleNext(agentId: string): "queued" | "running" | undefined {
		if (this.unloaded || this.deleting.has(agentId)) return undefined;
		if (this.hot.has(agentId) || this.starting.has(agentId)) return undefined;
		const task = this.store.listTasks(agentId).find((candidate) => candidate.status === "queued");
		if (!task) return undefined;
		return this.schedule(agentId, task.taskId);
	}

	private schedule(agentId: string, taskId: string): "queued" | "running" {
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
		this.scheduledRuns.set(agentId, taskId);
		this.starting.set(agentId, starting);
		try {
			return this.scheduler.enqueue({
				key: taskId,
				parentSessionId: this.rootSessionId,
				start: async () => {
					try {
						await this.runChild(agentId, taskId, starting);
					} finally {
						if (this.scheduledRuns.get(agentId) === taskId) this.scheduledRuns.delete(agentId);
					}
				},
			});
		} catch (error) {
			if (this.scheduledRuns.get(agentId) === taskId) this.scheduledRuns.delete(agentId);
			starting.resolveReady();
			if (this.starting.get(agentId) === starting) this.starting.delete(agentId);
			throw error;
		}
	}

	private cancelScheduled(agentId: string): boolean {
		const taskId = this.scheduledRuns.get(agentId);
		if (!taskId || !this.scheduler.cancel(taskId)) return false;
		if (this.scheduledRuns.get(agentId) === taskId) this.scheduledRuns.delete(agentId);
		const starting = this.starting.get(agentId);
		starting?.resolveReady();
		if (starting && this.starting.get(agentId) === starting) this.starting.delete(agentId);
		return true;
	}

	private async runChild(agentId: string, taskId: string, starting: StartingChild): Promise<void> {
		let completedHot: HotChild | undefined;
		try {
			let terminalTask: AgentTaskSummary | undefined;
			try {
				if (this.deleting.has(agentId) || this.unloaded) return;
				terminalTask = await this.runChildLifecycle(agentId, taskId, starting.resolveReady);
			} catch (error) {
				if (!this.deleting.has(agentId)) {
					try {
						const errorText = error instanceof Error ? error.message : String(error);
						this.appendTaskState(agentId, {
							taskId,
							status: "failed",
							reason: "error",
							error: utf8Prefix(errorText, 64 * 1024),
						});
						terminalTask = this.store.listTasks(agentId).find((task) => task.taskId === taskId);
					} catch {
						// The child journal itself is unavailable; store diagnostics retain the failure.
					}
				}
			}
			if (terminalTask && isTerminalTaskStatus(terminalTask.status)) {
				completedHot = this.hot.get(agentId);
				this.hot.delete(agentId);
				this.publishTerminal(this.store.load(agentId), terminalTask);
			}
		} finally {
			const hot = completedHot ?? this.hot.get(agentId);
			this.hot.delete(agentId);
			hot?.resolveCompletion();
			starting.resolveReady();
			if (this.starting.get(agentId) === starting) this.starting.delete(agentId);
			this.scheduleNext(agentId);
		}
	}

	private async runChildLifecycle(
		agentId: string,
		taskId: string,
		markReady: () => void,
	): Promise<AgentTaskSummary | undefined> {
		const record = this.store.load(agentId);
		const config = record.config;
		const childManager = SessionManager.open(record.path);
		let runtime: AgentSessionRuntime | undefined;
		try {
			const onPermissionRequest: RequestPermissionApproval = async (request) => {
				const summary = this.buildSummary(this.store.load(agentId));
				this.approvalRequests.set(config.agentId, { taskId, toolName: request.action.toolName });
				this.emitApprovalRequired(summary, taskId, request.action.toolName);
				this.notifyApprovalWaiters(config.agentId);
				try {
					if (!this.onPermissionRequest) {
						throw new Error("No interactive parent session owner is available");
					}
					return await this.onPermissionRequest({
						...request,
						actor: {
							type: "agent",
							id: config.agentId,
							name: config.name,
							taskId,
						},
					});
				} finally {
					this.approvalRequests.delete(config.agentId);
				}
			};
			runtime = await this.createChildRuntime({
				config,
				permissionModeCeiling: () => this.childPermissionCeilings.get(agentId) ?? "ask",
				sessionManager: childManager,
				onPermissionRequest,
			});
			this.persistRuntimeCeiling(runtime, agentId);
			const configuredTools = new Set([...config.tools, ...(config.mayDelegate ? AGENT_TOOL_NAMES : [])]);
			const activeTools = runtime.session.getActiveToolNames();
			const missingTools = [...configuredTools].filter((tool) => !activeTools.includes(tool));
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
				taskId,
				startedAt: this.now(),
				settled,
				resolveSettled,
				completion,
				resolveCompletion,
				unsubscribe: () => undefined,
			};
			const childSession = runtime.session;
			hot.unsubscribe = childSession.subscribe((event) => {
				if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
					this.emitEvent({ type: "activity", agentId, taskId, event });
				}
				if (event.type === "agent_settled") hot.resolveSettled();
			});
			this.hot.set(agentId, hot);
			markReady();
			this.persistRuntimeCeiling(runtime, agentId);
			this.appendHotTaskState(runtime, {
				taskId,
				status: "running",
			});
			this.emitUpdate(this.buildSummary(this.store.load(agentId)));
			const text = taskText(runtime.session.sessionManager.getDurableJournalSnapshot(), taskId);
			const baselineStats = runtime.session.getSessionStats();
			await runtime.submitPrompt({ requestId: this.requestId("task", agentId), text });
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
			const usage: AgentUsage = {
				model: { provider: model.provider, modelId: model.id },
				input: Math.max(0, stats.tokens.input - baselineStats.tokens.input),
				output: Math.max(0, stats.tokens.output - baselineStats.tokens.output),
				cacheRead: Math.max(0, stats.tokens.cacheRead - baselineStats.tokens.cacheRead),
				cacheWrite: Math.max(0, stats.tokens.cacheWrite - baselineStats.tokens.cacheWrite),
				elapsedMs: Math.max(0, this.now() - hot.startedAt),
				toolCalls: Math.max(0, stats.toolCalls - baselineStats.toolCalls),
				...(Number.isFinite(stats.cost) && Number.isFinite(baselineStats.cost)
					? { cost: Math.max(0, stats.cost - baselineStats.cost) }
					: {}),
			};
			const assistant = taskAssistant(runtime.session.sessionManager.getDurableJournalSnapshot(), taskId);
			const status =
				outcome === "timeout"
					? "failed"
					: hot.stopReason
						? "stopped"
						: assistant?.stopReason === "aborted"
							? "stopped"
							: assistant?.stopReason === "error"
								? "failed"
								: "done";
			const reason =
				outcome === "timeout"
					? "timeout"
					: (hot.stopReason ??
						(assistant?.stopReason === "error"
							? "error"
							: assistant?.stopReason === "aborted"
								? "interrupted"
								: "completed"));
			const terminalError =
				outcome === "timeout"
					? `Agent task timed out after ${config.timeoutSeconds} seconds`
					: assistant?.stopReason === "error"
						? (assistant.errorMessage ?? "Child model response ended with an error")
						: undefined;
			const finalMessage =
				status === "done" && !assistantHasToolCalls(assistant) ? assistantText(assistant) : undefined;
			this.appendHotTaskState(runtime, {
				taskId,
				status,
				reason,
				...(finalMessage ? { finalMessage } : {}),
				...(terminalError ? { error: utf8Prefix(terminalError, 64 * 1024) } : {}),
				usage,
			});
			hot.unsubscribe();
			await runtime.dispose();
			runtime = undefined;
			return this.store.listTasks(agentId).find((task) => task.taskId === taskId);
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
					: new AggregateError(lifecycleErrors, "Agent lifecycle cleanup failed");
			if (hot) hot.lifecycleError = lifecycleError;
			if (this.deleting.has(agentId)) return undefined;
			this.appendTaskState(agentId, {
				taskId,
				status: hot?.stopReason ? "stopped" : "failed",
				reason: hot?.stopReason ?? "error",
				error: utf8Prefix(errorText, 64 * 1024),
			});
			return this.store.listTasks(agentId).find((task) => task.taskId === taskId);
		}
	}

	private appendHotTaskState(
		runtime: AgentSessionRuntime,
		input: {
			readonly taskId: string;
			readonly status: AgentTaskSummary["status"];
			readonly reason?: "completed" | "error" | "timeout" | "interrupted" | "parent_unloaded" | "recovered";
			readonly finalMessage?: string;
			readonly error?: string;
			readonly usage?: AgentUsage;
		},
	): string {
		const journal = runtime.session.sessionManager.getDurableJournalSnapshot();
		const prior = [...journal]
			.reverse()
			.find((entry) => entry.type === "agent_task" && entry.taskId === input.taskId);
		if (!prior || prior.type !== "agent_task") throw new Error(`Unknown agent task: ${input.taskId}`);
		return runtime.session.sessionManager.appendAgentControl({
			type: "agent_task",
			agentId: prior.agentId,
			taskId: input.taskId,
			text: prior.text,
			taskSummary: prior.taskSummary,
			status: input.status,
			...(input.reason ? { reason: input.reason } : {}),
			...(input.finalMessage ? { finalMessage: input.finalMessage } : {}),
			...(input.error ? { error: input.error } : {}),
			...(input.usage ? { usage: input.usage } : {}),
		});
	}

	private appendTaskState(
		agentId: string,
		input: {
			readonly taskId: string;
			readonly status: AgentTaskSummary["status"];
			readonly reason?: "completed" | "error" | "timeout" | "interrupted" | "parent_unloaded" | "recovered";
			readonly finalMessage?: string;
			readonly error?: string;
			readonly usage?: AgentUsage;
		},
	): void {
		const hot = this.hot.get(agentId);
		if (hot) {
			this.appendHotTaskState(hot.runtime, input);
			return;
		}
		this.store.appendTaskState(agentId, input);
	}

	private async interruptNow(
		actorId: string,
		agentId: string,
		options: { readonly allowDeleting?: boolean } = {},
	): Promise<InterruptAgentResult> {
		this.assertDescendant(actorId, agentId);
		if (!options.allowDeleting) this.assertOperable(agentId);
		const existingTasks = this.store.listTasks(agentId);
		if (
			!this.hot.has(agentId) &&
			!existingTasks.some((task) => task.status === "queued" || task.status === "running")
		) {
			const latest = existingTasks.at(-1);
			if (latest && isTerminalTaskStatus(latest.status)) {
				return {
					agentId,
					taskId: latest.taskId,
					status: latest.status as "done" | "failed" | "stopped",
					cancelledTaskIds: [],
				};
			}
		}
		const cancelledTaskIds: string[] = [];
		const cancelledTasks: AgentTaskSummary[] = [];
		for (const task of this.store.listTasks(agentId)) {
			if (task.status !== "queued") continue;
			this.appendTaskState(agentId, {
				taskId: task.taskId,
				status: "stopped",
				reason: "interrupted",
			});
			cancelledTaskIds.push(task.taskId);
			const stopped = this.store.listTasks(agentId).find((candidate) => candidate.taskId === task.taskId);
			if (stopped) cancelledTasks.push(stopped);
		}
		this.cancelScheduled(agentId);
		for (const task of cancelledTasks) this.publishTerminal(this.store.load(agentId), task);
		await this.starting.get(agentId)?.ready;
		const hot = this.hot.get(agentId);
		if (hot) {
			hot.stopReason = "interrupted";
			await hot.runtime.interrupt({ requestId: this.requestId("interrupt", agentId) });
			await hot.completion;
			if (hot.lifecycleError) throw hot.lifecycleError;
		}
		const tasks = this.store.listTasks(agentId);
		const running = tasks.find((task) => task.taskId === hot?.taskId);
		const latest = tasks.at(-1);
		const status =
			running?.status === "done" || running?.status === "failed"
				? running.status
				: latest?.status === "done" || latest?.status === "failed"
					? latest.status
					: "stopped";
		return {
			agentId,
			taskId: hot?.taskId ?? latest?.taskId,
			status,
			cancelledTaskIds,
		};
	}

	private isScheduledQueued(agentId: string): boolean {
		const taskId = this.scheduledRuns.get(agentId);
		return taskId !== undefined && this.scheduler.isQueued(taskId);
	}

	private recoverInterruptedWork(): void {
		for (const record of this.store.listTree().agents) {
			for (const task of record.tasks) {
				if (task.status !== "queued" && task.status !== "running") continue;
				this.appendTaskState(record.agentId, {
					taskId: task.taskId,
					status: "stopped",
					reason: "parent_unloaded",
				});
			}
		}
	}

	private narrowDescendantsTo(actorId: string, parentMode: PermissionMode): void {
		const actorPath = this.actorPath(actorId);
		const records = this.store
			.listTree()
			.agents.filter((record) => this.isDescendantPath(actorPath, record.config.agentPath));
		const changed = records.filter((record) => {
			const current = this.childPermissionCeilings.get(record.agentId) ?? "ask";
			return narrowPermissionMode(current, parentMode) !== current;
		});
		if (changed.length === 0) return;
		const failures: unknown[] = [];
		for (const record of changed) {
			const current = this.childPermissionCeilings.get(record.agentId) ?? "ask";
			this.childPermissionCeilings.set(record.agentId, narrowPermissionMode(current, parentMode));
		}
		for (const record of changed) {
			const ceiling = this.childPermissionCeilings.get(record.agentId) ?? "ask";
			const hot = this.hot.get(record.agentId);
			if (hot) {
				try {
					const manager = hot.runtime.session.sessionManager;
					const target = narrowPermissionMode(manager.getPermissionSettings().mode, ceiling);
					if (manager.getPermissionSettings().mode !== target) {
						manager.setPermissionSettings({ mode: target });
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
				const target = narrowPermissionMode(manager.getPermissionSettings().mode, ceiling);
				if (manager.getPermissionSettings().mode !== target) manager.setPermissionSettings({ mode: target });
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
			throw new AggregateError(failures, "Failed to persist narrowed permission for every child session");
		}
	}

	private persistRuntimeCeiling(runtime: AgentSessionRuntime, agentId: string): void {
		const ceiling = this.childPermissionCeilings.get(agentId) ?? "ask";
		const manager = runtime.session.sessionManager;
		const target = narrowPermissionMode(manager.getPermissionSettings().mode, ceiling);
		if (manager.getPermissionSettings().mode !== target) manager.setPermissionSettings({ mode: target });
	}

	private resolveModel(parent: AgentSession, requested: string | undefined): Model<any> {
		if (!requested) {
			if (!parent.model) throw new AgentError("MODEL_UNAVAILABLE", "Parent session has no selected model");
			return parent.model;
		}
		const slash = requested.indexOf("/");
		if (slash <= 0 || slash === requested.length - 1 || requested.length > 512 || /\s/u.test(requested)) {
			throw new AgentError("INVALID_INPUT", "Child model must use exact provider/modelId syntax");
		}
		const registry = parent.modelRegistry as {
			find(provider: string, modelId: string): Model<any> | undefined;
			hasConfiguredAuth(model: Model<any>): boolean;
		};
		const model = registry.find(requested.slice(0, slash), requested.slice(slash + 1));
		if (!model || !registry.hasConfiguredAuth(model)) {
			throw new AgentError("MODEL_UNAVAILABLE", `Child model is unavailable: ${requested}`);
		}
		return model;
	}

	private resolveCwd(value: string): string {
		const path = realpathSync(resolve(this.parentSessionManager.getCwd(), value));
		if (!statSync(path).isDirectory())
			throw new AgentError("INVALID_INPUT", "Agent cwd must be an existing directory");
		if (!this.getWorkspaceRoots().some((root) => isInside(root, path))) {
			throw new AgentError("INVALID_INPUT", "Agent cwd must stay inside the parent workspace");
		}
		return path;
	}

	private buildSummary(record: AgentDiskRecord): AgentSummary {
		const tasks = record.tasks;
		const hot = this.hot.get(record.agentId);
		const running =
			tasks.find((task) => task.taskId === hot?.taskId) ?? tasks.find((task) => task.status === "running");
		const current = running ?? tasks.find((task) => task.status === "queued");
		const latest = tasks.at(-1);
		const status = hot ? "running" : agentStatusFromTasks(tasks);
		const createdAt = tasks[0]?.createdAt ?? new Date(this.now()).toISOString();
		const updatedAt = tasks.reduce(
			(latestTimestamp, task) => (task.updatedAt > latestTimestamp ? task.updatedAt : latestTimestamp),
			createdAt,
		);
		return {
			agentId: record.agentId,
			name: record.name,
			agentType: record.config.agentType,
			depth: record.config.agentPath.length,
			status,
			archived: record.archived,
			tools: effectiveAgentToolNames(record.config),
			writePolicy: record.config.writePolicy,
			mayDelegate: record.config.mayDelegate,
			tasks,
			parentSessionId: record.config.parentSessionId,
			rootSessionId: record.config.rootSessionId,
			agentPath: record.config.agentPath,
			...(current ? { currentTask: current } : {}),
			...(latest ? { latestTask: latest } : {}),
			createdAt,
			updatedAt,
		};
	}

	private aggregateUsage(summaries: readonly AgentSummary[]): AgentUsageTotals {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let elapsedMs = 0;
		let cost = 0;
		let hasCost = false;
		for (const summary of summaries) {
			for (const task of summary.tasks) {
				const usage = task.usage;
				if (!usage) continue;
				input += usage.input;
				output += usage.output;
				cacheRead += usage.cacheRead;
				cacheWrite += usage.cacheWrite;
				elapsedMs += usage.elapsedMs;
				if (usage.cost !== undefined) {
					cost += usage.cost;
					hasCost = true;
				}
			}
		}
		return { input, output, cacheRead, cacheWrite, elapsedMs, ...(hasCost ? { cost } : {}) };
	}

	private assertDescendant(actorId: string, targetAgentId: string): AgentDiskRecord {
		const target = this.loadKnown(targetAgentId);
		const actorPath = this.actorPath(actorId);
		if (target.agentId === actorId) {
			throw new AgentError("NOT_DESCENDANT", "An agent cannot target itself");
		}
		if (target.config.agentPath.length <= actorPath.length) {
			throw new AgentError("NOT_DESCENDANT", "Agent is not a descendant");
		}
		if (actorPath.some((id, index) => target.config.agentPath[index] !== id)) {
			throw new AgentError("NOT_DESCENDANT", "Agent is not a descendant");
		}
		return target;
	}

	private isDescendantPath(actorPath: readonly string[], targetPath: readonly string[]): boolean {
		if (targetPath.length <= actorPath.length) return false;
		return actorPath.every((id, index) => targetPath[index] === id);
	}

	private actorPath(actorId: string): readonly string[] {
		if (actorId === this.rootSessionId) return [];
		return [...this.loadKnown(actorId).config.agentPath];
	}

	private emitUpdate(summary: AgentSummary): AgentSummary {
		this.emitEvent({ type: "updated", summary });
		return summary;
	}

	private emitApprovalRequired(summary: AgentSummary, taskId: string, toolName: string): void {
		this.emitEvent({ type: "approval_required", summary, taskId, toolName });
	}

	private waitAgentsSnapshot(
		actorId: string,
		summaries: readonly AgentSummary[],
		selected: ReadonlySet<string>,
	): WaitAgentsResult | undefined {
		return waitAgentsSnapshot(summaries, selected, this.pendingMailboxEventIds(actorId), this.approvalRequests);
	}

	private pendingMailboxEventIds(actorId: string): readonly string[] {
		return this.actors.get(actorId)?.session.getPendingAgentMailboxEventIds() ?? [];
	}

	private notifyMailboxWaiters(actorId: string): void {
		for (const waiter of this.waiters) {
			if (waiter.actorId !== actorId) continue;
			const result = waiter.snapshot();
			if (result) waiter.resolve(result);
		}
	}

	private notifyApprovalWaiters(agentId: string): void {
		resolveWaiters(this.waiters, agentId);
	}

	private emitEvent(event: AgentManagerEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private publishTerminal(record: AgentDiskRecord, task: AgentTaskSummary): AgentSummary {
		const summary = this.emitUpdate(this.buildSummary(record));
		if (!isTerminalTaskStatus(task.status) || this.unloaded) return summary;
		const event = terminalMailboxEvent(record, task);
		const mailboxEvent = event;
		const parentId = record.config.parentSessionId;
		try {
			const hotParent = this.actors.get(parentId)?.session;
			let accepted = hotParent?.enqueueAgentMailboxEvent(mailboxEvent) ?? false;
			if (!hotParent) {
				const manager =
					parentId === this.rootSessionId
						? this.parentSessionManager
						: SessionManager.open(this.store.load(parentId).path);
				try {
					const journal = manager.getDurableJournalSnapshot();
					const exists = journal.some(
						(entry) => entry.type === "agent_mailbox_event" && entry.event.eventId === event.eventId,
					);
					if (!exists) {
						if (this.pendingMailboxCount(journal) >= MAX_AGENT_MAILBOX_PENDING_EVENTS) {
							throw new Error("Agent mailbox is full");
						}
						manager.appendAgentControl({ type: "agent_mailbox_event", event: mailboxEvent });
					}
					accepted = !exists;
				} finally {
					if (manager !== this.parentSessionManager) manager.close();
				}
			}
			if (accepted) {
				this.emitEvent({ type: "notification_ready", event });
				this.notifyMailboxWaiters(parentId);
			}
		} catch (error) {
			this.emitEvent({
				type: "notification_failed",
				event,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		resolveWaiters(this.waiters, record.agentId);
		return summary;
	}

	private pendingMailboxCount(journal: readonly FileEntry[]): number {
		const pending = new Set<string>();
		const started = new Set<string>();
		for (const entry of journal) {
			if (entry.type === "agent_mailbox_event") {
				pending.add(entry.event.eventId);
				continue;
			}
			if (entry.type !== "agent_mailbox_delivery") continue;
			const key = `${entry.deliveryId}\n${JSON.stringify(entry.eventIds)}`;
			if (entry.state === "started") started.add(key);
			else if (started.has(key)) for (const eventId of entry.eventIds) pending.delete(eventId);
		}
		return pending.size;
	}

	private recoverMailboxEvents(session: AgentSession): void {
		for (const record of this.store.listTree().agents) {
			for (const task of record.tasks) {
				if (!isTerminalTaskStatus(task.status)) continue;
				if (record.config.parentSessionId !== session.sessionManager.getSessionId()) continue;
				const event = terminalMailboxEvent(record, task);
				if (session.hasAgentMailboxEvent(event.eventId)) continue;
				this.publishTerminal(record, task);
			}
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
		return `agent-${kind}-${agentId}-${++this.requestSequence}`;
	}

	private requireActor(actorId: string): AgentSession {
		const attached = this.actors.get(actorId);
		if (!attached) throw new AgentError("INVALID_STATE", `Unknown agent actor: ${actorId}`);
		return attached.session;
	}

	private assertActive(): void {
		if (this.unloaded) throw new AgentError("INVALID_STATE", "Agent manager is unloaded");
	}

	private assertKnown(agentId: string): void {
		this.loadKnown(agentId);
	}

	private loadKnown(agentId: string): AgentDiskRecord {
		this.assertActive();
		try {
			return this.store.load(agentId);
		} catch {
			throw new AgentError("UNKNOWN_AGENT", `Unknown agent: ${agentId}`);
		}
	}

	private assertOperable(agentId: string): void {
		this.assertKnown(agentId);
		if (this.deleting.has(agentId)) throw new AgentError("INVALID_STATE", `Agent is deleting: ${agentId}`);
	}
}
