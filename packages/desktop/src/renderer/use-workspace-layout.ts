import type { SessionSummary } from "@metis/app-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MetisDesktopApi } from "../shared/desktop-api.ts";
import type { AppStore } from "./store/app-store.ts";
import { loadWorkspaceLayout, saveWorkspaceLayout } from "./workspace-layout-storage.ts";
import { validateRestoredWorkspaceLayout } from "./workspace-layout-validation.ts";
import {
	activateTab,
	addTab,
	chatTab,
	defaultWorkspace,
	findChatTab,
	type SessionWorkspace,
} from "./workspace-tabs.ts";

type KnownSession = Pick<SessionSummary, "sessionId"> & Partial<Pick<SessionSummary, "archived">>;

export function seedWorkspaceLayout(sessionId: string | null): SessionWorkspace {
	return addTab(defaultWorkspace(), chatTab(sessionId));
}

/** Restore chrome silently while keeping App's current conversation and mode authoritative. */
export function reconcileWorkspaceChat(workspace: SessionWorkspace, sessionId: string | null): SessionWorkspace {
	const existing = findChatTab(workspace, sessionId);
	if (existing) return activateTab(workspace, existing.id);
	const pane = workspace.panes.find((candidate) => !candidate.placeholder) ?? workspace.panes[0]!;
	return addTab(workspace, chatTab(sessionId), pane.id);
}

export function useWorkspaceLayout({
	api,
	sessionsById,
	chatSessionId,
	store,
}: {
	readonly api: MetisDesktopApi;
	readonly sessionsById: ReadonlyMap<string, KnownSession>;
	readonly chatSessionId: string | null;
	readonly store: AppStore;
}) {
	const [initial] = useState(() => {
		const saved = loadWorkspaceLayout(localStorage, () => true);
		const immediate = saved?.panes.every((pane) =>
			pane.tabs.every(
				(tab) =>
					tab.kind === "chat" &&
					!tab.agentId &&
					tab.sessionId !== null &&
					sessionsById.has(tab.sessionId) &&
					!sessionsById.get(tab.sessionId)?.archived,
			),
		);
		return {
			pending: immediate ? null : saved,
			workspace:
				immediate && saved ? reconcileWorkspaceChat(saved, chatSessionId) : seedWorkspaceLayout(chatSessionId),
		};
	});
	const [workspace, setWorkspace] = useState(initial.workspace);
	const [resizing, setResizing] = useState(false);
	const generation = useRef(0);
	const pending = useRef(initial.pending !== null);
	const canSave = useRef(!pending.current);
	const currentSession = useRef(chatSessionId);
	currentSession.current = chatSessionId;
	const knownSessions = useRef(sessionsById);
	knownSessions.current = sessionsById;
	const cancelRestore = useCallback(() => {
		if (pending.current) {
			generation.current += 1;
			pending.current = false;
		}
	}, []);
	const markLayoutIntent = useCallback(() => {
		cancelRestore();
		canSave.current = true;
	}, [cancelRestore]);
	useEffect(() => {
		if (!initial.pending || !pending.current) return;
		let disposed = false;
		const ticket = generation.current;
		const isCurrent = () => !disposed && generation.current === ticket;
		void validateRestoredWorkspaceLayout(initial.pending, knownSessions.current, api, isCurrent).then((result) => {
			if (!isCurrent()) return;
			pending.current = false;
			canSave.current = result.complete;
			for (const session of result.discoveredSessions) store.upsertSession(session);
			setWorkspace((current) => ({
				...reconcileWorkspaceChat(result.workspace, currentSession.current),
				tools: current.tools,
			}));
		});
		return () => {
			disposed = true;
		};
	}, [api, initial.pending, store]);
	useEffect(() => {
		if (canSave.current && !resizing) saveWorkspaceLayout(localStorage, workspace);
	}, [resizing, workspace]);
	return { workspace, setWorkspace, cancelRestore, markLayoutIntent, setLayoutResizing: setResizing };
}
