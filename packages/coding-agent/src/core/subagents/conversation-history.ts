import { persistToolOutputText } from "../large-tool-output.ts";
import type { AgentInputEntry } from "../session-control.ts";
import type { FileEntry } from "../session-manager.ts";
import { utf8Length, utf8Prefix } from "./trace.ts";
import { AgentError, type AgentMessageOrigin, type InspectAgentsInput } from "./types.ts";

export interface ConversationRecord {
	readonly messageId: string;
	readonly taskId?: string;
	readonly timestamp: string;
	readonly role: "user" | "assistant" | "tool" | "system";
	readonly origin: AgentMessageOrigin | { readonly kind: "historical_context" };
	readonly text: string;
	readonly attachments?: readonly { type: string; mimeType?: string; hash?: string }[];
	readonly deliveryState?: string;
	readonly fullOutputPath?: string;
	readonly truncated?: true;
}

export interface ConversationHistoryResult {
	readonly kind: "conversation";
	readonly agentId: string;
	readonly order: "newest_first";
	readonly records: readonly ConversationRecord[];
	readonly nextCursor?: string;
	readonly fullOutputPath?: string;
	readonly recordCount?: number;
}

function visibleContent(content: unknown): Pick<ConversationRecord, "text" | "attachments"> {
	if (typeof content === "string") return { text: content };
	const blocks = (Array.isArray(content) ? content : []) as readonly {
		type: string;
		text?: string;
		mimeType?: string;
		hash?: string;
	}[];
	const attachments = blocks
		.filter((block) => block.type === "image" || block.type === "image_ref")
		.map((block) => ({
			type: block.type,
			...(block.mimeType ? { mimeType: block.mimeType } : {}),
			...(block.hash ? { hash: block.hash } : {}),
		}));
	return {
		text: blocks
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n"),
		...(attachments.length ? { attachments } : {}),
	};
}

/** Project only visible conversation data, never provider reasoning or raw control records. */
function conversationRecords(journal: readonly FileEntry[], agentId: string): ConversationRecord[] {
	const inputs = new Map<string, AgentInputEntry>();
	const toolResults = new Map<string, Extract<FileEntry, { type: "message" }>>();
	const toolCalls = new Set<string>();
	for (const entry of journal) {
		if (entry.type === "agent_input") inputs.set(entry.messageId, entry);
		if (entry.type === "message" && entry.message.role === "toolResult")
			toolResults.set(entry.message.toolCallId, entry);
		if (entry.type === "message" && entry.message.role === "assistant")
			for (const block of entry.message.content) if (block.type === "toolCall") toolCalls.add(block.id);
	}
	const records: ConversationRecord[] = [];
	const seenInputs = new Set<string>();
	let taskId: string | undefined;
	for (const entry of journal) {
		if (entry.type === "agent_task" && entry.status === "running") taskId = entry.taskId;
		if (entry.type === "agent_input" && !seenInputs.has(entry.messageId)) {
			seenInputs.add(entry.messageId);
			const input = inputs.get(entry.messageId)!;
			records.push({
				messageId: input.messageId,
				taskId: input.taskId,
				timestamp: entry.timestamp,
				role: "user",
				origin: input.origin,
				deliveryState: input.state,
				...visibleContent([{ type: "text", text: input.input.text }, ...(input.input.images ?? [])]),
			});
		}
		if (entry.type === "agent_mailbox_event" && entry.event.type === "terminal") {
			const event = entry.event;
			if (event.finalMessage || event.error)
				records.push({
					messageId: event.eventId,
					taskId,
					timestamp: entry.timestamp,
					role: "system",
					origin: { kind: "agent", sessionId: event.agentId },
					text: event.finalMessage ?? event.error!,
				});
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const input = entry.agentMessageId ? inputs.get(entry.agentMessageId) : undefined;
			if (input) continue; // Keep the stable position of the initial durable input through queue delivery.
			records.push({
				messageId: entry.id,
				taskId,
				timestamp: entry.timestamp,
				role: "user",
				origin: { kind: "historical_context" },
				...visibleContent(message.content),
			});
		} else if (message.role === "assistant") {
			const visible = visibleContent(message.content);
			if (visible.text || visible.attachments?.length)
				records.push({
					messageId: entry.id,
					taskId,
					timestamp: entry.timestamp,
					role: "assistant",
					origin: { kind: "agent", sessionId: agentId },
					...visible,
				});
			for (const block of message.content) {
				if (block.type === "toolCall") {
					const result = toolResults.get(block.id);
					const status =
						result?.message.role === "toolResult"
							? result.message.isError
								? "failed"
								: "success"
							: "awaiting result";
					records.push({
						messageId: block.id,
						taskId,
						timestamp: entry.timestamp,
						role: "tool",
						origin: { kind: "agent", sessionId: agentId },
						text: `Tool ${block.name}: ${status}`,
						...(result?.toolOutput ? { fullOutputPath: result.toolOutput.fullOutputPath } : {}),
					});
				}
			}
		} else if (message.role === "toolResult") {
			if (toolCalls.has(message.toolCallId)) continue;
			records.push({
				messageId: entry.id,
				taskId,
				timestamp: entry.timestamp,
				role: "tool",
				origin: { kind: "agent", sessionId: agentId },
				text: `Tool ${message.toolName}: ${message.isError ? "failed" : "success"}`,
				...(entry.toolOutput ? { fullOutputPath: entry.toolOutput.fullOutputPath } : {}),
			});
		}
	}
	return records.reverse();
}

function exportText(agentId: string, records: readonly ConversationRecord[]): string {
	return [
		`Agent ${agentId} — visible conversation, newest first`,
		...records.map((record) => `\n--- ${JSON.stringify({ ...record, text: undefined })}\n${record.text}\n`),
	].join("\n");
}

export async function readAgentConversation(
	journal: readonly FileEntry[],
	agentId: string,
	input: InspectAgentsInput,
	outputDir: string,
): Promise<ConversationHistoryResult> {
	const limit = input.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new AgentError("INVALID_INPUT", "Inspect limit must be from 1 through 100");
	if (input.output === "file" && (input.cursor || input.limit !== undefined))
		throw new AgentError("INVALID_INPUT", "File export includes the full selected history; omit cursor and limit");
	if (input.messageId && input.cursor)
		throw new AgentError("INVALID_INPUT", "Message reads cannot use a history cursor");
	let records = conversationRecords(journal, agentId).filter(
		(record) => !input.taskId || record.taskId === input.taskId,
	);
	if (input.messageId) {
		records = records.filter((record) => record.messageId === input.messageId);
		if (!records.length) throw new AgentError("UNKNOWN_TASK", "Unknown visible message in the selected conversation");
	}
	const base = { kind: "conversation" as const, agentId, order: "newest_first" as const };
	if (input.output === "file")
		return {
			...base,
			records: [],
			recordCount: records.length,
			fullOutputPath: await persistToolOutputText(exportText(agentId, records), outputDir),
		};
	if (input.cursor) {
		const index = records.findIndex((record) => record.messageId === input.cursor);
		if (index < 0) throw new AgentError("UNKNOWN_CURSOR", "Unknown cursor in the selected conversation");
		records = records.slice(index + 1);
	}
	const page: ConversationRecord[] = [];
	let pageBytes = 0;
	for (const record of records) {
		if (page.length >= limit) break;
		const long = utf8Length(record.text) > 16 * 1024;
		let preview = long ? { ...record, text: utf8Prefix(record.text, 2048), truncated: true as const } : record;
		const bytes = utf8Length(JSON.stringify(preview));
		if (page.length && pageBytes + bytes > 60 * 1024) break;
		if (long) preview = { ...preview, fullOutputPath: await persistToolOutputText(record.text, outputDir) };
		page.push(preview);
		pageBytes += utf8Length(JSON.stringify(preview));
	}
	return { ...base, records: page, ...(page.length < records.length ? { nextCursor: page.at(-1)!.messageId } : {}) };
}
