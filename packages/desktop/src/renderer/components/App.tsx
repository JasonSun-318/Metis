import type { InteractionResponseInput } from "@arcmind/app-protocol";
import { FolderSimple } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArcMindDesktopApi } from "../../shared/desktop-api.ts";
import { useAppStore } from "../hooks/use-app-store.ts";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";
import { Composer } from "./Composer.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { RecoveryBanner } from "./RecoveryBanner.tsx";
import { SessionSidebar } from "./SessionSidebar.tsx";
import { Transcript } from "./Transcript.tsx";

interface AppProps {
	readonly api: ArcMindDesktopApi;
	readonly store: AppStore;
}

const ACTIVE_SESSION_KEY = "arcmind.activeSessionId";

export function shouldResnapshotAfterReady(
	before: AppStoreSnapshot,
	next: Awaited<ReturnType<ArcMindDesktopApi["getServerState"]>>,
): boolean {
	return (
		next.state === "ready" &&
		before.activeSessionId !== null &&
		(before.supervisor.state !== "ready" || before.serverEpoch !== next.serverEpoch)
	);
}

export function App({ api, store }: AppProps) {
	const state = useAppStore(store);
	const [busy, setBusy] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [message, setMessage] = useState("Starting ArcMind…");
	const [error, setError] = useState<string | null>(null);
	const openGeneration = useRef(0);
	const openingSessionId = useRef<string | null>(null);
	const resnapshot = useRef<Promise<void> | null>(null);

	const reportError = useCallback((cause: unknown) => {
		setError(cause instanceof Error ? cause.message : "ArcMind could not complete the request.");
	}, []);

	const openSession = useCallback(
		async (sessionId: string) => {
			const generation = ++openGeneration.current;
			openingSessionId.current = sessionId;
			setBusy(true);
			setError(null);
			store.markResubscribing();
			try {
				const snapshot = await api.openSession({ sessionId });
				if (generation !== openGeneration.current) return;
				store.applySnapshot(snapshot);
				localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
				setMessage("Session ready");
			} catch (cause) {
				if (generation === openGeneration.current) {
					if (localStorage.getItem(ACTIVE_SESSION_KEY) === sessionId) localStorage.removeItem(ACTIVE_SESSION_KEY);
					reportError(cause);
				}
			} finally {
				if (generation === openGeneration.current) {
					openingSessionId.current = null;
					setBusy(false);
				}
			}
		},
		[api, reportError, store],
	);

	const requestResnapshot = useCallback(
		(sessionId: string) => {
			if (!resnapshot.current) {
				resnapshot.current = openSession(sessionId).finally(() => {
					resnapshot.current = null;
				});
			}
			return resnapshot.current;
		},
		[openSession],
	);

	useEffect(() => {
		let active = true;
		const unsubscribe = api.subscribe((event) => {
			if (!active) return;
			if (event.type === "interaction-cancelled") {
				store.removeInteraction(event.interactionId);
				return;
			}
			if (event.type === "supervisor") {
				const before = store.getSnapshot();
				store.setSupervisor(event.view);
				if (shouldResnapshotAfterReady(before, event.view)) {
					void requestResnapshot(before.activeSessionId!);
				}
				return;
			}
			const envelope = event.envelope;
			if ("id" in envelope) {
				store.addInteraction(envelope.params.interaction);
				return;
			}
			if (store.applyBatch(envelope.params) === "resnapshot_required") {
				if (openingSessionId.current) return;
				const sessionId = store.getSnapshot().activeSessionId;
				if (sessionId) void requestResnapshot(sessionId);
			}
		});

		void (async () => {
			try {
				store.setSupervisor(await api.getServerState());
				const sessions = await api.listSessions({ limit: 200 });
				if (!active) return;
				store.setSessions(sessions);
				const rememberedSessionId = localStorage.getItem(ACTIVE_SESSION_KEY);
				if (rememberedSessionId && sessions.sessions.some((session) => session.sessionId === rememberedSessionId)) {
					await openSession(rememberedSessionId);
				} else {
					setMessage(
						sessions.sessions.length > 0 ? "Choose a session or start a new one" : "Choose a project folder to begin",
					);
				}
			} catch (cause) {
				if (active) reportError(cause);
			}
		})();

		return () => {
			active = false;
			openGeneration.current += 1;
			unsubscribe();
		};
	}, [api, openSession, reportError, requestResnapshot, store]);

	const createSession = async (cwd: string) => {
		setBusy(true);
		setError(null);
		try {
			const created = await api.createSession({ requestId: crypto.randomUUID(), cwd });
			store.setSessions(await api.listSessions({ limit: 200 }));
			await openSession(created.session.sessionId);
		} catch (cause) {
			reportError(cause);
			throw cause;
		} finally {
			setBusy(false);
		}
	};

	const activeSession = state.activeSessionId ? state.sessionsById.get(state.activeSessionId) : undefined;
	const running = activeSession?.state === "running" || state.activeTurnId !== null;
	const serverReady = state.supervisor.state === "ready";
	const interactionId = state.interactionOrder[0];
	const interaction = interactionId ? state.interactionsById.get(interactionId) : undefined;
	const latestNotification = state.notifications.at(-1);

	const submit = async (text: string) => {
		if (!state.activeSessionId) return;
		setError(null);
		try {
			if (running) {
				await api.steerTurn({
					sessionId: state.activeSessionId,
					requestId: crypto.randomUUID(),
					text,
					delivery: "steer",
				});
			} else {
				await api.startTurn({ sessionId: state.activeSessionId, requestId: crypto.randomUUID(), text });
			}
		} catch (cause) {
			reportError(cause);
			throw cause;
		}
	};

	const interrupt = async () => {
		if (!state.activeSessionId) return;
		try {
			await api.interruptTurn({ sessionId: state.activeSessionId, requestId: crypto.randomUUID() });
		} catch (cause) {
			reportError(cause);
		}
	};

	const loadOlder = async () => {
		if (!state.activeSessionId || !state.nextBeforeItemId || loadingOlder) return;
		setLoadingOlder(true);
		try {
			store.prependItems(
				await api.readItems({
					sessionId: state.activeSessionId,
					beforeItemId: state.nextBeforeItemId,
					limit: 200,
				}),
			);
		} catch (cause) {
			reportError(cause);
		} finally {
			setLoadingOlder(false);
		}
	};

	const respond = async (response: InteractionResponseInput) => {
		await api.respondToInteraction(response);
		store.removeInteraction(response.interactionId);
	};

	return (
		<div className="app-shell">
			<SessionSidebar busy={busy || !serverReady} onCreate={createSession} onOpen={openSession} state={state} />
			<main className="workspace">
				<header className="workspace-header">
					<div className="workspace-title">
						<FolderSimple aria-hidden="true" size={19} />
						<h1>{activeSession?.name || activeSession?.cwd || "ArcMind"}</h1>
					</div>
					<div className={`server-pill server-${state.supervisor.state}`}>{state.supervisor.state}</div>
				</header>
				{state.supervisor.state === "failed" && (
					<div className="server-banner" role="alert">
						<span>{state.supervisor.failure || "App Server could not recover."}</span>
						<button onClick={() => void api.retryServer().catch(reportError)} type="button">Retry</button>
					</div>
				)}
				{state.supervisor.state === "restarting" && (
					<div className="server-banner" role="status">App Server is recovering. Your saved session is safe.</div>
				)}
				{activeSession ? (
					<>
						<RecoveryBanner session={activeSession} />
						<Transcript
							hasOlder={state.nextBeforeItemId !== null}
							itemIds={state.itemOrder}
							itemsById={state.itemsById}
							loadingOlder={loadingOlder}
							onLoadOlder={loadOlder}
						/>
						<Composer disabled={!serverReady || state.syncStatus !== "ready"} onInterrupt={interrupt} onSubmit={submit} running={running} />
					</>
				) : (
					<section className="welcome-panel">
						<p className="eyebrow">ArcMind Desktop</p>
						<h2>Start a new task.</h2>
						<p>Choose a project folder from the sidebar. Your tasks stay recoverable even when this window reloads.</p>
					</section>
				)}
				<div className="sr-only" aria-live="polite">{error || latestNotification?.message || message}</div>
				{error && <div className="toast toast-error" role="alert">{error}</div>}
				{latestNotification && !error && <div className="toast" role="status">{latestNotification.message}</div>}
			</main>
			<InteractionHost interaction={interaction} key={interactionId ?? "none"} onRespond={respond} />
		</div>
	);
}
