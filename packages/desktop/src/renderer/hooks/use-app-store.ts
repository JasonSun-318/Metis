import { useSyncExternalStore } from "react";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";

export function useAppStore(store: AppStore): AppStoreSnapshot {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
