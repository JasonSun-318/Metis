import type { AgentMessage } from "@metis/agent-core";
import type { ToolResultMessage } from "@metis/ai/compat";
import {
	type DurablePromptInput,
	type ReducedRuntimeOperation,
	type ReducedRuntimeQueueItem,
	type ReducedRuntimeTurn,
	type RuntimeRecoveryDecision,
	type RuntimeRecoveryResult,
	reduceRuntimeJournal,
} from "./runtime-recovery.ts";
import type { SessionManager } from "./session-manager.ts";

export interface RecoverablePromptDraft {
	readonly queueItemId: string;
	readonly input: DurablePromptInput;
}

export interface MaterializedRuntimeRecovery {
	readonly drafts: readonly RecoverablePromptDraft[];
	readonly syntheticMessages: readonly AgentMessage[];
	readonly state: RuntimeRecoveryResult;
}

function syntheticToolResult(decision: {
	toolCallId: string;
	toolName: string;
	reason: "server_restarted";
}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: decision.toolCallId,
		toolName: decision.toolName,
		content: [
			{
				type: "text",
				text: "Tool execution was interrupted before completion. The tool was not run again.",
			},
		],
		isError: true,
		timestamp: Date.now(),
	};
}

/** Append the model-context repair for a tool call that will not be replayed. */
export function appendSyntheticRuntimeToolResult(
	sessionManager: SessionManager,
	turnId: string,
	toolCallId: string,
	toolName: string,
): ToolResultMessage {
	const message = syntheticToolResult({ toolCallId, toolName, reason: "server_restarted" });
	sessionManager.appendMessage(message, undefined, turnId);
	return message;
}

function appendOperationTerminal(
	sessionManager: SessionManager,
	operation: ReducedRuntimeOperation,
	state: "completed" | "interrupted",
	turnId?: string,
): void {
	sessionManager.appendRuntimeControl({
		type: "runtime_operation",
		operationId: operation.operationId,
		requestId: operation.requestId,
		requestHash: operation.requestHash,
		kind: operation.kind,
		state,
		...(turnId === undefined ? {} : { turnId }),
		...(state === "interrupted"
			? { error: { code: "RUNTIME_INTERRUPTED", message: "The operation did not complete." } }
			: {}),
	});
}

function appendTurnTerminal(
	sessionManager: SessionManager,
	turn: ReducedRuntimeTurn,
	state: "completed" | "interrupted",
): void {
	sessionManager.appendRuntimeControl({
		type: "runtime_turn",
		turnId: turn.turnId,
		operationIds: turn.operationIds,
		state,
		consumedQueueItemIds: turn.consumedQueueItemIds,
	});
}

function appendQueueCancellation(sessionManager: SessionManager, queue: ReducedRuntimeQueueItem): void {
	sessionManager.appendRuntimeControl({
		type: "runtime_queue",
		operationId: queue.operationId,
		queueItemId: queue.queueItemId,
		queue: queue.queue,
		state: "cancelled",
		reason: "server_restarted",
	});
}

function appendQueuePause(sessionManager: SessionManager, queue: ReducedRuntimeQueueItem): void {
	if (queue.queue !== "next_turn" || !queue.requestId || !queue.enqueueHash) {
		throw new Error(`Cannot pause non-next-turn queue item: ${queue.queueItemId}`);
	}
	sessionManager.appendRuntimeControl({
		type: "runtime_queue",
		operationId: queue.operationId,
		queueItemId: queue.queueItemId,
		queue: "next_turn",
		state: "paused",
		requestId: queue.requestId,
		enqueueHash: queue.enqueueHash,
		...(queue.deliveryRequestId === undefined ? {} : { deliveryRequestId: queue.deliveryRequestId }),
		reason: "server_restarted",
	});
}

/**
 * Materialize reducer decisions in reducer order. Every mutation is synchronous;
 * a thrown append leaves only durable prefix work for the next invocation.
 */
export function materializeRuntimeRecovery(sessionManager: SessionManager): MaterializedRuntimeRecovery {
	const reduced = reduceRuntimeJournal(sessionManager.getDurableJournalSnapshot());
	if (reduced.decisions.length === 0) {
		return { drafts: collectRecoverableDrafts(reduced), syntheticMessages: [], state: reduced };
	}
	const turns = new Map(reduced.turns.map((turn) => [turn.turnId, turn]));
	const operations = new Map(reduced.operations.map((operation) => [operation.operationId, operation]));
	const queues = new Map(reduced.queues.map((queue) => [queue.queueItemId, queue]));
	const syntheticMessages: AgentMessage[] = [];

	for (const decision of reduced.decisions) {
		switch (decision.type) {
			case "complete_tool":
			case "interrupt_tool":
				sessionManager.appendRuntimeControl({
					type: "runtime_tool",
					turnId: decision.turnId,
					toolCallId: decision.toolCallId,
					toolName: decision.toolName,
					state: decision.type === "complete_tool" ? "completed" : "interrupted",
				});
				if (decision.type === "complete_tool") break;
				// The interrupted marker must precede its structural repair.
				appendSynthetic(sessionManager, decision, syntheticMessages);
				break;
			case "synthesize_tool_result":
				appendSynthetic(sessionManager, decision, syntheticMessages);
				break;
			case "complete_turn":
			case "interrupt_turn": {
				const turn = turns.get(decision.turnId);
				if (!turn) throw new Error(`Missing reduced runtime turn: ${decision.turnId}`);
				appendTurnTerminal(sessionManager, turn, decision.type === "complete_turn" ? "completed" : "interrupted");
				break;
			}
			case "complete_operation":
			case "interrupt_operation": {
				const operation = operations.get(decision.operationId);
				if (!operation) throw new Error(`Missing reduced runtime operation: ${decision.operationId}`);
				appendOperationTerminal(
					sessionManager,
					operation,
					decision.type === "complete_operation" ? "completed" : "interrupted",
					decision.turnId,
				);
				break;
			}
			case "pause_queue": {
				const queue = queues.get(decision.queueItemId);
				if (!queue) throw new Error(`Missing reduced runtime queue item: ${decision.queueItemId}`);
				appendQueuePause(sessionManager, queue);
				break;
			}
			case "cancel_queue": {
				const queue = queues.get(decision.queueItemId);
				if (!queue) throw new Error(`Missing reduced runtime queue item: ${decision.queueItemId}`);
				appendQueueCancellation(sessionManager, queue);
				break;
			}
		}
	}

	const state = reduceRuntimeJournal(sessionManager.getDurableJournalSnapshot());
	return { drafts: collectRecoverableDrafts(state), syntheticMessages, state };
}

function collectRecoverableDrafts(state: RuntimeRecoveryResult): RecoverablePromptDraft[] {
	const drafts: RecoverablePromptDraft[] = [];
	for (const queue of state.queues) {
		if (queue.state === "cancelled" && queue.reason === "server_restarted") {
			drafts.push({ queueItemId: queue.queueItemId, input: structuredClone(queue.input) });
		}
	}
	return drafts;
}

function appendSynthetic(
	sessionManager: SessionManager,
	decision: Extract<RuntimeRecoveryDecision, { type: "interrupt_tool" | "synthesize_tool_result" }>,
	syntheticMessages: AgentMessage[],
): void {
	const message = appendSyntheticRuntimeToolResult(
		sessionManager,
		decision.turnId,
		decision.toolCallId,
		decision.toolName,
	);
	syntheticMessages.push(message);
}
