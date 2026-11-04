import { useEffect, useState } from "react";

// Local app-server reads usually resolve in a few milliseconds. Settings
// pages remount on every navigation, so painting a placeholder immediately
// showed a gray block for a single frame on every switch. Only surface it
// once loading actually takes noticeable time.
const LOADING_PLACEHOLDER_DELAY_MS = 150;

export function useDelayedLoading(loading: boolean): boolean {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (!loading) {
			setVisible(false);
			return;
		}
		const timer = setTimeout(() => setVisible(true), LOADING_PLACEHOLDER_DELAY_MS);
		return () => clearTimeout(timer);
	}, [loading]);
	return visible;
}

// Settings pages keep their data while another page is open so revisiting
// one paints from the last view and refreshes in the background. The owner
// (the desktop API object) scopes the cache, which also keeps tests isolated.
const cachedViews = new WeakMap<object, Map<string, unknown>>();

export function cachedSettingsView<T>(owner: object, key: string): T | undefined {
	return cachedViews.get(owner)?.get(key) as T | undefined;
}

export function rememberSettingsView<T>(owner: object, key: string, view: T): void {
	let cache = cachedViews.get(owner);
	if (!cache) {
		cache = new Map();
		cachedViews.set(owner, cache);
	}
	cache.set(key, view);
}
