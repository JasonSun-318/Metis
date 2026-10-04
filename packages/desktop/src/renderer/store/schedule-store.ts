import type { ConnectionEventsParams, ScheduleSnapshotView, ScheduleTaskView } from "@metis/app-protocol";

export interface ScheduleStoreSnapshot {
	readonly version: number;
	readonly tasksById: ReadonlyMap<string, ScheduleTaskView>;
	readonly taskOrder: readonly string[];
	readonly unreadCount: number;
	readonly serverEpoch: string | null;
	readonly cursor: number;
	readonly syncStatus: "empty" | "ready" | "resnapshot_required";
}

export class ScheduleStore {
	private readonly listeners = new Set<() => void>();
	private readonly tasks = new Map<string, ScheduleTaskView>();
	private order: string[] = [];
	private unreadCount = 0;
	private serverEpoch: string | null = null;
	private cursor = 0;
	private syncStatus: ScheduleStoreSnapshot["syncStatus"] = "empty";
	private version = 0;
	private snapshot = this.createSnapshot();

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): ScheduleStoreSnapshot => this.snapshot;

	applySnapshot(snapshot: ScheduleSnapshotView): void {
		this.tasks.clear();
		for (const task of snapshot.tasks) this.tasks.set(task.id, task);
		this.order = snapshot.tasks.map(({ id }) => id);
		this.unreadCount = snapshot.unreadCount;
		this.serverEpoch = snapshot.serverEpoch;
		this.cursor = snapshot.cursor;
		this.syncStatus = "ready";
		this.commit();
	}

	applyBatch(batch: ConnectionEventsParams): void {
		if (this.syncStatus !== "ready") return;
		if (batch.serverEpoch !== this.serverEpoch || batch.fromCursor !== this.cursor + 1) {
			this.syncStatus = "resnapshot_required";
			this.commit();
			return;
		}
		let changed = false;
		for (const event of batch.events) {
			if (event.type === "schedule/updated" || event.type === "schedule/runUpdated") {
				if (!this.tasks.has(event.task.id)) this.order = [event.task.id, ...this.order];
				this.tasks.set(event.task.id, event.task);
				changed = true;
			} else if (event.type === "schedule/deleted") {
				if (this.tasks.delete(event.taskId)) {
					this.order = this.order.filter((id) => id !== event.taskId);
					changed = true;
				}
			} else if (event.type === "schedule/refreshed") {
				this.syncStatus = "resnapshot_required";
				changed = true;
			}
		}
		this.cursor = batch.toCursor;
		this.unreadCount = [...this.tasks.values()].reduce((total, task) => total + task.unreadCount, 0);
		if (changed) this.commit();
	}

	upsertTask(task: ScheduleTaskView): void {
		if (!this.tasks.has(task.id)) this.order = [task.id, ...this.order];
		this.tasks.set(task.id, task);
		this.unreadCount = [...this.tasks.values()].reduce((total, item) => total + item.unreadCount, 0);
		this.commit();
	}

	removeTask(taskId: string): void {
		if (!this.tasks.delete(taskId)) return;
		this.order = this.order.filter((id) => id !== taskId);
		this.unreadCount = [...this.tasks.values()].reduce((total, task) => total + task.unreadCount, 0);
		this.commit();
	}

	markResnapshotRequired(): void {
		if (this.syncStatus === "resnapshot_required") return;
		this.syncStatus = "resnapshot_required";
		this.commit();
	}

	private commit(): void {
		this.version += 1;
		this.snapshot = this.createSnapshot();
		for (const listener of this.listeners) listener();
	}

	private createSnapshot(): ScheduleStoreSnapshot {
		return {
			version: this.version,
			tasksById: this.tasks,
			taskOrder: this.order,
			unreadCount: this.unreadCount,
			serverEpoch: this.serverEpoch,
			cursor: this.cursor,
			syncStatus: this.syncStatus,
		};
	}
}
