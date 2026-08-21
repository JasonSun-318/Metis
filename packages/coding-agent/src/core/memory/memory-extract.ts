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

export function hasDurableMemoryIntent(text: string): boolean {
	return DURABLE_MEMORY_INTENT_RE.test(text);
}

export const COMMIT_EXTRACT_SYSTEM_PROMPT = `You extract durable user/project facts for long-term memory.

Rules:
- Uncertain scope → project (never invent a third scope).
- commit_facts is ADD-only: only append new facts; never delete or supersede on a turn extract.
- Do not read or write the memory directory. Your only action is calling the commit_facts tool.
- Every fact must include topicFile: a flat basename matching [A-Za-z0-9][A-Za-z0-9._-]*.md (reuse an existing topic file when the fact belongs there; mint a new basename only for a new topic).
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
	messages: AgentMessage[];
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
	const evidence = (options.serializeEvidence ?? serializeExtractEvidence)(options.messages);
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
			thinkingLevel: options.thinkingLevel ?? "off",
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

export async function runMemoryExtract(options: RunMemoryExtractOptions): Promise<MemoryExtractResult> {
	const runId = randomUUID();
	const startedAt = new Date().toISOString();
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
		options.signal.throwIfAborted();
		for (let attempt = 0; attempt < 2; attempt++) {
			options.signal.throwIfAborted();
			const userPrompt = attempt === 0 ? baseUserPrompt : `${baseUserPrompt}\n\n${RETRY_USER_MESSAGE}`;
			const messages = await promptFn({
				attempt,
				systemPrompt,
				userPrompt,
				tool,
				signal: options.signal,
			});
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
			await writeProjection(options.agentDir, projectKey, store);
			break;
		}
		if (status !== "success") {
			status = "failed";
			reason = reason ?? "Extract did not produce a valid tool call";
		}
	} catch (error) {
		status = "failed";
		reason = error instanceof Error ? error.message : String(error);
	}

	try {
		store.recordExtractRun({
			id: runId,
			startedAt,
			trigger: options.trigger,
			status,
			reason: reason ?? null,
		});
	} catch {
		// Audit failure must not hide the extract outcome.
	}

	store.close();
	return { status, reason, runId };
}
