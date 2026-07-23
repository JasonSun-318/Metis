import type { AgentMode, InteractionResponseInput, InteractionView, SessionSummary } from "@arcmind/app-protocol";
import { CaretDown, ClipboardText, FolderSimple, Globe, PlusCircle, Robot, SidebarSimple, TerminalWindow } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArcMindDesktopApi } from "../../shared/desktop-api.ts";
import { useAppStore } from "../hooks/use-app-store.ts";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";
import { ChatHome } from "./ChatHome.tsx";
import { Composer } from "./Composer.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { RecoveryBanner } from "./RecoveryBanner.tsx";
import { type SidebarDestination, SessionSidebar } from "./SessionSidebar.tsx";
import { ThinkingSelector } from "./ThinkingSelector.tsx";
import { Transcript } from "./Transcript.tsx";

interface AppProps {
	readonly api: ArcMindDesktopApi;
	readonly store: AppStore;
}

function activeSessionKey(mode: AgentMode): string {
	return `arcmind.activeSessionId.${mode}`;
}

export function titleFromPrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/gu, " ").trim();
	const characters = Array.from(normalized);
	return characters.length <= 48 ? normalized : `${characters.slice(0, 47).join("")}…`;
}

export function sessionDisplayTitle(session: Pick<SessionSummary, "cwd" | "cwdOrigin" | "name">): string {
	return session.name || (session.cwdOrigin === "managed" ? "Chat" : session.cwd) || "ArcMind";
}

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

export function firstInteractionForSession(
	interactionOrder: readonly string[],
	interactionsById: ReadonlyMap<string, InteractionView>,
	sessionId: string | undefined,
): InteractionView | undefined {
	if (!sessionId) return undefined;
	for (const interactionId of interactionOrder) {
		const interaction = interactionsById.get(interactionId);
		if (interaction?.sessionId === sessionId) return interaction;
	}
	return undefined;
}

export function App({ api, store }: AppProps) {
	const state = useAppStore(store);
	const [mode, setMode] = useState<AgentMode>("chat");
	const [destination, setDestination] = useState<SidebarDestination>("tasks");
	const [chatDraftOpen, setChatDraftOpen] = useState(true);
	const [chatDraftFolder, setChatDraftFolder] = useState<string | null>(null);
	const [chatDraftSessionId, setChatDraftSessionId] = useState<string | null>(null);
	const [sessionsSidebarOpen, setSessionsSidebarOpen] = useState(true);
	const [toolsSidebarOpen, setToolsSidebarOpen] = useState(false);
	const [bootstrapped, setBootstrapped] = useState(false);
	const [busy, setBusy] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [message, setMessage] = useState("Starting ArcMind…");
	const [error, setError] = useState<string | null>(null);
	const openGeneration = useRef(0);
	const openingSessionId = useRef<string | null>(null);
	const resnapshots = useRef(new Map<string, Promise<void>>());
	const chatDraftCreateRequest = useRef<{ key: string; requestId: string } | null>(null);
	const chatDraftTurnRequest = useRef<{ key: string; requestId: string } | null>(null);
	const activeTurnRequest = useRef<{
		key: string;
		method: "start" | "steer";
		requestId: string;
	} | null>(null);

	const reportError = useCallback((cause: unknown) => {
		setError(cause instanceof Error ? cause.message : "ArcMind could not complete the request.");
	}, []);

	const openSession = useCallback(
		async (sessionId: string) => {
			const projectionBeforeOpen = store.getSnapshot();
			const generation = ++openGeneration.current;
			openingSessionId.current = sessionId;
			setBusy(true);
			setError(null);
			store.markResubscribing();
			try {
				const snapshot = await api.openSession({ sessionId });
				if (generation !== openGeneration.current) return snapshot;
				store.applySnapshot(snapshot);
				localStorage.setItem(activeSessionKey(snapshot.session.mode), sessionId);
				setMessage("Session ready");
				return snapshot;
			} catch (cause) {
				if (generation === openGeneration.current) {
					store.restoreSyncStatusAfterFailedOpen(projectionBeforeOpen);
					const afterFailure = store.getSnapshot();
					if (afterFailure.syncStatus === "resnapshot_required" && projectionBeforeOpen.activeSessionId) {
						try {
							const recovered = await api.openSession({ sessionId: projectionBeforeOpen.activeSessionId });
							if (generation === openGeneration.current) store.applySnapshot(recovered);
						} catch {
							// Keep resnapshot_required so the next server or session event retries recovery.
						}
					}
					reportError(cause);
				}
				throw cause;
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
			const existing = resnapshots.current.get(sessionId);
			if (existing) return existing;
			const pending = openSession(sessionId)
				.then(() => undefined)
				.catch(() => undefined)
				.finally(() => {
					if (resnapshots.current.get(sessionId) === pending) resnapshots.current.delete(sessionId);
				});
			resnapshots.current.set(sessionId, pending);
			return pending;
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
				if (shouldResnapshotAfterReady(before, event.view)) void requestResnapshot(before.activeSessionId!);
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
				const rememberedSessionId = localStorage.getItem(activeSessionKey("chat"));
				if (rememberedSessionId && sessions.sessions.some((session) => session.mode === "chat" && session.sessionId === rememberedSessionId)) {
					await openSession(rememberedSessionId);
					if (active) setChatDraftOpen(false);
				} else {
					setMessage("Start a new Chat task");
				}
			} catch (cause) {
				if (active) reportError(cause);
			} finally {
				if (active) setBootstrapped(true);
			}
		})();

		return () => {
			active = false;
			openGeneration.current += 1;
			unsubscribe();
		};
	}, [api, openSession, reportError, requestResnapshot, store]);

	const refreshSessions = async () => {
		store.setSessions(await api.listSessions({ limit: 200 }));
	};

	const openVisibleSession = async (sessionId: string) => {
		setDestination("tasks");
		try {
			await openSession(sessionId);
			if (mode === "chat") setChatDraftOpen(false);
		} catch {
			// openSession already reports the error while preserving the current projection.
		}
	};

	const chooseChatFolder = async () => {
		setBusy(true);
		setError(null);
		try {
			const folder = await api.selectProjectFolder();
			if (folder) setChatDraftFolder(folder);
		} catch (cause) {
			reportError(cause);
		} finally {
			setBusy(false);
		}
	};

	const startNewTask = () => {
		setDestination("tasks");
		setError(null);
		if (mode === "chat") {
			setChatDraftFolder(null);
			setChatDraftSessionId(null);
			chatDraftCreateRequest.current = null;
			chatDraftTurnRequest.current = null;
			setChatDraftOpen(true);
			return;
		}
		void (async () => {
			setBusy(true);
			try {
				const cwd = await api.selectProjectFolder();
				if (!cwd) return;
				const created = await api.createSession({ requestId: crypto.randomUUID(), mode: "code", cwd });
				await refreshSessions();
				await openSession(created.session.sessionId);
			} catch (cause) {
				reportError(cause);
			} finally {
				setBusy(false);
			}
		})();
	};

	const changeMode = (nextMode: AgentMode) => {
		if (nextMode === mode) return;
		setMode(nextMode);
		setDestination("tasks");
		setError(null);
		const rememberedSessionId = localStorage.getItem(activeSessionKey(nextMode));
		const rememberedSession = rememberedSessionId ? state.sessionsById.get(rememberedSessionId) : undefined;
		if (!rememberedSession || rememberedSession.mode !== nextMode) {
			if (nextMode === "chat") setChatDraftOpen(true);
			return;
		}
		void openSession(rememberedSession.sessionId)
			.then(() => {
				if (nextMode === "chat") setChatDraftOpen(false);
			})
			.catch(() => undefined);
	};

	const submitChatDraft = async (text: string) => {
		setBusy(true);
		setError(null);
		try {
			let sessionId = chatDraftSessionId;
			if (!sessionId) {
				const name = titleFromPrompt(text);
				const createKey = JSON.stringify({ cwd: chatDraftFolder, name });
				const createRequest = chatDraftCreateRequest.current?.key === createKey
					? chatDraftCreateRequest.current
					: { key: createKey, requestId: crypto.randomUUID() };
				chatDraftCreateRequest.current = createRequest;
				const created = await api.createSession({
					requestId: createRequest.requestId,
					mode: "chat",
					...(chatDraftFolder ? { cwd: chatDraftFolder } : {}),
					name,
				});
				sessionId = created.session.sessionId;
				setChatDraftSessionId(sessionId);
				chatDraftCreateRequest.current = null;
			}
			await refreshSessions();
			await openSession(sessionId);
			setBusy(true);
			const turnKey = JSON.stringify({ sessionId, text });
			const turnRequest = chatDraftTurnRequest.current?.key === turnKey
				? chatDraftTurnRequest.current
				: { key: turnKey, requestId: crypto.randomUUID() };
			chatDraftTurnRequest.current = turnRequest;
			await api.startTurn({ sessionId, requestId: turnRequest.requestId, text });
			setChatDraftOpen(false);
			setChatDraftSessionId(null);
			chatDraftCreateRequest.current = null;
			chatDraftTurnRequest.current = null;
		} catch (cause) {
			reportError(cause);
			throw cause;
		} finally {
			setBusy(false);
		}
	};

	const activeSession = state.activeSessionId ? state.sessionsById.get(state.activeSessionId) : undefined;
	const openingSession = openingSessionId.current ? state.sessionsById.get(openingSessionId.current) : undefined;
	const visibleActiveSession = destination === "tasks" && activeSession && (activeSession.mode === mode || openingSession?.mode === mode) && !(mode === "chat" && chatDraftOpen)
		? activeSession
		: undefined;
	const running = visibleActiveSession?.state === "running" || (visibleActiveSession !== undefined && state.activeTurnId !== null);
	const serverReady = state.supervisor.state === "ready";
	const interactiveSessionId =
		destination === "tasks" && openingSession?.mode === mode
			? openingSession.sessionId
			: visibleActiveSession?.sessionId;
	const visibleInteraction = firstInteractionForSession(
		state.interactionOrder,
		state.interactionsById,
		interactiveSessionId,
	);
	const latestNotification = [...state.notifications]
		.reverse()
		.find((notification) => notification.sessionId === undefined || notification.sessionId === visibleActiveSession?.sessionId);

	const submit = async (text: string) => {
		if (!visibleActiveSession) return;
		setError(null);
		try {
			const key = JSON.stringify({ sessionId: visibleActiveSession.sessionId, text });
			const request = activeTurnRequest.current?.key === key
				? activeTurnRequest.current
				: { key, method: running ? "steer" as const : "start" as const, requestId: crypto.randomUUID() };
			activeTurnRequest.current = request;
			if (request.method === "steer") {
				await api.steerTurn({ sessionId: visibleActiveSession.sessionId, requestId: request.requestId, text, delivery: "steer" });
			} else {
				await api.startTurn({ sessionId: visibleActiveSession.sessionId, requestId: request.requestId, text });
			}
			activeTurnRequest.current = null;
		} catch (cause) {
			reportError(cause);
			throw cause;
		}
	};

	const interrupt = async () => {
		if (!visibleActiveSession) return;
		try {
			await api.interruptTurn({ sessionId: visibleActiveSession.sessionId, requestId: crypto.randomUUID() });
		} catch (cause) {
			reportError(cause);
		}
	};

	const loadOlder = async () => {
		if (!visibleActiveSession || !state.nextBeforeItemId || loadingOlder) return;
		setLoadingOlder(true);
		try {
			store.prependItems(await api.readItems({ sessionId: visibleActiveSession.sessionId, beforeItemId: state.nextBeforeItemId, limit: 200 }));
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

	const changeThinking = async (selection: AppStoreSnapshot["thinkingSelection"]) => {
		if (!visibleActiveSession) return;
		setBusy(true);
		try {
			await api.setThinkingSelection({ sessionId: visibleActiveSession.sessionId, requestId: crypto.randomUUID(), selection });
		} catch (cause) {
			reportError(cause);
		} finally {
			setBusy(false);
		}
	};

	const thinkingControl = visibleActiveSession ? (
		<ThinkingSelector
			actualThinkingLevel={state.actualThinkingLevel}
			available={state.availableThinkingSelections}
			disabled={busy || !serverReady}
			model={state.model}
			onChange={(selection) => void changeThinking(selection)}
			value={state.thinkingSelection}
		/>
	) : undefined;

	return (
		<div className={`app-shell${sessionsSidebarOpen ? "" : " sessions-sidebar-collapsed"}`}>
			{sessionsSidebarOpen && <SessionSidebar
				busy={!bootstrapped || busy || !serverReady}
				destination={destination}
				mode={mode}
				onModeChange={changeMode}
				onNewTask={startNewTask}
				onOpen={openVisibleSession}
				onSkills={() => setDestination("skills")}
				onToggle={() => setSessionsSidebarOpen(false)}
				state={state}
			/>}
			<main className={`workspace${toolsSidebarOpen ? " tools-sidebar-open" : ""}`}>
				<div className="workspace-titlebar-actions">
					{!sessionsSidebarOpen && (
						<button aria-label="Show sessions sidebar" onClick={() => setSessionsSidebarOpen(true)} type="button">
							<SidebarSimple aria-hidden="true" size={17} />
						</button>
					)}
					<button
						aria-label={toolsSidebarOpen ? "Hide tools sidebar" : "Show tools sidebar"}
						aria-pressed={toolsSidebarOpen}
						className="details-sidebar-toggle"
						onClick={() => setToolsSidebarOpen((open) => !open)}
						type="button"
					>
						<SidebarSimple aria-hidden="true" size={17} />
					</button>
				</div>
				{visibleActiveSession && (
					<header className="workspace-header" data-active-session-id={visibleActiveSession.sessionId}>
						<div className="workspace-title">
							<h1>{sessionDisplayTitle(visibleActiveSession)}</h1>
							<CaretDown aria-hidden="true" size={13} />
						</div>
					</header>
				)}
				{state.supervisor.state === "failed" && (
					<div className="server-banner" role="alert">
						<span>{state.supervisor.failure || "App Server could not recover."}</span>
						<button onClick={() => void api.retryServer().catch(reportError)} type="button">Retry</button>
					</div>
				)}
				{state.supervisor.state === "restarting" && (
					<div className="server-banner" role="status">App Server is recovering. Your saved session is safe.</div>
				)}
				{!bootstrapped ? null : destination === "skills" ? (
					<section className="skills-panel">
						<p className="eyebrow">ArcMind Desktop</p>
						<h1>Skills</h1>
						<p>Skills are coming to Desktop.</p>
					</section>
				) : mode === "chat" && chatDraftOpen ? (
					<ChatHome
						busy={busy || !serverReady}
						folder={chatDraftFolder}
						folderLocked={chatDraftSessionId !== null}
						onChooseFolder={chooseChatFolder}
						onSubmit={submitChatDraft}
					/>
				) : visibleActiveSession ? (
					<div className="workspace-body">
						<div className="conversation-column">
							<RecoveryBanner session={visibleActiveSession} />
								<Transcript appearance={visibleActiveSession.mode} hasOlder={state.nextBeforeItemId !== null} itemIds={state.itemOrder} itemsById={state.itemsById} loadingOlder={loadingOlder} onLoadOlder={loadOlder} />
							<Composer appearance={visibleActiveSession.mode} disabled={!serverReady || state.syncStatus !== "ready"} onInterrupt={interrupt} onSubmit={submit} running={running} thinkingControl={thinkingControl} placeholder="Write a message…" />
						</div>
					</div>
				) : (
					<section className="welcome-panel">
						<p className="eyebrow">ArcMind Code</p>
						<h2>Start a new task.</h2>
						<p>Choose a project folder to begin. Your work stays recoverable when this window reloads.</p>
					</section>
				)}
				{toolsSidebarOpen && (
					<aside aria-label={`${mode === "chat" ? "Chat" : "Code"} tools`} className="tool-sidebar">
						<nav className="tool-sidebar-menu">
							{mode === "code" && <button type="button"><ClipboardText aria-hidden="true" size={14} /><span>审阅</span><kbd>⌃⇧G</kbd></button>}
							<button type="button"><TerminalWindow aria-hidden="true" size={14} /><span>终端</span></button>
							<button type="button"><Globe aria-hidden="true" size={14} /><span>浏览器</span><kbd>⌘T</kbd></button>
							{mode === "code" && <button type="button"><FolderSimple aria-hidden="true" size={14} /><span>文件</span><kbd>⌘P</kbd></button>}
							<button type="button"><PlusCircle aria-hidden="true" size={14} /><span>侧边任务</span><kbd>⌥⌘S</kbd></button>
							{mode === "code" && <button type="button"><Robot aria-hidden="true" size={14} /><span>Subagent</span></button>}
						</nav>
					</aside>
				)}
				<div className="sr-only" aria-live="polite">{error || latestNotification?.message || message}</div>
				{error && <div className="toast toast-error" role="alert">{error}</div>}
				{latestNotification && !error && <div className="toast" role="status">{latestNotification.message}</div>}
			</main>
			<InteractionHost interaction={visibleInteraction} key={visibleInteraction?.interactionId ?? "none"} onRespond={respond} />
		</div>
	);
}
