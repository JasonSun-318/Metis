import type { CustomMessage } from "./messages.ts";
import { buildAgentMailboxContent } from "./subagents/prompts.ts";
import { utf8Length } from "./subagents/trace.ts";
import {
	type AgentMailboxEvent,
	MAX_AGENT_MAILBOX_DELIVERY_EVENTS,
	MAX_AGENT_MAILBOX_DELIVERY_UTF8_BYTES,
} from "./subagents/types.ts";

/** Durable custom message that carries one mailbox event into the model context. */
export function createAgentMailboxMessage(
	event: AgentMailboxEvent,
	now = Date.now(),
): CustomMessage<AgentMailboxEvent> {
	return {
		role: "custom",
		customType: "agent_mailbox",
		content: buildAgentMailboxContent(event),
		display: true,
		details: event,
		timestamp: now,
	};
}

/**
 * Selects the next mailbox delivery batch in queue order, bounded by both event
 * count and UTF-8 payload size. Event ids without a pending event are skipped;
 * the first event is always admitted so a single oversized payload cannot
 * wedge delivery.
 */
export function planAgentMailboxDelivery(
	eventIds: Iterable<string>,
	getEvent: (eventId: string) => AgentMailboxEvent | undefined,
): readonly string[] {
	const batch: string[] = [];
	let bytes = 0;
	for (const eventId of new Set(eventIds)) {
		const event = getEvent(eventId);
		if (!event) continue;
		const eventBytes = buildAgentMailboxContent(event).reduce((total, block) => total + utf8Length(block.text), 0);
		if (batch.length > 0 && bytes + eventBytes > MAX_AGENT_MAILBOX_DELIVERY_UTF8_BYTES) break;
		batch.push(eventId);
		bytes += eventBytes;
		if (batch.length >= MAX_AGENT_MAILBOX_DELIVERY_EVENTS) break;
	}
	return batch;
}
