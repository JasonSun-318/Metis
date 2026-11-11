import type { AppStoreSnapshot } from "./store/app-store.ts";

/**
 * Fingerprint of the session summaries the shell renders from `sessionsById`.
 * The store mutates that Map in place, so a selector that compares it by
 * reference would keep rendering stale mode/cwd/title values.
 */
export function selectSessionIndexKey(sessionsById: AppStoreSnapshot["sessionsById"]): string {
	let key = "";
	for (const session of sessionsById.values()) {
		key += `${session.sessionId}\0${session.mode}\0${session.cwd ?? ""}\0${session.name ?? ""}\0${session.state}\0${session.updatedAt}\0${session.attentionRequired ? 1 : 0}\0${session.scheduled?.runId ?? ""}\0${session.archived ? 1 : 0}\0${session.unread ? 1 : 0}\0`;
	}
	return key;
}
