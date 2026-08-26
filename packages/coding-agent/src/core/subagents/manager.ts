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
import { resolveAgentProfile } from "./profiles.ts";
import { defaultSubagentScheduler, type SubagentSchedulerApi } from "./scheduler.ts";
import { type AgentDiskRecord, AgentStore, type AgentStoreApi, agentStatusFromTasks } from "./store.ts";
import {
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
} from "./types.ts";

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
	readonly maxDepth?: number;
}

export interface SubagentManagerApi {
	attachActor(session: AgentSession): () => void;
	spawn(
		actorId: string,
		input: SpawnAgentInput,
		signal?: AbortSignal,
	): Promise<AgentTaskReceipt & { readonly name: string; readonly agentType: AgentType }>;
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
	setArchived(actorId: string, agentId: string, archived: boolean): Promise<AgentSummary>;
	deleteAgent(actorId: string, agentId: string): Promise<DeleteAgentResult>;
	listSummaries(actorId: string, includeArchived?: boolean): readonly AgentSummary[];
	listTasks(agentId: string): readonly AgentTaskSummary[];
	readJournal(actorId: string, agentId: string): Promise<readonly FileEntry[]>;
	subscribe(listener: (event: AgentManagerEvent) => void): () => void;
	recoverDeleteMarkers(): Promise<void>;
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

const DEFAULT_MAX_DEPTH = 2;

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
	private readonly maxDepth: number;
	private readonly hot = new Map<string, HotChild>();
	private readonly starting = new Map<string, StartingChild>();
	private readonly deleting = new Set<string>();
	private readonly actors = new Map<string, AttachedActor>();
	private readonly listeners = new Set<(event: AgentManagerEvent) => void>();
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
		this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
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
				this.narrowChildrenTo(next.mode);
			}),
		};
		this.actors.set(sessionId, attached);
		if (sessionId === this.rootSessionId) {
			this.narrowChildrenTo(session.sessionManager.getPermissionSettings().mode);
			this.recoverMailboxEvents(session);
		}
		return () => {
			const current = this.actors.get(sessionId);
			if (current === attached) {
				current.unsubscribePermissions();
				this.actors.delete(sessionId);
			}
		};
	}

	async spawn(
		actorId: string,
		input: SpawnAgentInput,
		signal?: AbortSignal,
	): Promise<AgentTaskReceipt & { name: string; agentType: AgentType }> {
		signal?.throwIfAborted();
		this.assertActive();
		const actor = this.requireActor(actorId);
		if (actor.mode !== "code") throw new AgentError("INVALID_STATE", "Agents can start only from a Code session");
		if (!input.name || input.name.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) {
			throw new AgentError("INVALID_INPUT", "Agent name must be 1-128 characters with no control characters");
		}
		const summary = taskSummary(input.task);
		if (!summary || utf8Length(input.task) > 2 * 1024 * 1024) {
			throw new AgentError("INVALID_INPUT", "Agent task must be non-empty and at most 2 MiB");
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
		const actorPath = this.actorPath(actorId);
		const depth = actorPath.length + 1;
		if (depth > this.maxDepth) {
			throw new AgentError("DEPTH_LIMIT", `Agent depth cannot exceed ${this.maxDepth}`);
		}
		const names = new Set(
			this.listSummaries(actorId, true)
				.filter((candidate) => !candidate.archived)
				.map((candidate) => candidate.name),
		);
		if (names.has(input.name))
			throw new AgentError("INVALID_INPUT", `Agent name has already been used: ${input.name}`);
		const agentType = input.agentType ?? "default";
		const profile = resolveAgentProfile({
			agentType,
			parentTools: actor.getActiveToolNames(),
			depth,
			maxDepth: this.maxDepth,
		});
		const parentMode = actor.sessionManager.getPermissionSettings().mode;
		const model = this.resolveModel(actor, input.model);
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		const thinkingLevel = actor.thinkingLevel;
		if (!levels.includes(thinkingLevel)) {
			throw new AgentError("MODEL_UNAVAILABLE", `Thinking level is unavailable for child model: ${thinkingLevel}`);
		}
		const cwd = this.resolveCwd(actor.sessionManager.getCwd());
		const agentId = this.createId();
		const taskId = this.createId();
		const config: AgentConfig = {
			agentId,
			name: input.name,
			agentType: profile.agentType,
			initialTask: input.task,
			tools: [...profile.tools],
			writePolicy: profile.writePolicy,
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
		return { agentId, taskId, status, name: config.name, agentType: config.agentType };
	}

	async inspect(actorId: string, input: InspectAgentsInput): Promise<InspectAgentsResult> {
		const limit = input.limit ?? 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new AgentError("INVALID_INPUT", "Inspect limit must be from 1 through 100");
		}
		if (!input.agentId) {
			return {
				kind: "list",
				agents: this.listSummaries(actorId).slice(0, limit),
				usage: this.aggregateUsage(this.listSummaries(actorId)),
			};
		}
		const record = this.assertDescendant(actorId, input.agentId);
		const summary = this.buildSummary(record);
		const taskId = input.taskId ?? summary.currentTask?.taskId ?? summary.latestTask?.taskId;
		if (!taskId) throw new AgentError("UNKNOWN_TASK", `Agent has no tasks: ${input.agentId}`);
		if (input.taskId && !this.store.listTasks(input.agentId).some((task) => task.taskId === input.taskId)) {
			throw new AgentError("UNKNOWN_TASK", `Unknown agent task: ${input.taskId}`);
		}
		return { kind: "trace", agent: summary, taskId, events: [] };
	}

	async sendMessage(
		actorId: string,
		input: { readonly agentId: string; readonly message: string },
		signal?: AbortSignal,
	): Promise<{ readonly agentId: string; readonly taskId: string; readonly delivery: "accepted" }> {
		signal?.throwIfAborted();
		this.assertDescendant(actorId, input.agentId);
		this.assertOperable(input.agentId);
		if (!input.message || utf8Length(input.message) > 2 * 1024 * 1024) {
			throw new AgentError("INVALID_INPUT", "Agent message must be non-empty and at most 2 MiB");
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
		await hot.runtime.submitPrompt({ requestId: messageId, text: input.message, streamingBehavior: "steer" });
		return { agentId: input.agentId, taskId: hot.taskId, delivery: "accepted" };
	}

	async followUpTask(
		actorId: string,
		input: { readonly agentId: string; readonly task: string },
		signal?: AbortSignal,
	): Promise<AgentTaskReceipt> {
		signal?.throwIfAborted();
		this.assertDescendant(actorId, input.agentId);
		this.assertOperable(input.agentId);
		const record = this.store.load(input.agentId);
		if (record.archived) {
			throw new AgentError("INVALID_STATE", "Archived agents must be unarchived before follow-up tasks");
		}
		const summary = taskSummary(input.task);
		if (!summary || utf8Length(input.task) > 2 * 1024 * 1024) {
			throw new AgentError("INVALID_INPUT", "Agent task must be non-empty and at most 2 MiB");
		}
		const queued = this.store.listTasks(input.agentId).filter((task) => task.status === "queued");
		if (queued.length >= 32) throw new AgentError("QUEUE_FULL", "Agent task queue is full");
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
		return { agentId: input.agentId, taskId, status };
	}

	interrupt(actorId: string, agentId: string): Promise<InterruptAgentResult> {
		return this.serialize(agentId, () => this.interruptNow(actorId, agentId));
	}

	deleteAgent(actorId: string, agentId: string): Promise<DeleteAgentResult> {
		this.assertDescendant(actorId, agentId);
		return this.serialize(agentId, async () => {
			if (this.deleting.has(agentId)) {
				throw new AgentError("INVALID_STATE", `Agent is already deleting: ${agentId}`);
			}
			try {
				await this.interruptNow(actorId, agentId);
				this.deleting.add(agentId);
				const record = this.store.load(agentId);
				const latestTask = this.store.listTasks(agentId).at(-1);
				const tombstone: AgentTombstone = {
					agentId,
					name: record.name,
					status: "deleted",
					taskSummary: latestTask?.taskSummary ?? taskSummary(record.config.initialTask),
					...(latestTask?.finalMessage ? { finalMessage: latestTask.finalMessage } : {}),
					deletedAt: new Date(this.now()).toISOString(),
				};
				this.store.beginDelete(agentId, tombstone);
				const result = await this.store.finishDelete(agentId);
				if (result.status === "deleted") this.childPermissionCeilings.delete(agentId);
				return { agentId, ...result };
			} finally {
				this.deleting.delete(agentId);
			}
		});
	}

	async setArchived(actorId: string, agentId: string, archived: boolean): Promise<AgentSummary> {
		this.assertDescendant(actorId, agentId);
		const status = agentStatusFromTasks(this.store.listTasks(agentId));
		if (archived && (status === "running" || status === "queued")) {
			throw new AgentError("INVALID_STATE", "Only terminal agents can be archived");
		}
		this.store.setArchived(agentId, archived);
		return this.emitUpdate(this.buildSummary(this.store.load(agentId)));
	}

	async readJournal(actorId: string, agentId: string): Promise<readonly FileEntry[]> {
		this.assertDescendant(actorId, agentId);
		this.assertKnown(agentId);
		return this.store.readJournal(agentId);
	}

	listSummaries(actorId: string, includeArchived = false): readonly AgentSummary[] {
		this.requireActor(actorId);
		const actorPath = this.actorPath(actorId);
		return this.store
			.listTree()
			.agents.filter((record) => {
				if (!includeArchived && record.archived) return false;
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

	subscribe(listener: (event: AgentManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async recoverDeleteMarkers(): Promise<void> {
		await this.store.recoverDeleteMarkers();
	}

	async unload(reason: "parent_unloaded"): Promise<void> {
		if (this.unloaded) return;
		this.unloaded = true;
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
					continue;
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
				this.publishTerminal(this.store.load(agentId), terminalTask);
			}
		} finally {
			const hot = this.hot.get(agentId);
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
				const summary = this.buildSummary(record);
				this.emitApprovalRequired(summary, taskId, request.action.toolName);
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
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				elapsedMs: Math.max(0, this.now() - hot.startedAt),
				toolCalls: stats.toolCalls,
				...(Number.isFinite(stats.cost) ? { cost: stats.cost } : {}),
			};
			const finalMessage = assistantText(runtime.session);
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
		(this.store as AgentStore).appendTaskState(agentId, input);
	}

	private async interruptNow(actorId: string, agentId: string): Promise<InterruptAgentResult> {
		this.assertDescendant(actorId, agentId);
		this.assertOperable(agentId);
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
		for (const task of this.store.listTasks(agentId)) {
			if (task.status !== "queued") continue;
			this.appendTaskState(agentId, {
				taskId: task.taskId,
				status: "stopped",
				reason: "interrupted",
			});
			cancelledTaskIds.push(task.taskId);
		}
		this.cancelScheduled(agentId);
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
			for (const task of this.store.listTasks(record.agentId)) {
				if (task.status !== "queued" && task.status !== "running") continue;
				this.appendTaskState(record.agentId, {
					taskId: task.taskId,
					status: "stopped",
					reason: "parent_unloaded",
				});
			}
		}
	}

	private narrowChildrenTo(parentMode: PermissionMode): void {
		const records = this.store.listTree().agents;
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
		if (slash <= 0 || slash === requested.length - 1 || requested.indexOf("/", slash + 1) !== -1) {
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
		const tasks = this.store.listTasks(record.agentId);
		const hot = this.hot.get(record.agentId);
		const running =
			tasks.find((task) => task.taskId === hot?.taskId) ?? tasks.find((task) => task.status === "running");
		const latest = tasks.at(-1);
		const status = hot ? "running" : agentStatusFromTasks(tasks);
		return {
			agentId: record.agentId,
			name: record.name,
			agentType: record.config.agentType,
			depth: record.config.agentPath.length,
			status,
			archived: record.archived,
			parentSessionId: record.config.parentSessionId,
			rootSessionId: record.config.rootSessionId,
			agentPath: record.config.agentPath,
			...(running ? { currentTask: running } : {}),
			...(latest ? { latestTask: latest } : {}),
			createdAt: tasks[0]?.createdAt ?? new Date(this.now()).toISOString(),
			updatedAt: latest?.updatedAt ?? tasks[0]?.createdAt ?? new Date(this.now()).toISOString(),
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
			const usage = summary.latestTask?.usage;
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
		return { input, output, cacheRead, cacheWrite, elapsedMs, ...(hasCost ? { cost } : {}) };
	}

	private assertDescendant(actorId: string, targetAgentId: string): AgentDiskRecord {
		const target = this.store.load(targetAgentId);
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
		return [...this.store.load(actorId).config.agentPath];
	}

	private emitUpdate(summary: AgentSummary): AgentSummary {
		this.emitEvent({ type: "updated", summary });
		return summary;
	}

	private emitApprovalRequired(summary: AgentSummary, taskId: string, toolName: string): void {
		this.emitEvent({ type: "approval_required", summary, taskId, toolName });
	}

	private emitEvent(event: AgentManagerEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private publishTerminal(record: AgentDiskRecord, task: AgentTaskSummary): AgentSummary {
		const summary = this.emitUpdate(this.buildSummary(record));
		if (!isTerminalTaskStatus(task.status) || this.unloaded) return summary;
		const event = terminalMailboxEvent(record, task);
		const parentActor =
			this.actors.get(record.config.parentSessionId)?.session ?? this.actors.get(this.rootSessionId)?.session;
		try {
			if (
				parentActor?.enqueueSubagentMailboxEvent({
					eventId: event.eventId,
					runId: event.taskId,
					agentId: event.agentId,
					name: event.name,
					type: "terminal",
					status: event.status,
					...(event.finalMessage ? { finalMessage: event.finalMessage } : {}),
					...(event.error ? { error: event.error } : {}),
					completedAt: event.completedAt,
				})
			) {
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

	private recoverMailboxEvents(session: AgentSession): void {
		for (const record of this.store.listTree().agents) {
			for (const task of this.store.listTasks(record.agentId)) {
				if (!isTerminalTaskStatus(task.status)) continue;
				const loaded = this.store.load(record.agentId);
				if (loaded.config.parentSessionId !== session.sessionManager.getSessionId()) continue;
				this.publishTerminal(loaded, task);
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
		this.assertActive();
		this.store.load(agentId);
	}

	private assertOperable(agentId: string): void {
		this.assertKnown(agentId);
		if (this.deleting.has(agentId)) throw new AgentError("INVALID_STATE", `Agent is deleting: ${agentId}`);
	}
}
