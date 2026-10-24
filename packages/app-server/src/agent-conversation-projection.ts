import type { ItemView } from "@metis/app-protocol";
import type { FileEntry } from "@metis/coding-agent/host";
import { opaqueId, projectMessageEntry, textPrefixWithinBytes, timestamp } from "./item-projection.ts";

type AgentInput = Extract<FileEntry, { type: "agent_input" }>;
export type AgentInputDelivery = Pick<AgentInput, "agentId" | "state">;
type MailboxEntry = Extract<FileEntry, { type: "agent_mailbox_event" }>;

export function latestAgentInputs(journal: readonly FileEntry[]): Map<string, AgentInput> {
	const inputs = new Map<string, AgentInput>();
	for (const entry of journal) if (entry.type === "agent_input") inputs.set(entry.messageId, entry);
	return inputs;
}

export function withAgentInput(item: ItemView, input: AgentInput | undefined): ItemView {
	if (!input) return item;
	return {
		...item,
		origin: input.origin,
		agentMessageId: opaqueId(input.messageId, "agent-message"),
		agentTaskId: opaqueId(input.taskId, "agent-task"),
		deliveryState: input.state,
		instructionRevision: input.instructionRevision,
	};
}

/** Accepted inputs remain visible even before the runtime writes a model message. */
export function projectPendingAgentInput(input: AgentInput, sessionId: string, fallbackTimestamp: string): ItemView {
	const item = projectMessageEntry({
		entry: {
			type: "message",
			id: `agent-input:${input.messageId}`,
			timestamp: input.timestamp,
			message: { role: "user", content: [{ type: "text", text: input.input.text }, ...(input.input.images ?? [])] },
		},
		sessionId,
		turnStates: new Map(),
		toolStates: new Map(),
		fallbackTimestamp,
	})!;
	return withAgentInput(item, input);
}

export function projectAgentMailboxItem(
	entry: MailboxEntry,
	sessionId: string,
	fallbackTimestamp: string,
	inputs?: ReadonlyMap<string, AgentInputDelivery>,
): ItemView {
	const event = entry.event;
	const createdAt = timestamp(entry.timestamp, fallbackTimestamp);
	const receipt = event.type === "intervention" ? inputs?.get(event.messageId) : undefined;
	const text =
		event.type === "intervention"
			? `You sent a message to ${event.name}:\n${event.text}${event.imageCount ? `\n(${event.imageCount} attached images)` : ""}`
			: event.type === "run_control"
				? `You ${event.action === "stop" ? "stopped" : "resumed"} ${event.name}${event.scope === "subtree" ? " and its agents" : ""}.`
				: `${event.name}: ${event.status}\n${event.finalMessage ?? event.error ?? ""}`;
	return {
		itemId: opaqueId(event.eventId, "agent-event"),
		sessionId,
		role: "system",
		state: "completed",
		origin: { kind: "system", eventId: opaqueId(event.eventId, "agent-event") },
		agentTargetId: event.agentId,
		agentTaskId: opaqueId(event.taskId, "agent-task"),
		...(event.type === "intervention"
			? {
					agentMessageId: opaqueId(event.messageId, "agent-message"),
					deliveryState: receipt?.state ?? event.state,
					instructionRevision: event.instructionRevision,
				}
			: {}),
		content: [{ type: "text", text: textPrefixWithinBytes(text, 16 * 1024) }],
		createdAt,
		completedAt: createdAt,
	};
}
