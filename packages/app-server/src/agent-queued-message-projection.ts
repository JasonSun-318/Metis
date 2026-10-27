import type { QueuedTurnView } from "@metis/app-protocol";
import type { AgentQueuedMessage } from "@metis/coding-agent/host";
import { splitSessionAttachmentPrompt } from "@metis/coding-agent/host";
import { opaqueId } from "./item-projection.ts";

export function projectAgentQueuedTurns(messages: readonly AgentQueuedMessage[]): QueuedTurnView[] {
	return messages.map((message) => {
		const { text, attachments } = splitSessionAttachmentPrompt(message.input.text);
		return {
			queueItemId: opaqueId(message.messageId, "queue"),
			revision: opaqueId(message.revision, "entry"),
			state: message.state,
			text,
			attachments: attachments.map(({ name, size }) => ({ name, byteLength: size })),
		};
	});
}
