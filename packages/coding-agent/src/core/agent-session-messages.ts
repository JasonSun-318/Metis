import type { AgentMessage } from "@metis/agent-core";
import type { AssistantMessage, Message, TextContent } from "@metis/ai/compat";

/** Extracts only the text blocks of a user message. */
export function getUserMessageText(message: Message): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	const textBlocks = content.filter((contentBlock) => contentBlock.type === "text");
	return textBlocks.map((contentBlock) => (contentBlock as TextContent).text).join("");
}

/** Finds the last assistant message, including aborted ones. */
export function findLastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

/**
 * Agent-core stores the finalized message object in state before emitting
 * message_end. Mutating that object in place keeps agent state, later events,
 * listeners and SessionManager persistence in sync.
 */
export function replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
	if (target === replacement) return;
	const targetRecord = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(targetRecord)) {
		delete targetRecord[key];
	}
	Object.assign(targetRecord, replacement);
}

/** Collapses a prompt snippet to one trimmed line. */
export function normalizePromptSnippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const oneLine = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return oneLine.length > 0 ? oneLine : undefined;
}

/** Trims, drops empty and de-duplicates prompt guidelines while preserving order. */
export function normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) return [];
	const unique = new Set<string>();
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) unique.add(normalized);
	}
	return Array.from(unique);
}

/** Text of the last assistant message, skipping empty aborted responses. */
export function getLastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((message) => {
			if (message.role !== "assistant") return false;
			const assistant = message as AssistantMessage;
			if (assistant.stopReason === "aborted" && assistant.content.length === 0) return false;
			return true;
		});
	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of (lastAssistant as AssistantMessage).content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() || undefined;
}
