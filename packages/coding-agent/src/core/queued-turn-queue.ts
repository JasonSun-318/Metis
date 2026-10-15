import { randomUUID } from "node:crypto";
import {
	type DurablePromptInput,
	identifyRuntimeRequest,
	RequestIdReusedError,
	reduceRuntimeJournal,
} from "./runtime-recovery.ts";
import { formatSessionAttachments, splitSessionAttachmentPrompt } from "./session-attachments.ts";
import { formatSessionConversationQuotes } from "./session-conversation-quotes.ts";
import { formatSessionFileSelections } from "./session-file-selections.ts";
import type { SessionManager } from "./session-manager.ts";

export const MAX_QUEUED_TURNS = 32;

export type QueuedTurnDraftState = "queued" | "paused" | "sending";

export interface QueuedTurnDraft {
	readonly queueItemId: string;
	readonly operationId: string;
	readonly requestId: string;
	readonly deliveryRequestId?: string;
	readonly revision: string;
	readonly input: DurablePromptInput;
	readonly state: QueuedTurnDraftState;
	readonly reason?: string;
}

export class QueuedTurnConflictError extends Error {
	readonly code = "CONFLICT";
	readonly queueItemId: string;
	constructor(queueItemId: string) {
		super(`Queued turn changed before the operation completed: ${queueItemId}`);
		this.name = "QueuedTurnConflictError";
		this.queueItemId = queueItemId;
	}
}

export class QueuedTurnNotFoundError extends Error {
	readonly code = "NOT_FOUND";
	readonly queueItemId: string;
	constructor(queueItemId: string) {
		super(`Queued turn not found: ${queueItemId}`);
		this.name = "QueuedTurnNotFoundError";
		this.queueItemId = queueItemId;
	}
}

export class QueuedTurnLimitError extends Error {
	readonly code = "OVERLOADED";
	constructor() {
		super(`A session can queue at most ${MAX_QUEUED_TURNS} turns`);
		this.name = "QueuedTurnLimitError";
	}
}

type PauseReason = "delivery_failed" | "turn_interrupted" | "server_restarted";

export class QueuedTurnQueue {
	private readonly sessionManager: SessionManager;
	private journalSnapshot?: ReturnType<SessionManager["getDurableJournalSnapshot"]>;
	private journalProjection?: ReturnType<typeof reduceRuntimeJournal>;
	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
	}

	private reduced(): ReturnType<typeof reduceRuntimeJournal> {
		const snapshot = this.sessionManager.getDurableJournalSnapshot();
		if (snapshot !== this.journalSnapshot) {
			this.journalSnapshot = snapshot;
			this.journalProjection = reduceRuntimeJournal(snapshot);
		}
		return this.journalProjection!;
	}

	list(): readonly QueuedTurnDraft[] {
		return structuredClone(
			this.reduced().queues.flatMap((item) => {
				if (item.queue !== "next_turn" || !item.requestId) return [];
				const state =
					item.state === "enqueued"
						? "queued"
						: item.state === "paused"
							? "paused"
							: item.state === "dispatching"
								? "sending"
								: undefined;
				return state
					? [
							{
								queueItemId: item.queueItemId,
								operationId: item.operationId,
								requestId: item.requestId,
								...(item.deliveryRequestId === undefined ? {} : { deliveryRequestId: item.deliveryRequestId }),
								revision: item.revision,
								input: item.input,
								state,
								...(item.reason === undefined ? {} : { reason: item.reason }),
							},
						]
					: [];
			}),
		);
	}

	firstQueued(): QueuedTurnDraft | undefined {
		const [head] = this.list();
		return head?.state === "queued" ? head : undefined;
	}

	enqueue(input: { requestId: string; input: DurablePromptInput; state: "enqueued" | "paused" }): QueuedTurnDraft {
		const identity = identifyRuntimeRequest("turn/queue", input.requestId, input.input);
		const reduced = this.reduced();
		const existing = reduced.queues.find((item) => item.queue === "next_turn" && item.requestId === input.requestId);
		if (existing) {
			if (existing.enqueueHash !== identity.requestHash) throw new RequestIdReusedError(input.requestId);
			const visible = this.list().find((item) => item.queueItemId === existing.queueItemId);
			if (!visible) throw new QueuedTurnConflictError(existing.queueItemId);
			return visible;
		}
		if (this.list().length >= MAX_QUEUED_TURNS) throw new QueuedTurnLimitError();

		this.sessionManager.appendRuntimeControl({
			type: "runtime_queue",
			operationId: identity.operationId,
			queueItemId: identity.queueItemId,
			queue: "next_turn",
			state: input.state,
			input: input.input,
			requestId: input.requestId,
			enqueueHash: identity.requestHash,
		});
		return this.requireVisible(identity.queueItemId);
	}

	update(input: { queueItemId: string; expectedRevision: string; text: string }): QueuedTurnDraft {
		const current = this.requireRevision(input.queueItemId, input.expectedRevision);
		if (current.state === "sending") throw new QueuedTurnConflictError(input.queueItemId);
		const { attachments, fileSelections, conversationQuotes } = splitSessionAttachmentPrompt(current.input.text);
		if (!input.text.trim() && attachments.length === 0) throw new TypeError("Queued turn text must not be empty");
		const nextInput = {
			...current.input,
			text: formatSessionAttachments(
				formatSessionFileSelections(
					formatSessionConversationQuotes(input.text, conversationQuotes ?? []),
					fileSelections,
				),
				attachments,
			),
		};
		this.appendState(current, current.state === "queued" ? "enqueued" : "paused", nextInput);
		return this.requireVisible(input.queueItemId);
	}

	delete(input: { queueItemId: string; expectedRevision: string }): void {
		const current = this.requireRevision(input.queueItemId, input.expectedRevision);
		if (current.state === "sending") throw new QueuedTurnConflictError(input.queueItemId);
		this.appendState(current, "cancelled");
	}

	markDispatching(input: {
		queueItemId: string;
		expectedRevision: string;
		delivery: "steer" | "start";
		deliveryRequestId?: string;
	}): QueuedTurnDraft {
		const current = this.requireRevision(input.queueItemId, input.expectedRevision);
		if (current.state === "sending") throw new QueuedTurnConflictError(input.queueItemId);
		if (input.delivery === "start" && this.list()[0]?.queueItemId !== input.queueItemId) {
			throw new QueuedTurnConflictError(input.queueItemId);
		}
		const deliveryRequestId = input.deliveryRequestId ?? randomUUID();
		const operationId = identifyRuntimeRequest("turn/queue", deliveryRequestId, current.input).operationId;
		this.appendState(current, "dispatching", undefined, undefined, { operationId, deliveryRequestId });
		return this.requireVisible(input.queueItemId);
	}

	pause(queueItemId: string, reason: PauseReason): QueuedTurnDraft {
		const current = this.requireVisible(queueItemId);
		if (current.state === "paused") return current;
		this.appendState(current, "paused", undefined, reason);
		return this.requireVisible(queueItemId);
	}

	pauseUndispatched(
		reason: Extract<PauseReason, "turn_interrupted" | "server_restarted">,
	): readonly QueuedTurnDraft[] {
		for (const item of this.list()) {
			if (item.state !== "paused") this.pause(item.queueItemId, reason);
		}
		return this.list();
	}

	private requireVisible(queueItemId: string): QueuedTurnDraft {
		const item = this.list().find((candidate) => candidate.queueItemId === queueItemId);
		if (!item) throw new QueuedTurnNotFoundError(queueItemId);
		return item;
	}

	private requireRevision(queueItemId: string, expectedRevision: string): QueuedTurnDraft {
		const item = this.requireVisible(queueItemId);
		if (item.revision !== expectedRevision) throw new QueuedTurnConflictError(queueItemId);
		return item;
	}

	private appendState(
		current: QueuedTurnDraft,
		state: "enqueued" | "paused" | "dispatching" | "cancelled",
		input?: DurablePromptInput,
		reason?: PauseReason,
		delivery?: { readonly operationId: string; readonly deliveryRequestId: string },
	): void {
		const reduced = this.reduced().queues.find((item) => item.queueItemId === current.queueItemId);
		if (!reduced?.enqueueHash) throw new QueuedTurnNotFoundError(current.queueItemId);
		const operationId = delivery?.operationId ?? current.operationId;
		const deliveryRequestId = delivery?.deliveryRequestId ?? reduced.deliveryRequestId;
		this.sessionManager.appendRuntimeControl({
			type: "runtime_queue",
			operationId,
			queueItemId: current.queueItemId,
			queue: "next_turn",
			state,
			...(input === undefined ? {} : { input }),
			requestId: current.requestId,
			enqueueHash: reduced.enqueueHash,
			...(deliveryRequestId === undefined ? {} : { deliveryRequestId }),
			...(reason === undefined ? {} : { reason }),
		});
	}
}
