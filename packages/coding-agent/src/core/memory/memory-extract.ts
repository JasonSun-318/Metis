import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel } from "@metis/agent-core";
import type { Model } from "@metis/ai/compat";
import type { AgentMode } from "../agent-mode.ts";
import { getMemorySqlitePath } from "../auto-memory.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { serializeExtractEvidence } from "./memory-evidence.ts";
import { memoryProjectIdentity } from "./memory-project.ts";
import { writeProjection as writeProjectionDefault } from "./memory-projection.ts";
import { type MemoryStore, openMemoryStore } from "./memory-store.ts";
import { createCommitFactsTool, createReconcileFactsTool, type MemoryToolContext } from "./memory-tools.ts";
import type { MemoryExtractRun, MemoryExtractRunStatus, MemoryFact } from "./memory-types.ts";

export const DURABLE_MEMORY_INTENT_RE = /记住|以后|不要再|偏好|remember|always|never|prefer/i;
export const MEMORY_EXTRACT_TIMEOUT_MS = 60_000;

export function hasDurableMemoryIntent(text: string): boolean {
	return DURABLE_MEMORY_INTENT_RE.test(text);
}

export const COMMIT_EXTRACT_SYSTEM_PROMPT = `You extract durable user/project facts for long-term memory.

Rules:
- Uncertain scope → project (never invent a third scope).
- commit_facts is ADD-only: only append new facts; never delete or supersede on a turn extract.
- Do not read or write the memory directory. Your only action is calling the commit_facts tool.
- Every fact must include a lowercase flat topicFile matching [a-z0-9][a-z0-9._-]*.md; never use memory.md, project.md, overflow.md, or legacy-overflow.md.
- Omit secrets, credentials, and ephemeral chatter.
- If nothing durable should be stored, call commit_facts with an empty facts array.
`;

export const RECONCILE_EXTRACT_SYSTEM_PROMPT = `You reconcile durable memory facts after compaction.

Rules:
- Uncertain scope → project.
- Do not read or write the memory directory. Your only action is calling the reconcile_facts tool.
- Code applies recency by createdAt, then null-as-empty sourceTurn, then id. Use only ids from the supplied fact list.
- merge: the survivor must be the deterministically newest id under that three-field order; the rest are superseded.
- moveScope only changes scope/cwd_key/mode columns.
- supersede/merge/delete/moveScope must reference ids from the supplied list.
- You may add new facts via add when needed.
`;

const RETRY_USER_MESSAGE = "Call the tool now with valid arguments. Do not reply with free-form JSON.";

export type MemoryExtractMode = "commit" | "reconcile";

export interface MemoryExtractPromptArgs {
	attempt: number;
	systemPrompt: string;
	userPrompt: string;
	tool: AgentTool;
	signal: AbortSignal;
}

export type MemoryExtractPromptFn = (args: MemoryExtractPromptArgs) => Promise<AgentMessage[]>;

export interface RunMemoryExtractOptions {
	mode: MemoryExtractMode;
	agentDir: string;
	cwd: string;
	agentMode: AgentMode;
	sessionId: string;
	/** Already bounded, oldest-first evidence. */
	evidence?: string;
	/** Durable message-entry id represented by evidence; commit success advances through it. */
	cursorEntryId?: string | null;
	/** @deprecated Transitional test/API adapter; session code passes evidence. */
	messages?: AgentMessage[];
	trigger: string;
	signal: AbortSignal;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFn;
	getApiKey?: Agent["getApiKey"];
	transport?: Agent["transport"];
	thinkingBudgets?: Agent["thinkingBudgets"];
	maxRetryDelayMs?: number;
	sourceTurn?: string | null;
	createdAt?: string;
	projectKey?: string;
	promptFn?: MemoryExtractPromptFn;
	serializeEvidence?: typeof serializeExtractEvidence;
	openStore?: (path: string) => MemoryStore;
	writeProjection?: typeof writeProjectionDefault;
	projectAfterWrite?: boolean;
	timeoutMs?: number;
	embeddingModel?: string | null;
	embedText?: (text: string) => Promise<Float32Array | null>;
}

export interface MemoryExtractResult {
	status: MemoryExtractRunStatus;
	reason?: string;
	runId: string;
}

export interface MemoryExtractActiveRun {
	id: string;
	sessionId: string;
	mode: AgentMode;
	extractMode: MemoryExtractMode;
	cwd: string;
	trigger: string;
	startedAt: string;
}

export interface MemoryExtractStatusSnapshot {
	enabled: boolean;
	active?: MemoryExtractActiveRun;
	recent: MemoryExtractRun[];
}

function toolNameForMode(mode: MemoryExtractMode): string {
	return mode === "commit" ? "commit_facts" : "reconcile_facts";
}

function findLastToolResult(
	messages: AgentMessage[],
	toolName: string,
): Extract<AgentMessage, { role: "toolResult" }> | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "toolResult" && message.toolName === toolName) return message;
	}
	return undefined;
}

function toolResultSucceeded(result: Extract<AgentMessage, { role: "toolResult" }>): boolean {
	if (result.isError) return false;
	const details = (result as { details?: { ok?: boolean } }).details;
	if (details && details.ok === false) return false;
	return true;
}

function buildReconcileFactsPayload(
	store: MemoryStore,
	projectKey: string,
): {
	active: Array<Pick<MemoryFact, "id" | "text" | "createdAt" | "sourceTurn" | "scope" | "topicFile">>;
	superseded: Array<Pick<MemoryFact, "id" | "text" | "createdAt" | "sourceTurn" | "scope" | "topicFile">>;
} {
	const activeCandidates = store
		.listActiveFactsForContext(projectKey)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
		.slice(0, 100)
		.map((fact) => ({
			id: fact.id,
			text: unicodePrefix(fact.text, 400),
			createdAt: fact.createdAt,
			sourceTurn: fact.sourceTurn,
			scope: fact.scope,
			topicFile: fact.topicFile,
		}));
	const supersededCandidates = store.listSupersededFactsForContext(projectKey, 50).map((fact) => ({
		id: fact.id,
		text: unicodePrefix(fact.text, 400),
		createdAt: fact.createdAt,
		sourceTurn: fact.sourceTurn,
		scope: fact.scope,
		topicFile: fact.topicFile,
	}));
	const active: typeof activeCandidates = [];
	const superseded: typeof supersededCandidates = [];
	for (const fact of activeCandidates) {
		if (JSON.stringify({ active: [...active, fact], superseded }).length > 32_000) break;
		active.push(fact);
	}
	for (const fact of supersededCandidates) {
		if (JSON.stringify({ active, superseded: [...superseded, fact] }).length > 32_000) break;
		superseded.push(fact);
	}
	return { active, superseded };
}

function buildUserPrompt(options: RunMemoryExtractOptions, store: MemoryStore, projectKey: string): string {
	const evidence = options.evidence ?? (options.serializeEvidence ?? serializeExtractEvidence)(options.messages ?? []);
	if (options.mode === "commit") {
		return `<extract_mode>commit</extract_mode>
<conversation_evidence>
${evidence}
</conversation_evidence>`;
	}
	const facts = buildReconcileFactsPayload(store, projectKey);
	return `<extract_mode>reconcile</extract_mode>
<active_facts>
${JSON.stringify(facts.active)}
</active_facts>
<superseded_summaries>
${JSON.stringify(facts.superseded)}
</superseded_summaries>
<conversation_evidence>
${evidence}
</conversation_evidence>`;
}

function unicodePrefix(text: string, maxCharacters: number): string {
	let end = 0;
	let count = 0;
	for (const character of text) {
		if (count >= maxCharacters) break;
		end += character.length;
		count++;
	}
	return end < text.length ? `${text.slice(0, end)}…` : text;
}

async function defaultPromptFn(
	options: RunMemoryExtractOptions,
	args: MemoryExtractPromptArgs,
): Promise<AgentMessage[]> {
	if (!options.model || !options.streamFn) {
		throw new Error("runMemoryExtract requires model+streamFn or an injected promptFn");
	}
	const agent = new Agent({
		initialState: {
			systemPrompt: args.systemPrompt,
			model: options.model,
			thinkingLevel: "off",
			tools: [args.tool],
		},
		streamFn: options.streamFn,
		...(options.getApiKey ? { getApiKey: options.getApiKey } : {}),
		...(options.transport ? { transport: options.transport } : {}),
		...(options.thinkingBudgets ? { thinkingBudgets: options.thinkingBudgets } : {}),
		...(options.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
		sessionId: `${options.sessionId}:memory-extract:${options.mode}`,
		toolExecution: "sequential",
	});
	const abort = () => agent.abort();
	args.signal.throwIfAborted();
	args.signal.addEventListener("abort", abort, { once: true });
	try {
		await agent.prompt(args.userPrompt);
		return agent.state.messages;
	} finally {
		args.signal.removeEventListener("abort", abort);
	}
}

export function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

export async function runMemoryExtract(options: RunMemoryExtractOptions): Promise<MemoryExtractResult> {
	const runId = randomUUID();
	const startedAt = new Date().toISOString();
	const timeoutMs = options.timeoutMs ?? MEMORY_EXTRACT_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([options.signal, timeoutSignal]);
	const openStore = options.openStore ?? openMemoryStore;
	const store = openStore(getMemorySqlitePath(options.agentDir));
	const identity = memoryProjectIdentity(options.cwd);
	if (options.projectKey && options.projectKey !== identity.projectKey) {
		store.close();
		throw new Error("Memory project key does not match the exact canonical cwd");
	}
	const projectKey = identity.projectKey;
	try {
		store.resolveProject(identity);
	} catch (error) {
		store.close();
		throw error;
	}
	const toolContext: MemoryToolContext = {
		store,
		agentDir: options.agentDir,
		projectKey,
		sourceTurn: options.sourceTurn ?? null,
		createdAt: options.createdAt,
		// Runner owns the final projection write so injectable writeProjection is honored.
		projectAfterWrite: false,
		signal,
		embeddingModel: options.embeddingModel ?? null,
		...(options.embedText ? { embedText: options.embedText } : {}),
	};

	const definition =
		options.mode === "commit" ? createCommitFactsTool(toolContext) : createReconcileFactsTool(toolContext);
	const tool = wrapToolDefinition(definition);
	const systemPrompt = options.mode === "commit" ? COMMIT_EXTRACT_SYSTEM_PROMPT : RECONCILE_EXTRACT_SYSTEM_PROMPT;
	const baseUserPrompt = buildUserPrompt(options, store, projectKey);
	const promptFn = options.promptFn ?? ((args) => defaultPromptFn(options, args));
	const writeProjection = options.writeProjection ?? writeProjectionDefault;
	const expectedTool = toolNameForMode(options.mode);

	let status: MemoryExtractRunStatus = "failed";
	let reason: string | undefined;

	try {
		signal.throwIfAborted();
		for (let attempt = 0; attempt < 2; attempt++) {
			signal.throwIfAborted();
			const userPrompt = attempt === 0 ? baseUserPrompt : `${baseUserPrompt}\n\n${RETRY_USER_MESSAGE}`;
			const messages = await awaitWithAbort(promptFn({ attempt, systemPrompt, userPrompt, tool, signal }), signal);
			signal.throwIfAborted();
			const toolResult = findLastToolResult(messages, expectedTool);
			if (!toolResult) {
				reason = "No tool call";
				continue;
			}
			if (!toolResultSucceeded(toolResult)) {
				reason = "Invalid tool payload";
				continue;
			}
			status = "success";
			reason = undefined;
			signal.throwIfAborted();
			await writeProjection(options.agentDir, projectKey, store);
			signal.throwIfAborted();
			if (options.mode === "commit" && options.cursorEntryId) {
				store.setExtractCursor(options.sessionId, options.cursorEntryId, new Date().toISOString());
			}
			break;
		}
		if (status !== "success") {
			status = "failed";
			reason = reason ?? "Extract did not produce a valid tool call";
		}
	} catch (error) {
		if (timeoutSignal.aborted || (options.signal.aborted && isTimeoutReason(options.signal.reason))) {
			status = "failed";
			reason = `Timed out after ${timeoutMs}ms`;
		} else if (options.signal.aborted) {
			status = "skipped";
			reason = "Aborted";
		} else {
			status = "failed";
			reason = error instanceof Error ? error.message : String(error);
		}
	}

	try {
		store.recordExtractRun({
			id: runId,
			startedAt,
			trigger: options.trigger,
			status,
			reason: reason ?? null,
		});
		store.recordHealth({
			operation: "extract",
			status: status === "success" ? "ok" : "error",
			updatedAt: new Date().toISOString(),
			reason:
				status === "success"
					? null
					: status === "skipped"
						? "Aborted; pending evidence will retry"
						: (reason ?? null),
		});
	} catch {
		// Audit failure must not hide the extract outcome.
	}

	store.close();
	return { status, reason, runId };
}

function isTimeoutReason(reason: unknown): boolean {
	return reason instanceof Error && reason.name === "TimeoutError";
}
