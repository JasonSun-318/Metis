import type { AgentMessage } from "@metis/agent-core";
import type { SessionEntry } from "../session-manager.ts";

/** Max characters of assistant text kept per message. */
export const ASSISTANT_EVIDENCE_MAX_CHARS = 2000;

/** Max characters of the full evidence string. */
export const TOTAL_EVIDENCE_MAX_CHARS = 8000;

export interface MemoryEvidenceBatch {
	evidence: string;
	cursorEntryId: string | null;
	hasMore: boolean;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}

function formatToolArgs(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([key, value]) => {
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				return `${key}=${value}`;
			}
			return `${key}=${JSON.stringify(value)}`;
		})
		.join(" ");
}

function userText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function serializeMessage(message: AgentMessage): string | undefined {
	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		return undefined;
	}

	if (message.role === "user") {
		const content = userText(message).trim();
		return content ? `[User]: ${content}` : undefined;
	}

	if (message.role === "assistant") {
		const parts: string[] = [];
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) {
			parts.push(`[Assistant]: ${truncate(text, ASSISTANT_EVIDENCE_MAX_CHARS)}`);
		}
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const args = formatToolArgs(block.arguments as Record<string, unknown>);
			parts.push(args ? `tool:${block.name} ${args}` : `tool:${block.name}`);
		}
		return parts.length > 0 ? parts.join("\n") : undefined;
	}

	if (message.role === "toolResult") {
		// Name/args come from the matching assistant toolCall; never include result bodies.
		return undefined;
	}

	return undefined;
}

/**
 * Serialize conversation turns for the memory extract agent.
 * Keeps user text and capped assistant text, records tool call names/args,
 * and never includes tool result bodies or synthetic summaries.
 */
export function serializeExtractEvidence(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		const part = serializeMessage(message);
		if (part) parts.push(part);
	}
	return truncate(parts.join("\n\n"), TOTAL_EVIDENCE_MAX_CHARS);
}

/** Select the oldest complete pending message-entry batch after a durable cursor. */
export function collectMemoryEvidenceBatch(
	branch: readonly SessionEntry[],
	cursorEntryId: string | null,
): MemoryEvidenceBatch {
	const cursorIndex = cursorEntryId ? branch.findIndex((entry) => entry.id === cursorEntryId) : -1;
	const parts: string[] = [];
	let evidenceLength = 0;
	let cursor: string | null = null;
	for (let index = cursorIndex >= 0 ? cursorIndex + 1 : 0; index < branch.length; index++) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const part = serializeMessage(entry.message);
		if (part) {
			if (parts.length === 0 && part.length > TOTAL_EVIDENCE_MAX_CHARS) {
				parts.push(part.slice(-TOTAL_EVIDENCE_MAX_CHARS));
				cursor = entry.id;
				return { evidence: parts[0]!, cursorEntryId: cursor, hasMore: hasMessageAfter(branch, index + 1) };
			}
			const candidateLength = evidenceLength + part.length + (parts.length > 0 ? 2 : 0);
			if (candidateLength > TOTAL_EVIDENCE_MAX_CHARS) {
				return { evidence: parts.join("\n\n"), cursorEntryId: cursor, hasMore: true };
			}
			parts.push(part);
			evidenceLength = candidateLength;
		}
		cursor = entry.id;
	}
	return { evidence: parts.join("\n\n"), cursorEntryId: cursor, hasMore: false };
}

function hasMessageAfter(branch: readonly SessionEntry[], start: number): boolean {
	for (let index = start; index < branch.length; index++) {
		if (branch[index]?.type === "message") return true;
	}
	return false;
}
