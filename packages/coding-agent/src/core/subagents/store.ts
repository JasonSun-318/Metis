import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@arcmind/agent-core";
import { createFileAtomicallySync, ensureDirectoryDurablySync, syncDirectorySync } from "../durable-file.ts";
import type { SubagentFollowUpEntry, SubagentStateEntry } from "../session-control.ts";
import { assertValidSessionId, createSessionId } from "../session-id.ts";
import {
	type FileEntry,
	getSessionImageDir,
	getSessionSubagentDir,
	getSessionToolOutputDir,
	SessionManager,
} from "../session-manager.ts";
import type { SubagentConfig, SubagentStatus, SubagentTombstone, SubagentUsage } from "./types.ts";

export interface SubagentDiskRecord {
	readonly agentId: string;
	readonly runId: string;
	readonly name: string;
	readonly path: string;
	readonly status: Exclude<SubagentStatus, "closed">;
	readonly taskSummary: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly finalSummary?: string;
	readonly error?: string;
	readonly residualPath?: string;
	readonly usage?: SubagentUsage;
	readonly config?: SubagentConfig;
}

export interface SubagentStoreApi {
	list(): { agents: SubagentDiskRecord[]; diagnostics: string[] };
	create(config: SubagentConfig, forkedMessages: readonly AgentMessage[]): SubagentDiskRecord;
	load(agentId: string): SubagentDiskRecord;
	appendState(agentId: string, entry: Omit<SubagentStateEntry, "id" | "parentId" | "timestamp">): SubagentDiskRecord;
	appendFollowUp(
		agentId: string,
		entry: Omit<SubagentFollowUpEntry, "id" | "parentId" | "timestamp">,
	): SubagentDiskRecord;
	readJournal(agentId: string): readonly FileEntry[];
	beginClose(agentId: string, tombstone: SubagentTombstone): void;
	finishClose(agentId: string): Promise<{ status: "closed" | "close_failed"; residualPath?: string; error?: string }>;
	recoverCloseMarkers(): Promise<void>;
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

function selectForkMessages(messages: readonly AgentMessage[], forkTurns: SubagentConfig["forkTurns"]): AgentMessage[] {
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

function reduceRecord(path: string, parentSessionId: string, includeConfig: boolean): SubagentDiskRecord {
	const manager = SessionManager.openReadOnly(path);
	const header = manager.getHeader();
	if (
		!header?.subagent ||
		header.subagent.parentSessionId !== parentSessionId ||
		header.id !== header.subagent.agentId
	) {
		throw new Error("Child session ownership marker does not match its parent");
	}
	const entries = manager.getDurableJournalSnapshot();
	const created = entries.find((entry) => entry.type === "subagent_created");
	if (!created || created.type !== "subagent_created" || created.config.agentId !== header.id) {
		throw new Error("Child session is missing its creation record");
	}
	if (created.config.mode !== (header.mode ?? "code"))
		throw new Error("Child session mode disagrees with its creation record");
	let status: Exclude<SubagentStatus, "closed"> = "queued";
	let runId = `legacy-created-${header.id}`;
	let updatedAt = created.timestamp;
	let finalSummary: string | undefined;
	let error: string | undefined;
	let residualPath: string | undefined;
	let usage: SubagentUsage | undefined;
	for (const entry of entries) {
		if (entry.type !== "subagent_state" || entry.agentId !== header.id) continue;
		if (entry.runId !== runId) {
			finalSummary = undefined;
			error = undefined;
			residualPath = undefined;
			usage = undefined;
		}
		status = entry.status;
		runId = entry.runId;
		updatedAt = entry.timestamp;
		finalSummary = entry.finalSummary ?? finalSummary;
		error = entry.error ?? error;
		residualPath = entry.residualPath ?? residualPath;
		usage = entry.usage ?? usage;
	}
	return {
		agentId: header.id,
		runId,
		name: header.subagent.name,
		path,
		status,
		taskSummary: created.config.taskSummary,
		createdAt: created.timestamp,
		updatedAt,
		...(finalSummary ? { finalSummary } : {}),
		...(error ? { error } : {}),
		...(residualPath ? { residualPath } : {}),
		...(usage ? { usage } : {}),
		...(includeConfig ? { config: created.config } : {}),
	};
}

function markerTombstone(path: string): SubagentTombstone {
	const value = JSON.parse(readFileSync(path, "utf8")) as SubagentTombstone;
	if (
		value.status !== "closed" ||
		typeof value.agentId !== "string" ||
		typeof value.name !== "string" ||
		typeof value.taskSummary !== "string" ||
		typeof value.closedAt !== "string"
	) {
		throw new Error("Invalid subagent close marker");
	}
	assertValidSessionId(value.agentId);
	if (
		!Number.isFinite(Date.parse(value.closedAt)) ||
		(value.finalSummary !== undefined && typeof value.finalSummary !== "string")
	) {
		throw new Error("Invalid subagent close marker");
	}
	return value;
}

export class SubagentStore implements SubagentStoreApi {
	readonly directory: string;
	private readonly closingDirectory: string;
	private readonly parent: SessionManager;
	private readonly agentDir: string;

	constructor(parent: SessionManager, agentDir: string) {
		if (!parent.isPersisted() || !parent.getSessionFile())
			throw new Error("Subagents require a persisted parent session");
		if (parent.getHeader()?.subagent) throw new Error("Subagents cannot create nested subagents");
		this.parent = parent;
		this.agentDir = agentDir;
		this.directory = getSessionSubagentDir(agentDir, parent.getSessionId());
		this.closingDirectory = join(this.directory, ".closing");
	}

	static createAgentId(): string {
		return createSessionId();
	}

	list(): { agents: SubagentDiskRecord[]; diagnostics: string[] } {
		const agents: SubagentDiskRecord[] = [];
		const diagnostics: string[] = [];
		if (!existsSync(this.directory)) return { agents, diagnostics };
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const path = join(this.directory, entry.name);
			try {
				const stat = lstatSync(path);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
				agents.push(reduceRecord(path, this.parent.getSessionId(), false));
			} catch (error) {
				diagnostics.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		agents.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
		return { agents, diagnostics };
	}

	create(config: SubagentConfig, forkedMessages: readonly AgentMessage[]): SubagentDiskRecord {
		if (this.list().agents.some((agent) => agent.agentId === config.agentId))
			throw new Error(`Subagent already exists: ${config.agentId}`);
		ensureDirectoryDurablySync(this.directory);
		const manager = SessionManager.create(config.cwd, this.directory, {
			id: config.agentId,
			mode: config.mode,
			permissionMode: config.permissionMode,
			reviewerEnabled: config.reviewerEnabled,
			subagent: { agentId: config.agentId, name: config.name, parentSessionId: this.parent.getSessionId() },
		});
		const path = manager.getSessionFile();
		try {
			manager.appendSubagentControl({ type: "subagent_created", config });
			for (const message of selectForkMessages(forkedMessages, config.forkTurns)) {
				if (message.role === "branchSummary" || message.role === "compactionSummary") continue;
				if (message.role === "custom") {
					manager.appendCustomMessageEntry(message.customType, message.content, true);
				} else {
					manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
				}
			}
			if (!path) throw new Error("Child session was not persisted");
			return reduceRecord(path, this.parent.getSessionId(), true);
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

	load(agentId: string): SubagentDiskRecord {
		const match = this.list().agents.find((agent) => agent.agentId === agentId);
		if (!match) throw new Error(`Unknown subagent: ${agentId}`);
		return reduceRecord(match.path, this.parent.getSessionId(), true);
	}

	appendState(agentId: string, entry: Omit<SubagentStateEntry, "id" | "parentId" | "timestamp">): SubagentDiskRecord {
		if (entry.agentId !== agentId) throw new Error("Subagent state id mismatch");
		const record = this.load(agentId);
		const manager = SessionManager.open(record.path);
		try {
			manager.appendSubagentControl(entry);
		} finally {
			manager.close();
		}
		return this.load(agentId);
	}

	appendFollowUp(
		agentId: string,
		entry: Omit<SubagentFollowUpEntry, "id" | "parentId" | "timestamp">,
	): SubagentDiskRecord {
		if (entry.agentId !== agentId) throw new Error("Subagent follow-up id mismatch");
		const record = this.load(agentId);
		const manager = SessionManager.open(record.path);
		try {
			manager.appendSubagentControl(entry);
		} finally {
			manager.close();
		}
		return this.load(agentId);
	}

	readJournal(agentId: string): readonly FileEntry[] {
		const record = this.load(agentId);
		return SessionManager.openReadOnly(record.path).getDurableJournalSnapshot();
	}

	beginClose(agentId: string, tombstone: SubagentTombstone): void {
		if (tombstone.agentId !== agentId) throw new Error("Subagent close marker id mismatch");
		this.load(agentId);
		ensureDirectoryDurablySync(this.closingDirectory);
		const path = join(this.closingDirectory, `${agentId}.json`);
		if (!existsSync(path)) createFileAtomicallySync(path, `${JSON.stringify(tombstone)}\n`, { mode: 0o600 });
	}

	async finishClose(
		agentId: string,
	): Promise<{ status: "closed" | "close_failed"; residualPath?: string; error?: string }> {
		assertValidSessionId(agentId);
		const markerPath = join(this.closingDirectory, `${agentId}.json`);
		if (!existsSync(markerPath)) {
			const alreadyClosed = this.parent
				.getDurableJournalSnapshot()
				.some((entry) => entry.type === "subagent_closed" && entry.tombstone.agentId === agentId);
			if (alreadyClosed) return { status: "closed" };
			throw new Error(`Subagent is not closing: ${agentId}`);
		}
		const tombstone = markerTombstone(markerPath);
		let record: SubagentDiskRecord | undefined;
		try {
			record = this.load(agentId);
		} catch (error) {
			const expectedSuffix = `_${agentId}.jsonl`;
			const residualName = existsSync(this.directory)
				? readdirSync(this.directory, { withFileTypes: true }).find((entry) => entry.name.endsWith(expectedSuffix))
						?.name
				: undefined;
			if (residualName) {
				throw new Error(
					`Child session still exists but cannot be verified for deletion (${join(this.directory, residualName)}): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			// A crash may have happened after child deletion; the marker owns recovery.
		}
		if (record) {
			const deletion = await SessionManager.deleteSession(record.path, { agentDir: this.agentDir });
			if (!deletion.ok) {
				const error = deletion.error ?? "Failed to delete child session";
				try {
					this.appendState(agentId, {
						type: "subagent_state",
						agentId,
						runId: record.runId,
						status: "close_failed",
						reason: "error",
						error,
						residualPath: record.path,
					});
				} catch {
					// Preserve the original deletion failure.
				}
				rmSync(markerPath, { force: true });
				if (existsSync(this.closingDirectory)) syncDirectorySync(this.closingDirectory);
				return { status: "close_failed", residualPath: record.path, error };
			}
		}
		const hasTombstone = this.parent
			.getDurableJournalSnapshot()
			.some((entry) => entry.type === "subagent_closed" && entry.tombstone.agentId === agentId);
		if (!hasTombstone) this.parent.appendSubagentControl({ type: "subagent_closed", tombstone });
		rmSync(markerPath, { force: true });
		if (existsSync(this.closingDirectory)) syncDirectorySync(this.closingDirectory);
		return { status: "closed" };
	}

	async recoverCloseMarkers(): Promise<void> {
		if (!existsSync(this.closingDirectory)) return;
		for (const entry of readdirSync(this.closingDirectory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const tombstone = markerTombstone(join(this.closingDirectory, entry.name));
				await this.finishClose(tombstone.agentId);
			} catch {
				// Leave invalid or failed markers for diagnostics/retry.
			}
		}
	}
}
