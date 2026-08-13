const STORAGE_KEY = "metis.sessionPins.v1";

export function loadSessionPins(storage: Pick<Storage, "getItem">): ReadonlySet<string> {
	try {
		const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return new Set();
		const record = value as Record<string, unknown>;
		if (
			Object.keys(record).length !== 2 ||
			record.version !== 1 ||
			!Array.isArray(record.sessionIds) ||
			record.sessionIds.some((id) => typeof id !== "string" || !id)
		)
			return new Set();
		return new Set(record.sessionIds as string[]);
	} catch {
		return new Set();
	}
}

export function saveSessionPins(storage: Pick<Storage, "setItem">, sessionIds: ReadonlySet<string>): void {
	storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: [...sessionIds].sort() }));
}

export function setSessionPinned(
	sessionIds: ReadonlySet<string>,
	sessionId: string,
	pinned: boolean,
): ReadonlySet<string> {
	const next = new Set(sessionIds);
	if (pinned) next.add(sessionId);
	else next.delete(sessionId);
	return next;
}
