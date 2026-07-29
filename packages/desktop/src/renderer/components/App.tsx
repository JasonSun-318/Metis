import {
	type AgentMode,
	type ClientResult,
	type InteractionResponseInput,
	type InteractionView,
	RPC_ERROR_CODES,
	type SessionSummary,
	type SkillSummaryView,
} from "@arcmind/app-protocol";
import { CaretDown, ClipboardText, FolderSimple, Globe, PlusCircle, Robot, SidebarSimple, TerminalWindow } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArcMindDesktopApi } from "../../shared/desktop-api.ts";
import { useAppStore } from "../hooks/use-app-store.ts";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";
import {
	loadProjectPreferences,
	type ProjectPreferenceMap,
	removeProjectPreference,
	saveProjectPreferences,
	setProjectAlias,
	setProjectPinned,
} from "../store/project-preferences.ts";
import { Composer, type ComposerSubmission } from "./Composer.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import { NewTaskHome } from "./NewTaskHome.tsx";
import { RecoveryBanner } from "./RecoveryBanner.tsx";
import {
	type ProjectSessionGroup,
	type SidebarDestination,
	SessionSidebar,
} from "./SessionSidebar.tsx";
import { SkillsPanel } from "./SkillsPanel.tsx";
import { ThinkingSelector } from "./ThinkingSelector.tsx";
import { Transcript } from "./Transcript.tsx";

interface AppProps {
	readonly api: ArcMindDesktopApi;
	readonly store: AppStore;
}

interface NewTaskDraft {
	readonly mode: AgentMode;
	readonly folder: string | null;
	readonly sessionId: string | null;
}

function activeSessionKey(mode: AgentMode): string {
	return `arcmind.activeSessionId.${mode}`;
}

function projectKey(mode: AgentMode, cwd: string): string {
	return JSON.stringify([mode, cwd]);
}

function projectActionError(cause: unknown): Error {
	const code = typeof cause === "object" && cause !== null && "code" in cause ? Number(cause.code) : undefined;
	if (code === RPC_ERROR_CODES.BUSY) return new Error("The project changed or is busy. Load a fresh preview and retry.");
	if (code === RPC_ERROR_CODES.SESSION_IN_USE) return new Error("A project session is still in use. Close it and retry.");
	if (code === RPC_ERROR_CODES.SESSION_CORRUPT) return new Error("A project session is corrupt or ambiguous. Nothing was removed.");
	if (code === RPC_ERROR_CODES.SCHEDULE_STORE_CORRUPT) return new Error("Scheduled tasks could not be checked safely. Repair them before retrying.");
	if (code === RPC_ERROR_CODES.OPERATION_FAILED) return new Error("The project could not be moved to Trash. Nothing was permanently deleted.");
	return cause instanceof Error ? cause : new Error("The project operation could not be completed.");
}

export function titleFromPrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/gu, " ").trim();
	const characters = Array.from(normalized);
	return characters.length <= 48 ? normalized : `${characters.slice(0, 47).join("")}…`;
}

export function sessionDisplayTitle(session: Pick<SessionSummary, "cwd" | "cwdOrigin" | "name">): string {
	return session.name || (session.cwdOrigin === "managed" ? "Chat" : session.cwd) || "ArcMind";
}

function composerText(input: ComposerSubmission): string {
	return input.skill ? `/skill:${input.skill.name}${input.text ? ` ${input.text}` : ""}` : input.text;
}

function composerPayload(input: ComposerSubmission) {
	return {
		text: composerText(input),
		...(input.attachments.length > 0 ? { attachments: input.attachments.map(({ path, name }) => ({ path, name })) } : {}),
	};
}

function composerRequestKey(input: ComposerSubmission): string {
	return JSON.stringify({
		text: input.text,
		attachments: input.attachments.map(({ path, name }) => ({ path, name })),
		skill: input.skill?.name ?? null,
	});
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
	const [projectPreferences, setProjectPreferences] = useState(() => loadProjectPreferences(localStorage));
	const [busyProjectKeys, setBusyProjectKeys] = useState<ReadonlySet<string>>(new Set());
	const [newTaskDraft, setNewTaskDraft] = useState<NewTaskDraft | null>({
		mode: "chat",
		folder: null,
		sessionId: null,
	});
	const [sessionsSidebarOpen, setSessionsSidebarOpen] = useState(true);
	const [toolsSidebarOpen, setToolsSidebarOpen] = useState(false);
	const [bootstrapped, setBootstrapped] = useState(false);
	const [busy, setBusy] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [skills, setSkills] = useState<readonly SkillSummaryView[]>([]);
	const [message, setMessage] = useState("Starting ArcMind…");
	const [error, setError] = useState<string | null>(null);
	const openGeneration = useRef(0);
	const openingSessionId = useRef<string | null>(null);
	const resnapshots = useRef(new Map<string, Promise<void>>());
	const newTaskCreateRequest = useRef<{ key: string; requestId: string } | null>(null);
	const newTaskTurnRequest = useRef<{ key: string; requestId: string } | null>(null);
	const activeTurnRequest = useRef<{
		key: string;
		method: "start" | "steer";
		requestId: string;
	} | null>(null);
	const skillListGeneration = useRef(0);
	const projectCreateRequests = useRef(
		new Map<string, { requestId: string; promise?: Promise<void> }>(),
	);
	const projectDeleteRequests = useRef(new Map<string, { requestId: string; revision: string }>());

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
					if (active) setNewTaskDraft(null);
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

	const setProjectBusy = (key: string, value: boolean) => {
		setBusyProjectKeys((current) => {
			const next = new Set(current);
			if (value) next.add(key);
			else next.delete(key);
			return next;
		});
	};
	const updateProjectPreferences = (
		update: (value: ProjectPreferenceMap) => ProjectPreferenceMap,
	) => {
		setProjectPreferences((current) => {
			const next = update(current);
			try {
				saveProjectPreferences(localStorage, next);
			} catch (cause) {
				reportError(cause);
			}
			return next;
		});
	};
	const renameProject = (group: ProjectSessionGroup, alias: string) => {
		updateProjectPreferences((current) => setProjectAlias(current, group.mode, group.cwd, alias));
	};
	const pinProject = (group: ProjectSessionGroup, pinned: boolean) => {
		updateProjectPreferences((current) => setProjectPinned(current, group.mode, group.cwd, pinned));
	};
	const previewProjectDelete = async (group: ProjectSessionGroup) => {
		try {
			return await api.previewProjectDelete({ mode: group.mode, cwd: group.cwd });
		} catch (cause) {
			throw projectActionError(cause);
		}
	};
	const createEmptyProjectSession = async (group: ProjectSessionGroup): Promise<void> => {
		const key = projectKey(group.mode, group.cwd);
		const existing = projectCreateRequests.current.get(key);
		if (existing?.promise) return existing.promise;
		const requestId = existing?.requestId ?? crypto.randomUUID();
		const promise = (async () => {
			setProjectBusy(key, true);
			setError(null);
			try {
				const created = await api.createSession({ requestId, mode: group.mode, cwd: group.cwd });
				setMode(group.mode);
				setDestination("tasks");
				await openSession(created.session.sessionId);
				setNewTaskDraft(null);
				projectCreateRequests.current.delete(key);
				try {
					await refreshSessions();
				} catch (cause) {
					reportError(cause);
				}
			} catch (cause) {
				projectCreateRequests.current.set(key, { requestId });
				reportError(cause);
				throw cause;
			} finally {
				setProjectBusy(key, false);
			}
		})();
		projectCreateRequests.current.set(key, { requestId, promise });
		return promise;
	};
	const deleteProject = async (
		group: ProjectSessionGroup,
		preview: ClientResult<"project/deletePreview">,
	): Promise<void> => {
		const key = projectKey(group.mode, group.cwd);
		const previousRequest = projectDeleteRequests.current.get(key);
		const requestId = previousRequest?.revision === preview.revision
			? previousRequest.requestId
			: crypto.randomUUID();
		projectDeleteRequests.current.set(key, { requestId, revision: preview.revision });
		setProjectBusy(key, true);
		setError(null);
		try {
			await api.deleteProject({
				requestId,
				mode: group.mode,
				cwd: group.cwd,
				expectedRevision: preview.revision,
			});
			projectDeleteRequests.current.delete(key);
			const before = store.getSnapshot();
			const active = before.activeSessionId ? before.sessionsById.get(before.activeSessionId) : undefined;
			const removedActive = active?.mode === group.mode && active.cwd === group.cwd && active.scheduled === undefined;
			let clearRememberedSession = false;
			try {
				const rememberedId = localStorage.getItem(activeSessionKey(group.mode));
				const remembered = rememberedId ? before.sessionsById.get(rememberedId) : undefined;
				clearRememberedSession =
					remembered?.mode === group.mode &&
					remembered.cwd === group.cwd &&
					remembered.scheduled === undefined;
			} catch (cause) {
				reportError(cause);
			}
			if (removedActive) openGeneration.current += 1;
			store.removeModeProject(group.mode, group.cwd);
			if (clearRememberedSession) {
				try {
					localStorage.removeItem(activeSessionKey(group.mode));
				} catch (cause) {
					reportError(cause);
				}
			}
			updateProjectPreferences((current) => removeProjectPreference(current, group.mode, group.cwd));
			if (removedActive) {
				setMode(group.mode);
				setDestination("tasks");
				setNewTaskDraft({ mode: group.mode, folder: null, sessionId: null });
			}
			try {
				await refreshSessions();
			} catch (cause) {
				reportError(cause);
			}
		} catch (cause) {
			const error = projectActionError(cause);
			reportError(error);
			throw error;
		} finally {
			setProjectBusy(key, false);
		}
	};

	const openVisibleSession = async (sessionId: string) => {
		setDestination("tasks");
		try {
			await openSession(sessionId);
			setNewTaskDraft(null);
			newTaskCreateRequest.current = null;
			newTaskTurnRequest.current = null;
		} catch {
			// openSession already reports the error while preserving the current projection.
		}
	};

	const chooseNewTaskFolder = async () => {
		setBusy(true);
		setError(null);
		try {
			const folder = await api.selectProjectFolder();
			if (folder) {
				setNewTaskDraft((draft) => draft?.mode === mode ? { ...draft, folder } : draft);
			}
		} catch (cause) {
			reportError(cause);
		} finally {
			setBusy(false);
		}
	};

	const startNewTask = () => {
		setDestination("tasks");
		setError(null);
		setNewTaskDraft({ mode, folder: null, sessionId: null });
		newTaskCreateRequest.current = null;
		newTaskTurnRequest.current = null;
	};

	const changeMode = (nextMode: AgentMode) => {
		if (nextMode === mode) return;
		setMode(nextMode);
		setDestination("tasks");
		setError(null);
		const rememberedSessionId = localStorage.getItem(activeSessionKey(nextMode));
		const rememberedSession = rememberedSessionId ? state.sessionsById.get(rememberedSessionId) : undefined;
		if (!rememberedSession || rememberedSession.mode !== nextMode) {
			setNewTaskDraft({ mode: nextMode, folder: null, sessionId: null });
			newTaskCreateRequest.current = null;
			newTaskTurnRequest.current = null;
			return;
		}
		void openSession(rememberedSession.sessionId)
			.then(() => {
				setNewTaskDraft(null);
				newTaskCreateRequest.current = null;
				newTaskTurnRequest.current = null;
			})
			.catch(() => {
				setNewTaskDraft({ mode: nextMode, folder: null, sessionId: null });
				newTaskCreateRequest.current = null;
				newTaskTurnRequest.current = null;
			});
	};

	const visibleNewTaskDraft = destination === "tasks" && newTaskDraft?.mode === mode ? newTaskDraft : null;

	const submitNewTaskDraft = async (input: ComposerSubmission) => {
		if (!visibleNewTaskDraft || (visibleNewTaskDraft.mode === "code" && !visibleNewTaskDraft.folder)) return;
		setBusy(true);
		setError(null);
		try {
			let sessionId = visibleNewTaskDraft.sessionId;
			if (!sessionId) {
				const name = titleFromPrompt(input.text || input.skill?.name || input.attachments[0]?.name || (visibleNewTaskDraft.mode === "chat" ? "Chat" : "Code"));
				const createKey = JSON.stringify({ mode: visibleNewTaskDraft.mode, cwd: visibleNewTaskDraft.folder, name });
				const createRequest = newTaskCreateRequest.current?.key === createKey
					? newTaskCreateRequest.current
					: { key: createKey, requestId: crypto.randomUUID() };
				newTaskCreateRequest.current = createRequest;
				const created = await api.createSession({
					requestId: createRequest.requestId,
					mode: visibleNewTaskDraft.mode,
					...(visibleNewTaskDraft.folder ? { cwd: visibleNewTaskDraft.folder } : {}),
					name,
				});
				sessionId = created.session.sessionId;
				setNewTaskDraft((draft) => draft?.mode === visibleNewTaskDraft.mode ? { ...draft, sessionId } : draft);
				newTaskCreateRequest.current = null;
			}
			await refreshSessions();
			await openSession(sessionId);
			setBusy(true);
			const turnKey = JSON.stringify({ sessionId, input: composerRequestKey(input) });
			const turnRequest = newTaskTurnRequest.current?.key === turnKey
				? newTaskTurnRequest.current
				: { key: turnKey, requestId: crypto.randomUUID() };
			newTaskTurnRequest.current = turnRequest;
			await api.startTurn({ sessionId, requestId: turnRequest.requestId, ...composerPayload(input) });
			setNewTaskDraft(null);
			newTaskCreateRequest.current = null;
			newTaskTurnRequest.current = null;
		} catch (cause) {
			reportError(cause);
			throw cause;
		} finally {
			setBusy(false);
		}
	};

	const activeSession = state.activeSessionId ? state.sessionsById.get(state.activeSessionId) : undefined;
	const openingSession = openingSessionId.current ? state.sessionsById.get(openingSessionId.current) : undefined;
	const newTaskOpen = visibleNewTaskDraft !== null;
	const visibleActiveSession = destination === "tasks" && activeSession && (activeSession.mode === mode || openingSession?.mode === mode) && !newTaskOpen
		? activeSession
		: undefined;
	const running = visibleActiveSession?.state === "running" || (visibleActiveSession !== undefined && state.activeTurnId !== null);
	const serverReady = state.supervisor.state === "ready";
	const skillSessionId = visibleActiveSession?.sessionId ?? visibleNewTaskDraft?.sessionId;
	const shouldListSkills = destination === "tasks" && (newTaskOpen || visibleActiveSession !== undefined);
	useEffect(() => {
		const generation = ++skillListGeneration.current;
		if (!bootstrapped || !serverReady || !shouldListSkills) {
			setSkills([]);
			return;
		}
		setSkills([]);
		void api.listSkills(skillSessionId ? { sessionId: skillSessionId } : { cwd: visibleNewTaskDraft?.folder ?? null })
			.then((result) => {
				if (generation === skillListGeneration.current) setSkills(result.skills);
			})
			.catch((cause) => {
				if (generation !== skillListGeneration.current) return;
				setSkills([]);
				reportError(cause);
			});
		return () => {
			if (generation === skillListGeneration.current) skillListGeneration.current += 1;
		};
	}, [api, bootstrapped, reportError, serverReady, shouldListSkills, skillSessionId, visibleNewTaskDraft?.folder]);
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

	const submit = async (input: ComposerSubmission) => {
		if (!visibleActiveSession) return;
		setError(null);
		try {
			const key = JSON.stringify({ sessionId: visibleActiveSession.sessionId, input: composerRequestKey(input) });
			const request = activeTurnRequest.current?.key === key
				? activeTurnRequest.current
				: { key, method: running ? "steer" as const : "start" as const, requestId: crypto.randomUUID() };
			activeTurnRequest.current = request;
			if (request.method === "steer") {
				await api.steerTurn({ sessionId: visibleActiveSession.sessionId, requestId: request.requestId, ...composerPayload(input), delivery: "steer" });
			} else {
				await api.startTurn({ sessionId: visibleActiveSession.sessionId, requestId: request.requestId, ...composerPayload(input) });
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
			throw cause;
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

	const changeThinking = async (sessionId: string, selection: AppStoreSnapshot["thinkingSelection"]) => {
		store.setOptimisticThinkingSelection(selection);
		try {
			await api.setThinkingSelection({ sessionId, requestId: crypto.randomUUID(), selection });
		} catch (cause) {
			if (store.getSnapshot().activeSessionId === sessionId) await requestResnapshot(sessionId);
			reportError(cause);
		}
	};

	const changeModel = async (sessionId: string, model: AppStoreSnapshot["availableModels"][number]) => {
		setBusy(true);
		try {
			await api.setModel({
				sessionId,
				requestId: crypto.randomUUID(),
				provider: model.provider,
				modelId: model.modelId,
			});
		} catch (cause) {
			reportError(cause);
		} finally {
			setBusy(false);
		}
	};

	const configurationSession = visibleActiveSession ?? (
		newTaskOpen && activeSession?.mode === mode ? activeSession : undefined
	);
	const modelControl = configurationSession ? (
		<ModelSelector
			available={state.availableModels}
			disabled={busy || !serverReady}
			onChange={(model) => void changeModel(configurationSession.sessionId, model)}
			value={state.model}
		/>
	) : undefined;

	const thinkingControl = configurationSession ? (
		<ThinkingSelector
			actualThinkingLevel={state.actualThinkingLevel}
			available={state.availableThinkingSelections}
			disabled={busy || !serverReady}
			onChange={(selection) => void changeThinking(configurationSession.sessionId, selection)}
			value={state.thinkingSelection}
		/>
	) : undefined;
	const pickAttachmentFiles = async () => {
		try {
			return await api.selectAttachmentFiles();
		} catch (cause) {
			reportError(cause);
			return [];
		}
	};

	return (
		<div className={`app-shell${sessionsSidebarOpen ? "" : " sessions-sidebar-collapsed"}`}>
			{sessionsSidebarOpen && <SessionSidebar
				busy={!bootstrapped || busy || !serverReady}
				destination={destination}
				mode={mode}
				newTaskOpen={newTaskOpen}
				onCreateProjectSession={createEmptyProjectSession}
				onDeleteProject={deleteProject}
				onModeChange={changeMode}
				onNewTask={startNewTask}
				onOpen={openVisibleSession}
				onPinProject={pinProject}
				onPreviewProjectDelete={previewProjectDelete}
				onRenameProject={renameProject}
				onSkills={() => setDestination("skills")}
				onToggle={() => setSessionsSidebarOpen(false)}
				preferences={projectPreferences}
				projectBusy={(group) => busyProjectKeys.has(projectKey(group.mode, group.cwd))}
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
					<SkillsPanel api={api} preferences={projectPreferences} serverReady={serverReady} state={state} />
				) : newTaskOpen ? (
					<NewTaskHome
						busy={busy || !serverReady}
						folder={visibleNewTaskDraft.folder}
						folderLocked={visibleNewTaskDraft.sessionId !== null}
						mode={mode}
						modelControl={modelControl}
						onChooseFolder={chooseNewTaskFolder}
						onManageSkills={() => setDestination("skills")}
						onPickFiles={pickAttachmentFiles}
						onSubmit={submitNewTaskDraft}
						skills={skills}
						thinkingControl={thinkingControl}
					/>
				) : visibleActiveSession ? (
					<div className="workspace-body">
						<div className="conversation-column">
							<RecoveryBanner session={visibleActiveSession} />
								<Transcript appearance={visibleActiveSession.mode} hasOlder={state.nextBeforeItemId !== null} itemIds={state.itemOrder} itemsById={state.itemsById} loadingOlder={loadingOlder} onLoadOlder={loadOlder} />
							<Composer appearance={visibleActiveSession.mode} disabled={!serverReady || state.syncStatus !== "ready"} key={visibleActiveSession.sessionId} modelControl={modelControl} onInterrupt={interrupt} onManageSkills={() => setDestination("skills")} onPickFiles={pickAttachmentFiles} onSubmit={submit} running={running} skills={skills} thinkingControl={thinkingControl} placeholder="Write a message…" />
						</div>
					</div>
				) : null}
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
