export interface SubagentScheduleRequest {
	readonly key: string;
	readonly parentSessionId: string;
	readonly start: () => Promise<void>;
}

export interface SubagentSchedulerApi {
	enqueue(request: SubagentScheduleRequest): "running" | "queued";
	cancel(key: string): boolean;
	isQueued(key: string): boolean;
	suspend(key: string): void;
	resume(key: string, signal?: AbortSignal): Promise<void>;
	readonly runningCount: number;
	readonly queuedCount: number;
}

export class SubagentScheduler implements SubagentSchedulerApi {
	private readonly queue: SubagentScheduleRequest[] = [];
	private readonly running = new Set<string>();
	private readonly keys = new Set<string>();
	private readonly requests = new Map<string, SubagentScheduleRequest>();
	private readonly suspended = new Set<string>();
	private readonly resumptions = new Map<
		string,
		{ promise: Promise<void>; resolve(): void; reject(error: unknown): void; dispose(): void }
	>();
	private readonly parentCounts = new Map<string, number>();
	private readonly globalLimit: number;
	private readonly parentLimit: number;

	constructor(globalLimit = 4, parentLimit = 4) {
		if (!Number.isInteger(globalLimit) || globalLimit < 1 || !Number.isInteger(parentLimit) || parentLimit < 1) {
			throw new TypeError("Subagent scheduler limits must be positive integers");
		}
		this.globalLimit = globalLimit;
		this.parentLimit = parentLimit;
	}

	get runningCount(): number {
		return this.running.size;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	enqueue(request: SubagentScheduleRequest): "running" | "queued" {
		if (!request.key || !request.parentSessionId) throw new TypeError("Subagent schedule keys must be non-empty");
		if (this.keys.has(request.key)) throw new Error(`Subagent schedule key already exists: ${request.key}`);
		this.keys.add(request.key);
		this.requests.set(request.key, request);
		if (this.canStart(request)) {
			this.start(request);
			return "running";
		}
		this.queue.push(request);
		return "queued";
	}

	cancel(key: string): boolean {
		const index = this.queue.findIndex((request) => request.key === key);
		if (index < 0) return false;
		this.queue.splice(index, 1);
		this.keys.delete(key);
		this.requests.delete(key);
		return true;
	}

	isQueued(key: string): boolean {
		return this.queue.some((request) => request.key === key);
	}

	suspend(key: string): void {
		if (this.suspended.has(key)) return;
		const request = this.requests.get(key);
		if (!request || !this.running.has(key)) throw new Error(`Subagent schedule key is not running: ${key}`);
		this.releaseSlot(request);
		this.suspended.add(key);
		this.drain();
	}

	resume(key: string, signal?: AbortSignal): Promise<void> {
		const existing = this.resumptions.get(key);
		if (existing) return existing.promise;
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
		if (this.running.has(key)) return Promise.resolve();
		const request = this.requests.get(key);
		if (!request || !this.suspended.has(key))
			return Promise.reject(new Error(`Subagent schedule key is not suspended: ${key}`));
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		const onAbort = () => {
			const index = this.queue.findIndex((item) => item.key === key);
			if (index >= 0) this.queue.splice(index, 1);
			this.resumptions.delete(key);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new Error("Aborted"));
		};
		this.resumptions.set(key, {
			promise,
			resolve,
			reject,
			dispose: () => signal?.removeEventListener("abort", onAbort),
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		this.queue.push(request);
		this.drain();
		return promise;
	}

	private canStart(request: SubagentScheduleRequest): boolean {
		return (
			this.running.size < this.globalLimit &&
			(this.parentCounts.get(request.parentSessionId) ?? 0) < this.parentLimit
		);
	}

	private start(request: SubagentScheduleRequest): void {
		this.running.add(request.key);
		this.parentCounts.set(request.parentSessionId, (this.parentCounts.get(request.parentSessionId) ?? 0) + 1);
		const resumption = this.resumptions.get(request.key);
		if (resumption) {
			this.resumptions.delete(request.key);
			this.suspended.delete(request.key);
			resumption.dispose();
			resumption.resolve();
			return;
		}
		void Promise.resolve()
			.then(request.start)
			.catch(() => undefined)
			.finally(() => this.release(request));
	}

	private releaseSlot(request: SubagentScheduleRequest): void {
		if (!this.running.delete(request.key)) return;
		const count = (this.parentCounts.get(request.parentSessionId) ?? 1) - 1;
		if (count === 0) this.parentCounts.delete(request.parentSessionId);
		else this.parentCounts.set(request.parentSessionId, count);
	}

	private release(request: SubagentScheduleRequest): void {
		this.releaseSlot(request);
		this.keys.delete(request.key);
		this.requests.delete(request.key);
		this.suspended.delete(request.key);
		const resumption = this.resumptions.get(request.key);
		if (resumption) {
			this.resumptions.delete(request.key);
			resumption.dispose();
			resumption.reject(new Error("Subagent task ended while waiting for execution capacity"));
		}
		const queued = this.queue.findIndex((item) => item.key === request.key);
		if (queued >= 0) this.queue.splice(queued, 1);
		this.drain();
	}

	private drain(): void {
		for (let index = 0; index < this.queue.length && this.running.size < this.globalLimit; ) {
			const request = this.queue[index];
			if (!this.canStart(request)) {
				index++;
				continue;
			}
			this.queue.splice(index, 1);
			this.start(request);
		}
	}
}

export const defaultSubagentScheduler = new SubagentScheduler(4, 4);
