import type { AgentMode, SessionSummary } from "@metis/app-protocol";
import type { AppStoreSnapshot } from "./app-store.ts";

const SESSION_GROUPING_KEY = "metis.session-grouping.v1";
const DAY_MS = 86_400_000;

export type SessionGroupBy = "date" | "project" | "unread" | "none";
export type SessionGroupingPreferences = Readonly<Record<AgentMode, SessionGroupBy>>;

export interface SessionSection {
	readonly key: string;
	readonly label: string;
	readonly sessions: readonly SessionSummary[];
}

export const DEFAULT_SESSION_GROUPING: SessionGroupingPreferences = { chat: "date", code: "date" };

function isSessionGroupBy(value: unknown): value is SessionGroupBy {
	return value === "date" || value === "project" || value === "unread" || value === "none";
}

export function loadSessionGroupingPreferences(storage: Pick<Storage, "getItem">): SessionGroupingPreferences {
	try {
		const value = JSON.parse(storage.getItem(SESSION_GROUPING_KEY) ?? "null") as Record<string, unknown> | null;
		return {
			chat: isSessionGroupBy(value?.chat) ? value.chat : "date",
			code: isSessionGroupBy(value?.code) ? value.code : "date",
		};
	} catch {
		return DEFAULT_SESSION_GROUPING;
	}
}

export function saveSessionGroupingPreferences(
	storage: Pick<Storage, "setItem">,
	preferences: SessionGroupingPreferences,
): void {
	storage.setItem(SESSION_GROUPING_KEY, JSON.stringify(preferences));
}

export function sessionsForMode(
	state: Pick<AppStoreSnapshot, "sessionOrder" | "sessionsById">,
	mode: AgentMode,
): SessionSummary[] {
	return state.sessionOrder
		.map((sessionId) => state.sessionsById.get(sessionId))
		.filter((session): session is SessionSummary => session?.mode === mode)
		.sort(
			(left, right) =>
				right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId),
		);
}

function localDayOrdinal(date: Date): number {
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

export function groupSessionsByDate(
	sessions: readonly SessionSummary[],
	now = new Date(),
	locale: Intl.LocalesArgument = "en-US",
): SessionSection[] {
	const today = localDayOrdinal(now);
	const groups = new Map<number, { date: Date; sessions: SessionSummary[] }>();
	for (const session of sessions) {
		const date = new Date(session.updatedAt);
		const ordinal = localDayOrdinal(date);
		const group = groups.get(ordinal) ?? { date, sessions: [] };
		group.sessions.push(session);
		groups.set(ordinal, group);
	}
	return [...groups].map(([ordinal, group]) => ({
		key: `date:${ordinal}`,
		label:
			ordinal === today
				? "Today"
				: ordinal === today - 1
					? "Yesterday"
					: new Intl.DateTimeFormat(locale, {
							month: "short",
							day: "numeric",
							...(group.date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
						}).format(group.date),
		sessions: group.sessions,
	}));
}

export function groupSessionsByUnread(sessions: readonly SessionSummary[]): SessionSection[] {
	return [
		{ key: "unread", label: "Unread", sessions: sessions.filter((session) => session.unread) },
		{ key: "read", label: "Read", sessions: sessions.filter((session) => !session.unread) },
	].filter((section) => section.sessions.length > 0);
}
