export interface SubagentScheduleRequest {
	readonly key: string;
	readonly parentSessionId: string;
	readonly start: () => Promise<void>;
}

export interface SubagentSchedulerApi {
	enqueue(request: SubagentScheduleRequest): "running" | "queued";
	cancel(key: string): boolean;
	isQueued(key: string): boolean;
	readonly runningCount: number;
	readonly queuedCount: number;
}

export class SubagentScheduler implements SubagentSchedulerApi {
	private readonly queue: SubagentScheduleRequest[] = [];
	private readonly running = new Set<string>();
	private readonly keys = new Set<string>();
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
		return true;
	}

	isQueued(key: string): boolean {
		return this.queue.some((request) => request.key === key);
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
		void Promise.resolve()
			.then(request.start)
			.catch(() => undefined)
			.finally(() => this.release(request));
	}

	private release(request: SubagentScheduleRequest): void {
		if (!this.running.delete(request.key)) throw new Error(`Subagent schedule key is not running: ${request.key}`);
		this.keys.delete(request.key);
		const count = (this.parentCounts.get(request.parentSessionId) ?? 1) - 1;
		if (count === 0) this.parentCounts.delete(request.parentSessionId);
		else this.parentCounts.set(request.parentSessionId, count);
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
