import { useSyncExternalStore } from "react";
import type { ScheduleStore, ScheduleStoreSnapshot } from "../store/schedule-store.ts";

export function useScheduleStore(store: ScheduleStore): ScheduleStoreSnapshot {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
