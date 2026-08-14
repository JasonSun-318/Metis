import type { SessionSummary } from "@metis/app-protocol";

export interface CompletionNotification {
	readonly sessionId: string;
	readonly mode: SessionSummary["mode"];
	readonly outcome: "completed" | "failed";
	readonly name: string;
}

export function createBackgroundCompletionTracker(options: {
	readonly isActive: () => boolean;
	readonly setBadgeCount: (count: number) => void;
	readonly notify: (notification: CompletionNotification) => void;
}) {
	const sessions = new Map<
		string,
		{ readonly state: SessionSummary["state"]; readonly mode: SessionSummary["mode"]; readonly cwd: string | null }
	>();
	const completedAway = new Set<string>();
	const userInterrupts = new Set<string>();
	const forgetSession = (sessionId: string): void => {
		sessions.delete(sessionId);
		userInterrupts.delete(sessionId);
		if (!completedAway.delete(sessionId)) return;
		options.setBadgeCount(completedAway.size);
	};

	return {
		update(session: SessionSummary): void {
			const previous = sessions.get(session.sessionId)?.state;
			sessions.set(session.sessionId, { state: session.state, mode: session.mode, cwd: session.cwd });
			if (session.state === "running") return;
			const userInterrupted = userInterrupts.delete(session.sessionId);
			if (
				previous !== "running" ||
				userInterrupted ||
				!session.unread ||
				!session.lastTurnOutcome ||
				options.isActive() ||
				completedAway.has(session.sessionId)
			)
				return;
			completedAway.add(session.sessionId);
			options.setBadgeCount(completedAway.size);
			options.notify({
				sessionId: session.sessionId,
				mode: session.mode,
				outcome: session.lastTurnOutcome,
				name: session.name ?? "",
			});
		},
		setUserInterruptPending(sessionId: string, pending: boolean): void {
			if (pending) userInterrupts.add(sessionId);
			else userInterrupts.delete(sessionId);
		},
		forgetSession,
		forgetProject(mode: SessionSummary["mode"], cwd: string): void {
			for (const [sessionId, session] of sessions) {
				if (session.mode === mode && session.cwd === cwd) forgetSession(sessionId);
			}
		},
		view(sessionId: string): void {
			if (!completedAway.delete(sessionId)) return;
			options.setBadgeCount(completedAway.size);
		},
	};
}
