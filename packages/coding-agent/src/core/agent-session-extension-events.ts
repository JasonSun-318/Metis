import type { AgentEvent } from "@metis/agent-core";
import type {
	AgentEndEvent,
	AgentStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "./extensions/types.ts";

type MappedExtensionEvent =
	| AgentStartEvent
	| AgentEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent;

type SelfContainedAgentEvent = Exclude<AgentEvent, { type: "turn_start" | "turn_end" | "message_end" }>;

/**
 * Private, side-effect-free construction of extension events from agent events.
 *
 * Turn events take their turn index (and start timestamp) as explicit inputs,
 * and message_end has a dedicated builder so the caller can re-read the original
 * agent event after the awaited handler. Event types not mapped here are ignored,
 * matching the original if/else chain.
 */
export function mapAgentEventToExtensionEvent(event: SelfContainedAgentEvent): MappedExtensionEvent | undefined {
	if (event.type === "agent_start") {
		return { type: "agent_start" };
	}
	if (event.type === "agent_end") {
		return { type: "agent_end", messages: event.messages };
	}
	if (event.type === "message_start") {
		return { type: "message_start", message: event.message };
	}
	if (event.type === "message_update") {
		return { type: "message_update", message: event.message, assistantMessageEvent: event.assistantMessageEvent };
	}
	if (event.type === "tool_execution_start") {
		return { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
	}
	if (event.type === "tool_execution_update") {
		return {
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			partialResult: event.partialResult,
		};
	}
	if (event.type === "tool_execution_end") {
		return {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		};
	}
	return undefined;
}

export function createTurnStartExtensionEvent(turnIndex: number, timestamp: number): TurnStartEvent {
	return { type: "turn_start", turnIndex, timestamp };
}

export function createTurnEndExtensionEvent(
	turnIndex: number,
	event: Extract<AgentEvent, { type: "turn_end" }>,
): TurnEndEvent {
	return { type: "turn_end", turnIndex, message: event.message, toolResults: event.toolResults };
}

export function createMessageEndExtensionEvent(event: Extract<AgentEvent, { type: "message_end" }>): MessageEndEvent {
	return { type: "message_end", message: event.message };
}
