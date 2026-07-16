import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: Array<{
		resolve: (value: IteratorResult<T>) => void;
		reject: (reason?: unknown) => void;
	}> = [];
	private done = false;
	private failed = false;
	private failure: unknown;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (reason?: unknown) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		void this.finalResultPromise.catch(() => {});
	}

	push(event: T): void {
		if (this.done) return;

		try {
			if (this.isComplete(event)) {
				const result = this.extractResult(event);
				this.done = true;
				this.resolveFinalResult(result);
			}
		} catch (error) {
			this.fail(error);
			return;
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/** Reject the result and any waiting iterator; already queued events remain readable first. */
	fail(error: unknown): void {
		if (this.done) return;
		this.done = true;
		this.failed = true;
		this.failure = error;
		this.rejectFinalResult(error);
		while (this.waiting.length > 0) {
			this.waiting.shift()!.reject(error);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.failed) {
				throw this.failure;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve, reject) =>
					this.waiting.push({ resolve, reject }),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
