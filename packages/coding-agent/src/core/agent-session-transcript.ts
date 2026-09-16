import type { AssistantMessage } from "@metis/ai/compat";
import type { AgentMode } from "./agent-mode.ts";
import type { ContextUsage } from "./extensions/index.ts";
import type { PermissionPreset } from "./permissions/settings.ts";
import type { CwdOrigin, SessionEntry } from "./session-manager.ts";

export interface SessionStats {
	mode: AgentMode;
	cwd: string;
	cwdOrigin: CwdOrigin;
	permissionPreset: PermissionPreset;
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

export function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

export function listUserMessagesForForking(entries: readonly SessionEntry[]): Array<{ entryId: string; text: string }> {
	const result: Array<{ entryId: string; text: string }> = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractUserMessageText(entry.message.content);
		if (text) result.push({ entryId: entry.id, text });
	}
	return result;
}

export function buildSessionStats(options: {
	entries: readonly SessionEntry[];
	mode: AgentMode;
	cwd: string;
	cwdOrigin: CwdOrigin;
	permissionPreset: PermissionPreset;
	sessionFile: string | undefined;
	sessionId: string;
	contextUsage?: ContextUsage;
}): SessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const entry of options.entries) {
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMessage = message as AssistantMessage;
			if (Array.isArray(assistantMessage.content)) {
				toolCalls += assistantMessage.content.filter((part) => part.type === "toolCall").length;
			}
			const usage = assistantMessage.usage;
			totalInput += usage.input;
			totalOutput += usage.output;
			totalCacheRead += usage.cacheRead;
			totalCacheWrite += usage.cacheWrite;
			totalCost += usage.cost.total;
		}
	}

	return {
		mode: options.mode,
		cwd: options.cwd,
		cwdOrigin: options.cwdOrigin,
		permissionPreset: options.permissionPreset,
		sessionFile: options.sessionFile,
		sessionId: options.sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
		},
		cost: totalCost,
		contextUsage: options.contextUsage,
	};
}
