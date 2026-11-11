import { restoreWorkspaceLayout } from "./workspace-layout-storage.ts";

/** The desktop-only UI lens: it never classifies sessions or reaches protocol data. */
export type WorkMode = "chat" | "code";
export const WORK_MODES: readonly WorkMode[] = ["chat", "code"];

export const WORK_MODE_KEY = "metis.work-mode.v1";
export const ACTIVE_CONVERSATION_KEY = "metis.active-conversation.v1";

export function isWorkMode(value: unknown): value is WorkMode {
	return value === "chat" || value === "code";
}

export function legacyActiveConversation(storage: Pick<Storage, "getItem">): string | null {
	const layout = restoreWorkspaceLayout(storage.getItem("metis.workspace-layout.v1"), () => true);
	const pane = layout?.panes.find((candidate) => candidate.id === layout.activePaneId);
	const tab = pane?.tabs.find((candidate) => candidate.id === pane.activeId);
	return tab?.kind === "chat" ? tab.sessionId : null;
}

export function loadWorkMode(storage: Pick<Storage, "getItem">): WorkMode {
	try {
		const stored = storage.getItem(WORK_MODE_KEY);
		if (isWorkMode(stored)) return stored;
		const active = legacyActiveConversation(storage);
		return active && active === storage.getItem("metis.activeSessionId.code") ? "code" : "chat";
	} catch {
		return "chat";
	}
}
