import type { AgentMessage } from "@metis/agent-core";
import type { FileEntry } from "../session-manager.ts";
import { AgentError, type AgentTraceEvent } from "./types.ts";

export const MAX_TRACE_EVENT_UTF8_BYTES = 16 * 1024;
export const MAX_TRACE_PAGE_UTF8_BYTES = 64 * 1024;

export interface ProjectAgentTraceInput {
	readonly journal: readonly FileEntry[];
	readonly taskId: string;
	readonly beforeEventId?: string;
	readonly limit?: number;
}

export interface ProjectAgentTraceResult {
	readonly events: readonly AgentTraceEvent[];
	readonly nextBeforeEventId?: string;
}

export function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function utf8Prefix(value: string, maxBytes: number): string {
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

function truncateTraceText(text: string): {
	readonly text: string;
	readonly truncated?: true;
	readonly originalBytes?: number;
} {
	const originalBytes = utf8Length(text);
	if (originalBytes <= MAX_TRACE_EVENT_UTF8_BYTES) return { text };
	const truncatedText = utf8Prefix(text, MAX_TRACE_EVENT_UTF8_BYTES);
	return { text: truncatedText, truncated: true, originalBytes };
}

function visibleAssistantText(message: AgentMessage): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text || undefined;
}

function assistantToolCalls(message: Extract<AgentMessage, { role: "assistant" }>) {
	return message.content.filter(
		(block): block is Extract<(typeof message.content)[number], { type: "toolCall" }> => block.type === "toolCall",
	);
}

function taskWindow(
	journal: readonly FileEntry[],
	taskId: string,
): { readonly start: number; readonly end: number } | undefined {
	let first = -1;
	let running = -1;
	let end = -1;
	for (let index = 0; index < journal.length; index++) {
		const entry = journal[index]!;
		if (entry.type === "agent_task" && entry.taskId === taskId) {
			if (first < 0) first = index;
			if (entry.status === "running") running = index;
			if (entry.status === "done" || entry.status === "failed" || entry.status === "stopped") end = index;
		}
	}
	if (first < 0) return undefined;
	return { start: running >= 0 ? running : first, end: end >= 0 ? end : journal.length - 1 };
}

function buildTraceEvents(journal: readonly FileEntry[], taskId: string): AgentTraceEvent[] {
	const window = taskWindow(journal, taskId);
	if (!window) return [];
	const toolResults = new Map<string, boolean>();
	let terminal: Extract<FileEntry, { type: "agent_task" }> | undefined;
	for (let index = window.start; index <= window.end; index++) {
		const entry = journal[index]!;
		if (entry.type === "message" && entry.message.role === "toolResult") {
			toolResults.set(entry.message.toolCallId, entry.message.isError === true);
		}
		if (
			entry.type === "agent_task" &&
			entry.taskId === taskId &&
			(entry.status === "done" || entry.status === "failed" || entry.status === "stopped")
		) {
			terminal = entry;
		}
	}
	const assistantEntries = journal
		.slice(window.start, window.end + 1)
		.filter(
			(entry): entry is Extract<FileEntry, { type: "message" }> =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				visibleAssistantText(entry.message) !== undefined,
		);
	const finalEntry = terminal
		? [...assistantEntries]
				.reverse()
				.find(
					(entry) =>
						assistantToolCalls(entry.message as Extract<AgentMessage, { role: "assistant" }>).length === 0,
				)
		: undefined;
	const events: AgentTraceEvent[] = [];
	for (let index = window.start; index <= window.end; index++) {
		const entry = journal[index]!;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			const text = visibleAssistantText(message);
			if (text) {
				events.push({
					eventId: entry.id,
					taskId,
					timestamp: entry.timestamp,
					kind: entry === finalEntry ? "final" : "llm",
					...truncateTraceText(text),
				});
			}
			for (const call of assistantToolCalls(message)) {
				const isError = toolResults.get(call.id);
				events.push({
					eventId: call.id,
					taskId,
					timestamp: entry.timestamp,
					kind: "tool",
					toolName: call.name,
					status: isError === undefined ? "running" : isError ? "failed" : "success",
				});
			}
			continue;
		}
		if (entry === terminal && terminal.finalMessage && !finalEntry) {
			events.push({
				eventId: entry.id,
				taskId,
				timestamp: entry.timestamp,
				kind: "final",
				...truncateTraceText(terminal.finalMessage),
			});
		}
	}
	return events;
}

function eventPayloadBytes(event: AgentTraceEvent): number {
	return utf8Length(JSON.stringify(event));
}

export function projectAgentTrace(input: ProjectAgentTraceInput): ProjectAgentTraceResult {
	const limit = input.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new AgentError("INVALID_INPUT", "Inspect limit must be from 1 through 100");
	}
	// Journals are append-ordered. Reverse that durable order so a tool call appears
	// before the assistant text that introduced it when both share a timestamp.
	const sorted = buildTraceEvents(input.journal, input.taskId).reverse();
	let candidates = sorted;
	if (input.beforeEventId) {
		const cursor = sorted.findIndex((event) => event.eventId === input.beforeEventId);
		if (cursor < 0) throw new AgentError("UNKNOWN_CURSOR", `Unknown trace cursor: ${input.beforeEventId}`);
		candidates = sorted.slice(cursor + 1);
	}
	const events: AgentTraceEvent[] = [];
	let pageBytes = 0;
	for (const candidate of candidates) {
		if (events.length >= limit) break;
		const eventBytes = eventPayloadBytes(candidate);
		if (pageBytes + eventBytes > MAX_TRACE_PAGE_UTF8_BYTES && events.length > 0) break;
		events.push(candidate);
		pageBytes += eventBytes;
	}
	const hasMore = events.length > 0 && events.length < candidates.length;
	return {
		events,
		...(hasMore ? { nextBeforeEventId: events.at(-1)!.eventId } : {}),
	};
}
