import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel } from "@metis/agent-core";
import type { Model } from "@metis/ai/compat";
import { canonicalizePathForCreation, encodePathForStorage } from "../../utils/paths.ts";
import type { AgentMode } from "../agent-mode.ts";
import { getMemorySqlitePath } from "../auto-memory.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { serializeExtractEvidence } from "./memory-evidence.ts";
import { writeProjection as writeProjectionDefault } from "./memory-projection.ts";
import { type MemoryStore, openMemoryStore } from "./memory-store.ts";
import { createCommitFactsTool, createReconcileFactsTool, type MemoryToolContext } from "./memory-tools.ts";
import type { MemoryExtractRunStatus, MemoryFact } from "./memory-types.ts";

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
- Code applies recency using createdAt/sourceTurn. Prefer including ids from the supplied fact list only.
- merge: keep the newest sourceTurn/createdAt id as the survivor unless you name survivorId; if timestamps tie, the first listed survivor wins and the rest are superseded.
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
	cwdKey?: string;
	promptFn?: MemoryExtractPromptFn;
	serializeEvidence?: typeof serializeExtractEvidence;
	openStore?: (path: string) => MemoryStore;
	writeProjection?: typeof writeProjectionDefault;
	projectAfterWrite?: boolean;
}

export interface MemoryExtractResult {
	status: MemoryExtractRunStatus;
	reason?: string;
	runId: string;
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
	cwdKey: string,
	mode: string,
): {
	active: MemoryFact[];
	superseded: Array<Pick<MemoryFact, "id" | "text" | "createdAt" | "sourceTurn" | "scope" | "topicFile">>;
} {
	const active = [...store.listActiveFacts("global", null, null), ...store.listActiveFacts("project", cwdKey, mode)]
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
		.slice(0, 200);

	const superseded = store.listFactsByStatus("superseded", 50).map((fact) => ({
		id: fact.id,
		text: fact.text.length > 200 ? `${fact.text.slice(0, 200)}…` : fact.text,
		createdAt: fact.createdAt,
		sourceTurn: fact.sourceTurn,
		scope: fact.scope,
		topicFile: fact.topicFile,
	}));

	return { active, superseded };
}

function buildUserPrompt(options: RunMemoryExtractOptions, store: MemoryStore, cwdKey: string): string {
	const evidence = (options.serializeEvidence ?? serializeExtractEvidence)(options.messages);
	if (options.mode === "commit") {
		return `<extract_mode>commit</extract_mode>
<conversation_evidence>
${evidence}
</conversation_evidence>`;
	}
	const facts = buildReconcileFactsPayload(store, cwdKey, options.agentMode);
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
	const cwdKey = options.cwdKey ?? encodePathForStorage(canonicalizePathForCreation(options.cwd));
	const toolContext: MemoryToolContext = {
		store,
		agentDir: options.agentDir,
		cwd: options.cwd,
		agentMode: options.agentMode,
		cwdKey,
		mode: options.agentMode,
		sourceTurn: options.sourceTurn ?? null,
		createdAt: options.createdAt,
		// Runner owns the final projection write so injectable writeProjection is honored.
		projectAfterWrite: false,
	};

	const definition =
		options.mode === "commit" ? createCommitFactsTool(toolContext) : createReconcileFactsTool(toolContext);
	const tool = wrapToolDefinition(definition);
	const systemPrompt = options.mode === "commit" ? COMMIT_EXTRACT_SYSTEM_PROMPT : RECONCILE_EXTRACT_SYSTEM_PROMPT;
	const baseUserPrompt = buildUserPrompt(options, store, cwdKey);
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
			writeProjection(options.agentDir, options.cwd, options.agentMode, store);
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
