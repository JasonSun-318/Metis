import { useCallback, useRef, useSyncExternalStore } from "react";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";

const identitySnapshot = (snapshot: AppStoreSnapshot) => snapshot;

export function useAppStore(store: AppStore): AppStoreSnapshot;
export function useAppStore<Selected>(
	store: AppStore,
	selector: (snapshot: AppStoreSnapshot) => Selected,
	equal?: (left: Selected, right: Selected) => boolean,
): Selected;
export function useAppStore<Selected>(
	store: AppStore,
	selector: (snapshot: AppStoreSnapshot) => Selected = identitySnapshot as (snapshot: AppStoreSnapshot) => Selected,
	equal: (left: Selected, right: Selected) => boolean = Object.is,
): Selected {
	const cache = useRef<
		{ snapshot: AppStoreSnapshot; selector: (snapshot: AppStoreSnapshot) => Selected; selected: Selected } | undefined
	>(undefined);
	const getSelection = useCallback(() => {
		const snapshot = store.getSnapshot();
		if (cache.current?.snapshot === snapshot && cache.current.selector === selector) return cache.current.selected;
		const selected = selector(snapshot);
		if (cache.current && equal(cache.current.selected, selected)) {
			cache.current = { snapshot, selector, selected: cache.current.selected };
			return cache.current.selected;
		}
		cache.current = { snapshot, selector, selected };
		return selected;
	}, [equal, selector, store]);
	return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}
