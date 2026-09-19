/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@metis/agent-core";
import type { ImageContent, Message, PromptCacheOrigin, TextContent } from "@metis/ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@metis/agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

declare module "@metis/ai" {
	interface UserMessage {
		hookContext?: string;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

function convertMessageToLlm(m: AgentMessage): Message | undefined {
	switch (m.role) {
		case "bashExecution":
			// Skip messages excluded from context (!! prefix)
			if (m.excludeFromContext) {
				return undefined;
			}
			return {
				role: "user",
				content: [{ type: "text", text: bashExecutionToText(m) }],
				timestamp: m.timestamp,
			};
		case "custom": {
			const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
			return {
				role: "user",
				content,
				timestamp: m.timestamp,
			};
		}
		case "branchSummary":
			return {
				role: "user",
				content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
				timestamp: m.timestamp,
			};
		case "compactionSummary":
			return {
				role: "user",
				content: [
					{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
				],
				timestamp: m.timestamp,
			};
		case "user": {
			const hookContext = (m as { hookContext?: string }).hookContext;
			if (!hookContext) {
				return m;
			}
			if (typeof m.content === "string") {
				return {
					...m,
					content: `${m.content}\n\n${hookContext}`,
				};
			}
			return {
				...m,
				content: [...m.content, { type: "text" as const, text: hookContext }],
			};
		}
		case "assistant":
		case "toolResult":
			return m;
		default: {
			const exhaustiveCheck: never = m;
			return exhaustiveCheck;
		}
	}
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.map(convertMessageToLlm).filter((m) => m !== undefined);
}

/**
 * Convert AgentMessages while tracking which prompt-cache origin produced each
 * output message. `origins` must have exactly one entry per input message;
 * messages that convert to zero outputs drop their origin alongside them.
 */
export function convertToLlmWithOrigins(
	messages: AgentMessage[],
	origins: readonly PromptCacheOrigin[],
): { messages: Message[]; origins: PromptCacheOrigin[] } {
	if (messages.length !== origins.length) {
		throw new Error(`origin count mismatch: ${origins.length} origins for ${messages.length} messages`);
	}
	const converted: Message[] = [];
	const mapped: PromptCacheOrigin[] = [];
	messages.forEach((message, index) => {
		const result = convertMessageToLlm(message);
		if (result !== undefined) {
			converted.push(result);
			mapped.push(origins[index]!);
		}
	});
	return { messages: converted, origins: mapped };
}
