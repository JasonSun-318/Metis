import type { AgentMode } from "@metis/app-protocol";
import { restoreWorkspaceLayout } from "./workspace-layout-storage.ts";

export const WORK_MODE_KEY = "metis.work-mode.v1";
export const ACTIVE_CONVERSATION_KEY = "metis.active-conversation.v1";

export function legacyActiveConversation(storage: Pick<Storage, "getItem">): string | null {
	const layout = restoreWorkspaceLayout(storage.getItem("metis.workspace-layout.v1"), () => true);
	const pane = layout?.panes.find((candidate) => candidate.id === layout.activePaneId);
	const tab = pane?.tabs.find((candidate) => candidate.id === pane.activeId);
	return tab?.kind === "chat" ? tab.sessionId : null;
}

export function loadWorkMode(storage: Pick<Storage, "getItem">): AgentMode {
	try {
		const stored = storage.getItem(WORK_MODE_KEY);
		if (stored === "chat" || stored === "code") return stored;
		const active = legacyActiveConversation(storage);
		return active && active === storage.getItem("metis.activeSessionId.code") ? "code" : "chat";
	} catch {
		return "chat";
	}
}
