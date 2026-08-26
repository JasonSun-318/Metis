import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@metis/agent-core";
import { createFileAtomicallySync, ensureDirectoryDurablySync, syncDirectorySync } from "../durable-file.ts";
import type { AgentArchivedEntry, AgentMessageEntry, AgentStateReason, AgentTaskEntry } from "../session-control.ts";
import { assertValidSessionId, createSessionId } from "../session-id.ts";
import {
	type FileEntry,
	getSessionAgentDir,
	getSessionImageDir,
	getSessionToolOutputDir,
	type SessionHeader,
	SessionManager,
} from "../session-manager.ts";
import type {
	AgentConfig,
	AgentStatus,
	AgentTaskStatus,
	AgentTaskSummary,
	AgentTombstone,
	AgentUsage,
} from "./types.ts";

export interface AgentDiskRecord {
	readonly agentId: string;
	readonly name: string;
	readonly path: string;
	readonly config: AgentConfig;
	readonly archived: boolean;
	readonly header: NonNullable<SessionHeader["agent"]>;
}

export interface AgentStoreApi {
	listTree(): { readonly agents: readonly AgentDiskRecord[]; readonly diagnostics: readonly string[] };
	create(config: AgentConfig, forkedMessages: readonly AgentMessage[], firstTaskId?: string): AgentDiskRecord;
	load(agentId: string): AgentDiskRecord;
	appendTask(
		agentId: string,
		input: {
			readonly taskId: string;
			readonly text: string;
			readonly status: AgentTaskStatus;
			readonly reason?: AgentStateReason;
			readonly finalMessage?: string;
			readonly error?: string;
			readonly usage?: AgentUsage;
		},
	): AgentDiskRecord;
	appendTaskState(
		agentId: string,
		input: {
			readonly taskId: string;
			readonly status: AgentTaskStatus;
			readonly reason?: AgentStateReason;
			readonly finalMessage?: string;
			readonly error?: string;
			readonly usage?: AgentUsage;
		},
	): AgentDiskRecord;
	appendMessage(
		agentId: string,
		input: {
			readonly taskId: string;
			readonly messageId: string;
			readonly text: string;
			readonly state: "accepted" | "cancelled";
		},
	): AgentDiskRecord;
	listTasks(agentId: string): readonly AgentTaskSummary[];
	readJournal(agentId: string): readonly FileEntry[];
	setArchived(agentId: string, archived: boolean): AgentDiskRecord;
	beginDelete(agentId: string, tombstone: AgentTombstone): void;
	finishDelete(agentId: string): Promise<{
		readonly status: "deleted" | "delete_failed";
		readonly residualPath?: string;
		readonly error?: string;
	}>;
	recoverDeleteMarkers(): Promise<void>;
}

function taskSummary(task: string): string {
	const normalized = task.replace(/\s+/g, " ").trim();
	let end = Math.min(normalized.length, 240);
	if (end < normalized.length && /[\uD800-\uDBFF]/u.test(normalized[end - 1]!)) end -= 1;
	return normalized.slice(0, end);
}

function stripThinking(message: AgentMessage): AgentMessage {
	const copy = structuredClone(message) as AgentMessage & { content?: unknown; details?: unknown };
	if (Array.isArray(copy.content)) {
		copy.content = copy.content.filter(
			(block) => typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "thinking",
		);
	}
	delete copy.details;
	return copy;
}

function selectForkMessages(messages: readonly AgentMessage[], forkTurns: AgentConfig["forkTurns"]): AgentMessage[] {
	if (forkTurns === 0) return [];
	const groups: AgentMessage[][] = [];
	let current: AgentMessage[] | undefined;
	for (const message of messages) {
		if (message.role === "custom" && !message.display) continue;
		if (message.role === "user") {
			current = [];
			groups.push(current);
		}
		if (current) current.push(stripThinking(message));
	}
	return (forkTurns === "all" ? groups : groups.slice(-forkTurns)).flat();
}

function _isTerminalStatus(status: AgentTaskStatus): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}

function reduceTasks(entries: readonly FileEntry[], agentId: string): AgentTaskSummary[] {
	const tasks = new Map<string, AgentTaskSummary>();
	for (const entry of entries) {
		if (entry.type !== "agent_task" || entry.agentId !== agentId) continue;
		tasks.set(entry.taskId, {
			taskId: entry.taskId,
			status: entry.status,
			taskSummary: entry.taskSummary,
			createdAt: entry.timestamp,
			updatedAt: entry.timestamp,
			...(entry.finalMessage ? { finalMessage: entry.finalMessage } : {}),
			...(entry.error ? { error: entry.error } : {}),
			...(entry.usage ? { usage: entry.usage } : {}),
		});
	}
	return [...tasks.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function reduceArchived(entries: readonly FileEntry[], agentId: string): boolean {
	let archived = false;
	for (const entry of entries) {
		if (entry.type === "agent_archived" && entry.agentId === agentId) archived = entry.archived;
	}
	return archived;
}

function headerToConfig(header: NonNullable<SessionHeader["agent"]>): AgentConfig {
	return {
		agentId: header.agentId,
		name: header.name,
		agentType: header.agentType,
		initialTask: header.initialTask,
		tools: header.tools,
		writePolicy: header.writePolicy,
		permissionMode: header.permissionMode,
		model: header.model,
		thinkingLevel: header.thinkingLevel,
		cwd: header.cwd,
		forkTurns: header.forkTurns,
		timeoutSeconds: header.timeoutSeconds,
		mayDelegate: header.mayDelegate,
		parentSessionId: header.parentSessionId,
		rootSessionId: header.rootSessionId,
		agentPath: header.agentPath,
	};
}

function validateAgentRelation(header: NonNullable<SessionHeader["agent"]>, rootSessionId: string): void {
	if (header.agentPath.at(-1) !== header.agentId) {
		throw new Error("Agent path must end with the agent id");
	}
	if (header.agentPath.length !== 1 && header.agentPath.length !== 2) {
		throw new Error("Agent path must contain one or two ids");
	}
	if (header.agentPath.length === 1 && header.parentSessionId !== rootSessionId) {
		throw new Error("Direct child agent parent must be the root session");
	}
	if (header.agentPath.length === 2 && header.agentPath.at(-2) !== header.parentSessionId) {
		throw new Error("Grandchild agent parent must match agent path");
	}
	if (header.rootSessionId !== rootSessionId) {
		throw new Error("Agent root session id mismatch");
	}
}

function reduceRecord(path: string, rootSessionId: string): AgentDiskRecord {
	const manager = SessionManager.openReadOnly(path);
	const header = manager.getHeader();
	if (!header?.agent) throw new Error("Child session is missing its agent header");
	if (header.id !== header.agent.agentId) throw new Error("Child session id must match agent id");
	validateAgentRelation(header.agent, rootSessionId);
	const entries = manager.getDurableJournalSnapshot();
	const config = headerToConfig(header.agent);
	return {
		agentId: header.id,
		name: header.agent.name,
		path,
		config,
		archived: reduceArchived(entries, header.id),
		header: header.agent,
	};
}

function markerTombstone(path: string): AgentTombstone {
	const value = JSON.parse(readFileSync(path, "utf8")) as AgentTombstone;
	if (
		value.status !== "deleted" ||
		typeof value.agentId !== "string" ||
		typeof value.name !== "string" ||
		typeof value.taskSummary !== "string" ||
		typeof value.deletedAt !== "string"
	) {
		throw new Error("Invalid agent delete marker");
	}
	assertValidSessionId(value.agentId);
	if (
		!Number.isFinite(Date.parse(value.deletedAt)) ||
		(value.finalMessage !== undefined && typeof value.finalMessage !== "string")
	) {
		throw new Error("Invalid agent delete marker");
	}
	return value;
}

function agentHeaderFromConfig(config: AgentConfig): NonNullable<SessionHeader["agent"]> {
	return {
		agentId: config.agentId,
		name: config.name,
		parentSessionId: config.parentSessionId,
		rootSessionId: config.rootSessionId,
		agentPath: config.agentPath,
		agentType: config.agentType,
		tools: config.tools,
		writePolicy: config.writePolicy,
		permissionMode: config.permissionMode,
		model: config.model,
		thinkingLevel: config.thinkingLevel,
		cwd: config.cwd,
		forkTurns: config.forkTurns,
		timeoutSeconds: config.timeoutSeconds,
		mayDelegate: config.mayDelegate,
		initialTask: config.initialTask,
	};
}

export class AgentStore implements AgentStoreApi {
	readonly directory: string;
	private readonly deletingDirectory: string;
	private readonly rootSessionId: string;
	private readonly agentDir: string;

	constructor(rootSessionManager: SessionManager, agentDir: string) {
		if (!rootSessionManager.isPersisted() || !rootSessionManager.getSessionFile()) {
			throw new Error("Agents require a persisted root session");
		}
		this.rootSessionId = rootSessionManager.getSessionId();
		this.agentDir = agentDir;
		this.directory = getSessionAgentDir(agentDir, this.rootSessionId);
		this.deletingDirectory = join(this.directory, ".deleting");
	}

	static createAgentId(): string {
		return createSessionId();
	}

	static createTaskId(): string {
		return createSessionId();
	}

	listTree(): { agents: AgentDiskRecord[]; diagnostics: string[] } {
		const agents: AgentDiskRecord[] = [];
		const diagnostics: string[] = [];
		if (!existsSync(this.directory)) return { agents, diagnostics };
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const path = join(this.directory, entry.name);
			try {
				const stat = lstatSync(path);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
				agents.push(reduceRecord(path, this.rootSessionId));
			} catch (error) {
				diagnostics.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		agents.sort((left, right) => left.config.agentId.localeCompare(right.config.agentId));
		return { agents, diagnostics };
	}

	create(config: AgentConfig, forkedMessages: readonly AgentMessage[], firstTaskId?: string): AgentDiskRecord {
		validateAgentRelation(agentHeaderFromConfig(config), this.rootSessionId);
		const tree = this.listTree();
		if (tree.agents.some((agent) => agent.agentId === config.agentId)) {
			throw new Error(`Agent already exists: ${config.agentId}`);
		}
		if (tree.agents.some((agent) => agent.name === config.name && !agent.archived)) {
			throw new Error(`Agent name has already been used: ${config.name}`);
		}
		const taskId = firstTaskId ?? AgentStore.createTaskId();
		ensureDirectoryDurablySync(this.directory);
		const manager = SessionManager.create(config.cwd, this.directory, {
			id: config.agentId,
			mode: "code",
			permissionMode: config.permissionMode,
			agent: agentHeaderFromConfig(config),
		});
		const path = manager.getSessionFile();
		try {
			manager.appendAgentControl({
				type: "agent_task",
				agentId: config.agentId,
				taskId,
				text: config.initialTask,
				taskSummary: taskSummary(config.initialTask),
				status: "queued",
			});
			for (const message of selectForkMessages(forkedMessages, config.forkTurns)) {
				if (message.role === "branchSummary" || message.role === "compactionSummary") continue;
				if (message.role === "custom") {
					manager.appendCustomMessageEntry(message.customType, message.content, true);
				} else {
					manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
				}
			}
			if (!path) throw new Error("Child session was not persisted");
			return reduceRecord(path, this.rootSessionId);
		} catch (error) {
			manager.close();
			if (path) {
				rmSync(path, { force: true });
				rmSync(getSessionImageDir(path), { recursive: true, force: true });
				rmSync(getSessionToolOutputDir(path), { recursive: true, force: true });
			}
			throw error;
		} finally {
			manager.close();
		}
	}

	load(agentId: string): AgentDiskRecord {
		const match = this.listTree().agents.find((agent) => agent.agentId === agentId);
		if (!match) throw new Error(`Unknown agent: ${agentId}`);
		return reduceRecord(match.path, this.rootSessionId);
	}

	appendTask(
		agentId: string,
		input: {
			readonly taskId: string;
			readonly text: string;
			readonly status: AgentTaskStatus;
			readonly reason?: AgentStateReason;
			readonly finalMessage?: string;
			readonly error?: string;
			readonly usage?: AgentUsage;
		},
	): AgentDiskRecord {
		if (!input.text || !input.taskId) throw new Error("Agent task requires id and text");
		const record = this.load(agentId);
		const existing = this.listTasks(agentId);
		if (existing.some((task) => task.taskId === input.taskId)) {
			throw new Error(`Agent task already exists: ${input.taskId}`);
		}
		if (existing.filter((task) => task.status === "queued").length >= 32) {
			throw new Error("Agent task queue is full");
		}
		if (existing.some((task) => task.status === "running")) {
			// Additional queued tasks are allowed while one task is running.
		}
		const manager = SessionManager.open(record.path);
		try {
			manager.appendAgentControl({
				type: "agent_task",
				agentId,
				taskId: input.taskId,
				text: input.text,
				taskSummary: taskSummary(input.text),
				status: input.status,
				...(input.reason ? { reason: input.reason } : {}),
				...(input.finalMessage ? { finalMessage: input.finalMessage } : {}),
				...(input.error ? { error: input.error } : {}),
				...(input.usage ? { usage: input.usage } : {}),
			});
		} finally {
			manager.close();
		}
		return this.load(agentId);
	}

	appendTaskState(
		agentId: string,
		input: {
			readonly taskId: string;
			readonly status: AgentTaskStatus;
			readonly reason?: AgentStateReason;
			readonly finalMessage?: string;
			readonly error?: string;
			readonly usage?: AgentUsage;
		},
	): AgentDiskRecord {
		const record = this.load(agentId);
		const journal = this.readJournal(agentId);
		const prior = [...journal]
			.reverse()
			.find((entry): entry is AgentTaskEntry => entry.type === "agent_task" && entry.taskId === input.taskId);
		if (!prior) throw new Error(`Unknown agent task: ${input.taskId}`);
		const manager = SessionManager.open(record.path);
		try {
			manager.appendAgentControl({
				type: "agent_task",
				agentId,
				taskId: input.taskId,
				text: prior.text,
				taskSummary: prior.taskSummary,
				status: input.status,
				...(input.reason ? { reason: input.reason } : {}),
				...(input.finalMessage ? { finalMessage: input.finalMessage } : {}),
				...(input.error ? { error: input.error } : {}),
				...(input.usage ? { usage: input.usage } : {}),
			});
		} finally {
			manager.close();
		}
		return this.load(agentId);
	}

	appendMessage(
		agentId: string,
		input: {
			readonly taskId: string;
			readonly messageId: string;
			readonly text: string;
			readonly state: "accepted" | "cancelled";
		},
	): AgentDiskRecord {
		const record = this.load(agentId);
		const manager = SessionManager.open(record.path);
		try {
			manager.appendAgentControl({
				type: "agent_message",
				agentId,
				taskId: input.taskId,
				messageId: input.messageId,
				text: input.text,
				state: input.state,
			});
		} finally {
			manager.close();
		}
		return this.load(agentId);
	}

	listTasks(agentId: string): readonly AgentTaskSummary[] {
		const _record = this.load(agentId);
		return reduceTasks(this.readJournal(agentId), agentId);
	}

	readJournal(agentId: string): readonly FileEntry[] {
		const record = this.load(agentId);
		return SessionManager.openReadOnly(record.path).getDurableJournalSnapshot();
	}

	setArchived(agentId: string, archived: boolean): AgentDiskRecord {
		const record = this.load(agentId);
		const manager = SessionManager.open(record.path);
		try {
			manager.appendAgentControl({ type: "agent_archived", agentId, archived });
		} finally {
			manager.close();
		}
		return this.load(agentId);
	}

	beginDelete(agentId: string, tombstone: AgentTombstone): void {
		if (tombstone.agentId !== agentId) throw new Error("Agent delete marker id mismatch");
		this.load(agentId);
		ensureDirectoryDurablySync(this.deletingDirectory);
		const path = join(this.deletingDirectory, `${agentId}.json`);
		if (!existsSync(path)) createFileAtomicallySync(path, `${JSON.stringify(tombstone)}\n`, { mode: 0o600 });
	}

	async finishDelete(
		agentId: string,
	): Promise<{ status: "deleted" | "delete_failed"; residualPath?: string; error?: string }> {
		assertValidSessionId(agentId);
		const markerPath = join(this.deletingDirectory, `${agentId}.json`);
		if (!existsSync(markerPath)) throw new Error(`Agent is not deleting: ${agentId}`);
		const tombstone = markerTombstone(markerPath);
		let record: AgentDiskRecord | undefined;
		try {
			record = this.load(agentId);
		} catch {
			// Crash may have happened after child deletion; the marker owns recovery.
		}
		if (record) {
			const deletion = await SessionManager.deleteSession(record.path, { agentDir: this.agentDir });
			if (!deletion.ok) {
				rmSync(markerPath, { force: true });
				if (existsSync(this.deletingDirectory)) syncDirectorySync(this.deletingDirectory);
				return {
					status: "delete_failed",
					residualPath: record.path,
					error: deletion.error ?? "Failed to delete child session",
				};
			}
		}
		rmSync(markerPath, { force: true });
		if (existsSync(this.deletingDirectory)) syncDirectorySync(this.deletingDirectory);
		void tombstone;
		return { status: "deleted" };
	}

	async recoverDeleteMarkers(): Promise<void> {
		if (!existsSync(this.deletingDirectory)) return;
		for (const entry of readdirSync(this.deletingDirectory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const tombstone = markerTombstone(join(this.deletingDirectory, entry.name));
				await this.finishDelete(tombstone.agentId);
			} catch {
				// Leave invalid or failed markers for diagnostics/retry.
			}
		}
	}
}

export function agentStatusFromTasks(tasks: readonly AgentTaskSummary[]): AgentStatus {
	const running = tasks.find((task) => task.status === "running");
	if (running) return "running";
	const queued = tasks.find((task) => task.status === "queued");
	if (queued) return "queued";
	const latest = tasks.at(-1);
	return latest?.status ?? "queued";
}

export type { AgentTaskEntry, AgentMessageEntry, AgentArchivedEntry };
