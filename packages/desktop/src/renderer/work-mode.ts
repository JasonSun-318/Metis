/** The desktop-only UI lens: it never classifies sessions or reaches protocol data. */
export type WorkMode = "chat" | "code";
export const WORK_MODES: readonly WorkMode[] = ["chat", "code"];

export const WORK_MODE_KEY = "metis.work-mode.v1";
export const ACTIVE_CONVERSATION_KEY = "metis.active-conversation.v1";

export function isWorkMode(value: unknown): value is WorkMode {
	return value === "chat" || value === "code";
}

export function loadWorkMode(storage: Pick<Storage, "getItem">): WorkMode {
	try {
		const stored = storage.getItem(WORK_MODE_KEY);
		return isWorkMode(stored) ? stored : "chat";
	} catch {
		return "chat";
	}
}
