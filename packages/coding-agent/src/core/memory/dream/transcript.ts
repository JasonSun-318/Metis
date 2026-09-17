import type { ImageContent, TextContent } from "@metis/ai";
import { extractUserMessageText } from "../../agent-session-transcript.ts";
import { SessionManager } from "../../session-manager.ts";
import { looksLikeSecret } from "../memory-secrets.ts";

/** Per-tool-result cap inside the serialized transcript. */
export const DREAM_TOOL_RESULT_MAX_CHARS = 1_500;
/** Total transcript budget; the tail (most recent activity) is kept. */
export const DREAM_TRANSCRIPT_MAX_CHARS = 40_000;
/** Per user/assistant message cap so one paste can't eat the budget. */
const MESSAGE_MAX_CHARS = 8_000;
/** Tool-call argument summary cap. */
const TOOL_CALL_ARGS_MAX_CHARS = 300;

export interface DreamTranscript {
	text: string;
	/** True when the session used web_fetch/web_search/MCP tools (untrusted content). */
	polluted: boolean;
}

const MCP_HELPER_TOOLS = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
	"list_mcp_prompts",
	"get_mcp_prompt",
]);

function isPollutingTool(name: string): boolean {
	return name === "web_fetch" || name === "web_search" || name.startsWith("mcp__") || MCP_HELPER_TOOLS.has(name);
}

function clip(text: string, maxChars: number): string {
	const chars = [...text];
	return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join("")}…`;
}

function toolResultText(content: (TextContent | ImageContent)[]): string {
	return content
		.map((part) => (part.type === "text" ? part.text : "[image]"))
		.filter((text) => text.length > 0)
		.join("\n");
}

/** Replace any line that smells like a secret with a fixed marker. */
function redactSecrets(text: string): string {
	return text
		.split("\n")
		.map((line) => (looksLikeSecret(line) ? "[redacted]" : line))
		.join("\n");
}

/**
 * Serialize a persisted session's active branch for Dream phase 1: user and
 * assistant text, tool calls with clipped argument summaries, and tool results
 * (each capped, tail kept within the overall budget). Secret-looking lines are
 * redacted. Throws when the session file cannot be opened.
 */
export function serializeSessionForDream(path: string): DreamTranscript {
	const manager = SessionManager.openReadOnly(path);
	const parts: string[] = [];
	let polluted = false;

	for (const entry of manager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = extractUserMessageText(message.content).trim();
			if (text.length > 0) parts.push(`User:\n${clip(text, MESSAGE_MAX_CHARS)}`);
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("")
				.trim();
			if (text.length > 0) parts.push(`Assistant:\n${clip(text, MESSAGE_MAX_CHARS)}`);
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (isPollutingTool(part.name)) polluted = true;
				let args = "";
				try {
					args = JSON.stringify(part.arguments ?? {});
				} catch {
					args = "{}";
				}
				parts.push(`Tool call: ${part.name} ${clip(args, TOOL_CALL_ARGS_MAX_CHARS)}`);
			}
		} else if (message.role === "toolResult") {
			if (isPollutingTool(message.toolName)) polluted = true;
			const text = toolResultText(message.content).trim();
			if (text.length > 0) {
				parts.push(`Tool result [${message.toolName}]:\n${clip(text, DREAM_TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	const redacted = parts.map(redactSecrets);
	// Keep the tail within the total budget; every part is pre-clipped so the
	// most recent part always fits.
	const kept: string[] = [];
	let total = 0;
	for (let index = redacted.length - 1; index >= 0; index--) {
		const part = redacted[index]!;
		if (kept.length > 0 && total + part.length + 2 > DREAM_TRANSCRIPT_MAX_CHARS) break;
		kept.unshift(part);
		total += part.length + 2;
	}
	if (kept.length < redacted.length) kept.unshift("[Earlier transcript truncated]");
	return { text: kept.join("\n\n"), polluted };
}
