import type {
	InteractionResponseInput,
	McpServerSummaryView,
	ModelOptionView,
	PermissionPresetView,
	PlanView,
	QueuedTurnView,
	SessionDeliveredFileView,
	SessionStatusView,
	SkillSummaryView,
	ThinkingSelectionView,
} from "@metis/app-protocol";
import { Lightbulb, XCircle } from "@phosphor-icons/react";
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection, MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { ConversationSubmission } from "../composer-submission.ts";
import { contextUsagePercent } from "../context-usage.ts";
import { GOAL_SLASH_USAGE, type GoalSlashCommand } from "../goal-slash.ts";
import { useConversationPlanFlow } from "../hooks/use-conversation-plan-flow.ts";
import { useSessionProjection } from "../hooks/use-session-projection.ts";
import { latestAssistantUsageKey, queuedTurnActionError } from "../session-view-utils.ts";
import type { AppStore } from "../store/app-store.ts";
import { emptyProjection } from "../store/reducer.ts";
import type { AskUserDraft } from "./AskUserPanel.tsx";
import { Composer, type ComposerPrefillRequest } from "./Composer.tsx";
import { GoalBar } from "./GoalBar.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import { PermissionSelector } from "./PermissionSelector.tsx";
import { QueuedTurnList } from "./QueuedTurnList.tsx";
import { SessionStatusPanel } from "./SessionStatusPanel.tsx";
import type { ComposerSlashCommand } from "./SlashCommandMenu.tsx";
import { ThinkingSelector } from "./ThinkingSelector.tsx";
import { Transcript } from "./Transcript.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";

const MCP_STATUS_POLL_MS = 500;
const MCP_RECONNECT_POLL_MS = 4_000;

const EMPTY_PROJECTION = emptyProjection();

export type SessionChatSubmit = (input: ConversationSubmission) => Promise<void>;

// Everything a chat pane needs that lives above the workspace. Callbacks take
// the pane's sessionId explicitly so one implementation serves every visible
// session, not just the projected one.
export interface SessionChatViewContext {
	readonly api: MetisDesktopApi;
	readonly bootstrapped: boolean;
	readonly composerFormRef: RefObject<HTMLFormElement | null>;
	// Every mounted view registers its own submit so the shared file-selection
	// provider can route "request change" actions to the owning session.
	readonly registerSubmit: (sessionId: string, submit: SessionChatSubmit) => void;
	readonly unregisterSubmit: (sessionId: string, submit: SessionChatSubmit) => void;
	readonly onChangeModel: (sessionId: string, model: ModelOptionView) => Promise<void>;
	readonly onChangePermissionPreset: (sessionId: string, preset: PermissionPresetView) => Promise<void>;
	readonly onChangeThinking: (sessionId: string, selection: ThinkingSelectionView) => Promise<void>;
	readonly onClearError: () => void;
	readonly onError: (cause: unknown) => void;
	readonly onFork: (sessionId: string, entryId: string) => void;
	readonly onManageMcp: () => void;
	readonly onManageSkills: () => void;
	readonly onNotice: (message: string | null) => void;
	readonly onOpenKnowledge: (sessionId: string) => void;
	readonly onOpenPlan: (sessionId: string, plan: PlanView) => void;
	readonly onPickFiles: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onPreviewDeliveredFile: (sessionId: string, file: SessionDeliveredFileView) => void;
	readonly onResolveDroppedFiles: (files: readonly File[]) => readonly DesktopAttachmentSelection[];
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
	readonly onSetupSandbox?: () => Promise<void>;
	readonly reducedMotion: boolean;
	readonly skillCatalogEpoch: number;
	readonly store: AppStore;
}

export interface SessionChatViewProps extends SessionChatViewContext {
	// The projected session's composer keeps the canonical "composer-input" id
	// and owns the shared form ref so the draft->session transition keeps
	// targeting it.
	readonly canonicalComposer: boolean;
	readonly focused: boolean;
	readonly sessionId: string;
	readonly visible: boolean;
}

export const SessionChatView = memo(function SessionChatView({
	api,
	bootstrapped,
	canonicalComposer,
	composerFormRef,
	focused,
	onChangeModel,
	onChangePermissionPreset,
	onChangeThinking,
	onClearError,
	onError,
	onFork,
	onManageMcp,
	onManageSkills,
	onNotice,
	onOpenKnowledge,
	onOpenPlan,
	onPickFiles,
	onPreviewDeliveredFile,
	onResolveDroppedFiles,
	onRespond,
	onSetupSandbox,
	reducedMotion,
	registerSubmit,
	sessionId,
	skillCatalogEpoch,
	store,
	unregisterSubmit,
	visible,
}: SessionChatViewProps) {
	const { t } = useTranslation();
	const chat = useSessionProjection(store, sessionId, focused);
	const session = chat.session;
	const bucket = chat.bucket;
	const projection = bucket ?? EMPTY_PROJECTION;
	const syncReady = bucket?.syncStatus === "ready";
	const serverReady = chat.serverReady;
	const composerInputId = canonicalComposer ? "composer-input" : `composer-input-${sessionId}`;
	const askUserDrafts = useRef(new Map<string, AskUserDraft>());
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [skills, setSkills] = useState<readonly SkillSummaryView[]>([]);
	const [mcpServers, setMcpServers] = useState<readonly McpServerSummaryView[]>([]);
	const [prefillRequest, setPrefillRequest] = useState<ComposerPrefillRequest>();
	const [composerControl, setComposerControl] = useState<{
		readonly id: number;
		readonly target: "model" | "thinking" | "mcp" | null;
	}>({ id: 0, target: null });
	const [sessionStatusPanel, setSessionStatusPanel] = useState<{
		readonly sessionId: string;
		readonly loading: boolean;
		readonly closing?: boolean;
		readonly status?: SessionStatusView;
		readonly error?: string;
	} | null>(null);
	const [contextStatus, setContextStatus] = useState<SessionStatusView | null>(null);
	const [compactingStartedAt, setCompactingStartedAt] = useState<string | null>(null);
	const statusGeneration = useRef(0);
	const contextStatusRef = useRef<SessionStatusView | null>(null);
	const mcpListGeneration = useRef(0);
	const skillListGeneration = useRef(0);
	const writableSessionId = session && session.scheduled === undefined ? sessionId : undefined;
	const running = session !== undefined && (session.state === "running" || projection.activeTurnId !== null);
	const inlineInteraction =
		chat.interaction?.kind === "ask_user" || chat.interaction?.kind === "session_permission_approval"
			? chat.interaction
			: undefined;
	// Modal kinds render from this pane while it is visible; sessions without a
	// visible chat pane are covered by the App-level host instead.
	const modalInteraction = inlineInteraction === undefined ? chat.interaction : undefined;
	const waitingForAnswer = chat.interaction?.kind === "ask_user";
	const compactBlocked = running || inlineInteraction !== undefined || compactingStartedAt !== null;

	const requestComposerControl = useCallback((target: "model" | "thinking" | "mcp" | null) => {
		setComposerControl((current) => ({ id: current.id + 1, target }));
	}, []);
	const closeSessionStatus = useCallback(() => {
		statusGeneration.current += 1;
		setSessionStatusPanel((current) => (current ? { ...current, closing: true } : null));
	}, []);
	useEffect(() => {
		if (!sessionStatusPanel?.closing) return undefined;
		const timer = setTimeout(
			() => setSessionStatusPanel((current) => (current?.closing ? null : current)),
			reducedMotion ? 0 : 160,
		);
		return () => clearTimeout(timer);
	}, [reducedMotion, sessionStatusPanel?.closing]);

	const {
		collaborationMode: collaborationModeValue,
		collaborationModeBlocked,
		collaborationModeChanging,
		currentProposedPlan,
		planActionsBusy,
		planRevisionTarget,
		submit,
		changeCollaborationMode,
		revisePlan,
		clearPlanRevision,
		startPlan,
		cancelPlan,
	} = useConversationPlanFlow({
		api,
		sessionId,
		writableSessionId,
		running,
		queuedTurnCount: projection.queuedTurns.length,
		serverReady,
		syncReady,
		compacting: compactingStartedAt !== null,
		interactionPending: inlineInteraction !== undefined,
		collaborationMode: projection.collaborationMode,
		itemOrder: projection.itemOrder,
		itemsById: projection.itemsById,
		clearError: onClearError,
		reportError: onError,
		composerInputId,
	});

	// The shared file-selection provider resolves "request change" actions to
	// the owning session's composer through this registry.
	useEffect(() => {
		registerSubmit(sessionId, submit);
		return () => unregisterSubmit(sessionId, submit);
	}, [registerSubmit, sessionId, submit, unregisterSubmit]);

	const deleteQueuedTurn = useCallback(
		async (turn: QueuedTurnView) => {
			if (!session) return;
			onClearError();
			try {
				await api.deleteQueuedTurn({
					sessionId,
					requestId: crypto.randomUUID(),
					queueItemId: turn.queueItemId,
					expectedRevision: turn.revision,
				});
			} catch (cause) {
				const error = queuedTurnActionError(cause);
				onError(error);
				throw error;
			}
		},
		[api, onClearError, onError, session, sessionId],
	);

	const editQueuedTurn = useCallback(
		async (turn: QueuedTurnView) => {
			await deleteQueuedTurn(turn);
			setPrefillRequest((current) => ({ id: (current?.id ?? 0) + 1, text: turn.text }));
			if (turn.attachments.length > 0) {
				onNotice("The message was returned to the composer. Add its attachments again before sending.");
			}
		},
		[deleteQueuedTurn, onNotice],
	);

	const sendQueuedTurn = useCallback(
		async (turn: QueuedTurnView, delivery: "steer" | "start") => {
			if (!session) return;
			onClearError();
			try {
				await api.sendQueuedTurn({
					sessionId,
					requestId: crypto.randomUUID(),
					queueItemId: turn.queueItemId,
					expectedRevision: turn.revision,
					delivery,
				});
			} catch (cause) {
				const error = queuedTurnActionError(cause);
				onError(error);
				throw error;
			}
		},
		[api, onClearError, onError, session, sessionId],
	);

	const interrupt = useCallback(async () => {
		if (!session) return;
		try {
			await api.interruptTurn({ sessionId, requestId: crypto.randomUUID() });
		} catch (cause) {
			onError(cause);
			throw cause;
		}
	}, [api, onError, session, sessionId]);

	const loadOlder = useCallback(async () => {
		if (!session || !projection.nextBeforeItemId || loadingOlder) return;
		setLoadingOlder(true);
		try {
			store.prependItems(
				sessionId,
				await api.readItems({ sessionId, beforeItemId: projection.nextBeforeItemId, limit: 200 }),
			);
		} catch (cause) {
			onError(cause);
		} finally {
			setLoadingOlder(false);
		}
	}, [api, loadingOlder, onError, projection.nextBeforeItemId, session, sessionId, store]);

	// Stable per-session callbacks keep memoized transcript turns from
	// re-rendering on unrelated projection changes.
	const forkItem = useCallback((entryId: string) => onFork(sessionId, entryId), [onFork, sessionId]);
	const copyText = useCallback((text: string) => void api.writeClipboardText({ text }).catch(onError), [api, onError]);
	const openDeliveredFile = useCallback(
		(fileId: string, action: "default" | "reveal") =>
			void api.openDeliveredFile({ sessionId, fileId, action }).catch(onError),
		[api, onError, sessionId],
	);
	const openPlan = useCallback((plan: PlanView) => onOpenPlan(sessionId, plan), [onOpenPlan, sessionId]);
	const previewDeliveredFile = useCallback(
		(file: SessionDeliveredFileView) => onPreviewDeliveredFile(sessionId, file),
		[onPreviewDeliveredFile, sessionId],
	);
	const cancelPlanAction = useCallback((plan: PlanView) => void cancelPlan(plan), [cancelPlan]);
	const startPlanAction = useCallback((plan: PlanView) => void startPlan(plan), [startPlan]);

	const assistantUsageKey = latestAssistantUsageKey(projection.itemOrder, projection.itemsById);
	const activeModelKey = projection.model ? `${projection.model.provider}/${projection.model.modelId}` : "";
	const mcpContextKey = mcpServers
		.map(
			(server) =>
				`${server.name}:${server.revision}:${server.effective}:${server.enabled}:${server.state}:${server.toolCount}`,
		)
		.sort()
		.join("|");

	const loadContextStatus = useCallback(
		async (options: { readonly showPanel?: boolean } = {}) => {
			const generation = ++statusGeneration.current;
			if (options.showPanel) {
				const cached = contextStatusRef.current;
				setSessionStatusPanel(
					cached?.sessionId === sessionId
						? { sessionId, loading: false, status: cached }
						: { sessionId, loading: true },
				);
			}
			try {
				const status = await api.getSessionStatus({ sessionId });
				if (generation !== statusGeneration.current) return;
				contextStatusRef.current = status;
				setContextStatus(status);
				setSessionStatusPanel((current) =>
					current?.sessionId === sessionId ? { sessionId, loading: false, status } : current,
				);
			} catch (cause) {
				if (generation !== statusGeneration.current) return;
				if (options.showPanel) {
					setSessionStatusPanel({
						sessionId,
						loading: false,
						error: cause instanceof Error ? cause.message : "Session status could not be loaded.",
					});
				} else {
					contextStatusRef.current = null;
					setContextStatus(null);
				}
			}
		},
		[api, sessionId],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies(skillCatalogEpoch): Skill catalog changes invalidate the context budget and skill list.
	// biome-ignore lint/correctness/useExhaustiveDependencies(mcpContextKey): MCP changes refresh the context budget with current tool definitions.
	// biome-ignore lint/correctness/useExhaustiveDependencies(assistantUsageKey): Completed requests refresh the context budget with actual token usage.
	// biome-ignore lint/correctness/useExhaustiveDependencies(activeModelKey): Changing models refreshes the server-computed context budget.
	useEffect(() => {
		if (!writableSessionId || !serverReady || !visible || compactingStartedAt !== null) return;
		void loadContextStatus();
	}, [
		activeModelKey,
		assistantUsageKey,
		compactingStartedAt,
		loadContextStatus,
		mcpContextKey,
		serverReady,
		skillCatalogEpoch,
		visible,
		writableSessionId,
	]);

	const { disabledSlashCommands, disabledSlashReasons } = useMemo(() => {
		const commands = new Set<ComposerSlashCommand>();
		const reasons: Partial<Record<ComposerSlashCommand, string>> = {};
		if (!writableSessionId) {
			commands.add("compact");
			commands.add("goal");
			commands.add("plan");
			commands.add("status");
			reasons.compact = "Open a task to use this command";
			reasons.goal = "Open a task to use this command";
			reasons.plan = "Open a task to use this command";
			reasons.status = "Open a task to use this command";
		} else if (compactBlocked) {
			commands.add("compact");
			reasons.compact =
				compactingStartedAt !== null
					? "Conversation compaction is already running"
					: "Stop the active task before compacting";
		}
		if (writableSessionId && (collaborationModeValue === "plan" || collaborationModeBlocked)) {
			commands.add("plan");
			reasons.plan = currentProposedPlan
				? "Start or cancel the current plan first"
				: collaborationModeValue === "plan"
					? "Plan mode is already active"
					: "Plan mode is unavailable while this task is busy";
		}
		if (!session) {
			commands.add("model");
			commands.add("thinking");
			reasons.model = "Open a task to use this command";
			reasons.thinking = "Open a task to use this command";
		}
		return { disabledSlashCommands: commands, disabledSlashReasons: reasons };
	}, [
		collaborationModeBlocked,
		collaborationModeValue,
		compactBlocked,
		compactingStartedAt,
		currentProposedPlan,
		session,
		writableSessionId,
	]);

	const openSessionStatus = useCallback(async () => {
		if (!writableSessionId) return;
		requestComposerControl(null);
		await loadContextStatus({ showPanel: true });
	}, [loadContextStatus, requestComposerControl, writableSessionId]);
	const toggleSessionStatus = useCallback(() => {
		if (!writableSessionId) return;
		if (sessionStatusPanel?.sessionId === writableSessionId && !sessionStatusPanel.closing) {
			closeSessionStatus();
			return;
		}
		void openSessionStatus();
	}, [closeSessionStatus, openSessionStatus, sessionStatusPanel, writableSessionId]);

	const compactConversation = useCallback(async () => {
		if (!writableSessionId || compactBlocked) return;
		closeSessionStatus();
		requestComposerControl(null);
		onClearError();
		onNotice(null);
		setCompactingStartedAt(new Date().toISOString());
		try {
			const result = await api.compactSession({ sessionId: writableSessionId, requestId: crypto.randomUUID() });
			if (result.message) onNotice(result.message);
		} catch (cause) {
			onError(cause);
		} finally {
			setCompactingStartedAt(null);
		}
	}, [
		api,
		closeSessionStatus,
		compactBlocked,
		onClearError,
		onError,
		onNotice,
		requestComposerControl,
		writableSessionId,
	]);

	const mutateSessionGoal = useCallback(
		async (input: { objective?: string; status?: "active" | "paused" } | { clear: true }) => {
			if (!writableSessionId) return;
			try {
				if ("clear" in input) {
					await api.clearSessionGoal({ sessionId: writableSessionId, requestId: crypto.randomUUID() });
					return;
				}
				await api.setSessionGoal({
					sessionId: writableSessionId,
					requestId: crypto.randomUUID(),
					...(input.objective === undefined ? {} : { objective: input.objective }),
					...(input.status === undefined ? {} : { status: input.status }),
				});
			} catch (cause) {
				onError(cause);
			}
		},
		[api, onError, writableSessionId],
	);

	const handleGoalCommand = useCallback(
		async (command: GoalSlashCommand) => {
			if (!writableSessionId) return;
			if (command.kind === "usage") {
				onNotice(GOAL_SLASH_USAGE);
				return;
			}
			if (command.kind === "clear") {
				await mutateSessionGoal({ clear: true });
				return;
			}
			if (command.kind === "pause") {
				await mutateSessionGoal({ status: "paused" });
				return;
			}
			if (command.kind === "resume") {
				await mutateSessionGoal({ status: "active" });
				return;
			}
			await mutateSessionGoal({ objective: command.objective });
		},
		[mutateSessionGoal, onNotice, writableSessionId],
	);

	const handleSlashCommand = useCallback(
		async (command: ComposerSlashCommand) => {
			if (command === "status") {
				await openSessionStatus();
				return;
			}
			closeSessionStatus();
			if (command === "compact") {
				await compactConversation();
				return;
			}
			if (command === "goal") {
				onNotice(GOAL_SLASH_USAGE);
				return;
			}
			if (command === "plan") {
				if (collaborationModeValue !== "plan") await changeCollaborationMode("plan");
				return;
			}
			requestComposerControl(command);
		},
		[
			changeCollaborationMode,
			closeSessionStatus,
			collaborationModeValue,
			compactConversation,
			onNotice,
			openSessionStatus,
			requestComposerControl,
		],
	);

	// Keep the session's skill and MCP catalogs fresh while the pane is shown.
	const hasSession = session !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies(skillCatalogEpoch): Skill catalog changes invalidate the context budget and skill list.
	useEffect(() => {
		const generation = ++skillListGeneration.current;
		if (!bootstrapped || !serverReady || !visible || !hasSession) {
			setSkills([]);
			return;
		}
		setSkills([]);
		void api
			.listSkills({ sessionId })
			.then((result) => {
				if (generation === skillListGeneration.current) setSkills(result.skills);
			})
			.catch((cause) => {
				if (generation !== skillListGeneration.current) return;
				setSkills([]);
				onError(cause);
			});
		return () => {
			if (generation === skillListGeneration.current) skillListGeneration.current += 1;
		};
	}, [api, bootstrapped, onError, serverReady, hasSession, sessionId, skillCatalogEpoch, visible]);

	useEffect(() => {
		const generation = ++mcpListGeneration.current;
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (!bootstrapped || !serverReady || !visible || !hasSession) {
			setMcpServers([]);
			return;
		}
		setMcpServers([]);
		const refresh = () => {
			void api.listMcpServers({ sessionId }).then(
				(result) => {
					if (generation !== mcpListGeneration.current) return;
					setMcpServers(result.servers);
					const connecting = result.servers.some(
						(server) => server.effective && server.enabled && server.state === "connecting",
					);
					const reconnecting = result.servers.some(
						(server) => server.effective && server.enabled && server.state === "reconnecting",
					);
					if (connecting || reconnecting)
						timer = setTimeout(refresh, connecting ? MCP_STATUS_POLL_MS : MCP_RECONNECT_POLL_MS);
				},
				(cause) => {
					if (generation !== mcpListGeneration.current) return;
					setMcpServers([]);
					onError(cause);
				},
			);
		};
		refresh();
		return () => {
			if (generation === mcpListGeneration.current) mcpListGeneration.current += 1;
			if (timer) clearTimeout(timer);
		};
	}, [api, bootstrapped, onError, serverReady, hasSession, sessionId, visible]);

	// Drop ask_user draft answers once their interaction or session goes away.
	useEffect(() => {
		if (!syncReady) return;
		for (const id of askUserDrafts.current.keys()) {
			if (!session || !chat.interactionsById.has(id)) askUserDrafts.current.delete(id);
		}
	}, [chat.interactionsById, session, syncReady]);

	const modelControl = session ? (
		<ModelSelector
			available={projection.availableModels}
			commandRequest={{ id: composerControl.id, open: composerControl.target === "model" }}
			disabled={!serverReady}
			onChange={(model) => onChangeModel(sessionId, model)}
			value={projection.model}
		/>
	) : undefined;
	const thinkingControl = session ? (
		<ThinkingSelector
			actualThinkingLevel={projection.actualThinkingLevel}
			available={projection.availableThinkingSelections}
			commandRequest={{ id: composerControl.id, open: composerControl.target === "thinking" }}
			disabled={!serverReady}
			onChange={(selection) => onChangeThinking(sessionId, selection)}
			reducedMotion={reducedMotion}
			value={projection.thinkingSelection}
		/>
	) : undefined;
	const permissionControl = session ? (
		<PermissionSelector
			activeReview={projection.activeReview}
			constrainedByParent={projection.constrainedByParent}
			disabled={!serverReady}
			onChange={(permissionPreset) => onChangePermissionPreset(sessionId, permissionPreset)}
			onSetupSandbox={onSetupSandbox}
			sandboxHealth={projection.sandboxHealth}
			value={projection.permissionPreset}
		/>
	) : undefined;
	const collaborationControl =
		collaborationModeValue === "plan" && session ? (
			<div className="collaboration-mode-control">
				<span aria-hidden="true" className="collaboration-mode-separator" />
				<button
					aria-label={t("Exit Plan mode")}
					className="collaboration-mode-indicator"
					disabled={collaborationModeBlocked}
					onClick={() => void changeCollaborationMode("default").catch(() => undefined)}
					type="button"
				>
					<span aria-hidden="true" className="collaboration-mode-icon">
						<Lightbulb className="collaboration-mode-active-icon" size={14} />
						<XCircle className="collaboration-mode-exit-icon" size={14} weight="fill" />
					</span>
					<span>{t("Plan")}</span>
				</button>
			</div>
		) : undefined;
	const planRevisionChip = planRevisionTarget ? (
		<div className="composer-plan-context">
			<span className="composer-plan-revision-chip">
				{t("Revise plan")}: {planRevisionTarget.title} · r{planRevisionTarget.revision}
			</span>
			<button aria-label={t("Remove revision context")} onClick={clearPlanRevision} type="button">
				×
			</button>
		</div>
	) : null;
	const connectedMcpServers = mcpServers.filter(
		(server) => server.effective && server.enabled && server.state === "connected",
	);
	const mcpConnectionState = mcpServers.some(
		(server) =>
			server.effective &&
			server.enabled &&
			(server.state === "auth_required" ||
				server.state === "error" ||
				(server.state === "reconnecting" && Boolean(server.lastError))),
	)
		? ("failed" as const)
		: mcpServers.some(
					(server) =>
						server.effective &&
						server.enabled &&
						(server.state === "connecting" || server.state === "reconnecting"),
				)
			? ("connecting" as const)
			: undefined;

	return (
		<div className="workspace-body">
			<div className="conversation-column" data-mode={session?.mode ?? "chat"}>
				<Transcript
					quoteSessionId={visible && serverReady ? writableSessionId : undefined}
					showNavigation
					activeTurnId={projection.activeTurnId}
					waitingForAnswer={waitingForAnswer}
					activeTurnStartedAt={
						projection.activeTurnId ? projection.turnsById.get(projection.activeTurnId)?.startedAt : undefined
					}
					appearance={session?.mode ?? "chat"}
					autoLoadOlder
					hasOlder={projection.nextBeforeItemId !== null}
					itemIds={projection.itemOrder}
					itemsById={projection.itemsById}
					loadingOlder={loadingOlder}
					onCancelPlan={cancelPlanAction}
					onCopy={copyText}
					onFork={forkItem}
					onLoadOlder={loadOlder}
					onOpenDeliveredFile={openDeliveredFile}
					onOpenPlan={openPlan}
					onPreviewDeliveredFile={previewDeliveredFile}
					onRevisePlan={revisePlan}
					onStartPlan={startPlanAction}
					planActionsBusy={planActionsBusy}
				/>
				{compactingStartedAt !== null && (
					<TurnRuntimeStatus items={[]} running startedAt={compactingStartedAt} variant="compaction" />
				)}
				<div className="conversation-composer">
					<Composer
						knowledge={
							serverReady && writableSessionId
								? { api, sessionId: writableSessionId, onOpen: onOpenKnowledge }
								: undefined
						}
						appearance={session?.mode ?? "chat"}
						collaborationControl={collaborationControl}
						contextControl={planRevisionChip}
						contextUsageExpanded={sessionStatusPanel?.sessionId === sessionId && !sessionStatusPanel.closing}
						contextUsagePercent={
							contextStatus && contextStatus.sessionId === sessionId ? contextUsagePercent(contextStatus) : null
						}
						onOpenContextUsage={writableSessionId ? toggleSessionStatus : undefined}
						commandPanel={
							sessionStatusPanel?.sessionId === sessionId ? (
								<SessionStatusPanel
									closing={sessionStatusPanel.closing}
									error={sessionStatusPanel.error}
									loading={sessionStatusPanel.loading}
									onClose={closeSessionStatus}
									status={sessionStatusPanel.status}
								/>
							) : undefined
						}
						commandRequest={{ id: composerControl.id, open: composerControl.target === "mcp" }}
						disabled={!serverReady || !syncReady || compactingStartedAt !== null || collaborationModeChanging}
						disabledSlashCommands={disabledSlashCommands}
						disabledSlashReasons={disabledSlashReasons}
						formRef={canonicalComposer ? composerFormRef : undefined}
						inputId={composerInputId}
						interactionControl={
							inlineInteraction ? (
								<InteractionHost
									interaction={inlineInteraction}
									key={inlineInteraction.interactionId}
									onRespond={onRespond}
									sandboxHealth={projection.sandboxHealth}
									askUserDrafts={askUserDrafts.current}
									disabled={!serverReady || !syncReady}
								/>
							) : undefined
						}
						awaitingAnswer={waitingForAnswer}
						goalControl={
							<GoalBar
								goal={projection.goal}
								onClear={() => void mutateSessionGoal({ clear: true })}
								onPause={() => void mutateSessionGoal({ status: "paused" })}
								onResume={() => void mutateSessionGoal({ status: "active" })}
							/>
						}
						mcpConnectionState={mcpConnectionState}
						mcpServers={connectedMcpServers}
						modelControl={modelControl}
						onGoalCommand={handleGoalCommand}
						onInterrupt={interrupt}
						onManageMcp={onManageMcp}
						onManageSkills={onManageSkills}
						onPickFiles={onPickFiles}
						onResolveDroppedFiles={onResolveDroppedFiles}
						onSlashCommand={handleSlashCommand}
						onSubmit={submit}
						permissionControl={permissionControl}
						placeholder={t(
							waitingForAnswer
								? "Answer the questions above to continue."
								: planRevisionTarget
									? "Describe what should change in this plan…"
									: running || projection.queuedTurns.length > 0
										? "Add a queued message…"
										: "Write a message…",
						)}
						prefillRequest={prefillRequest}
						queuedTurnControl={
							<QueuedTurnList
								disabled={!serverReady || !syncReady || compactingStartedAt !== null}
								onDelete={deleteQueuedTurn}
								onEdit={editQueuedTurn}
								onSend={sendQueuedTurn}
								running={running}
								turns={projection.queuedTurns}
							/>
						}
						queueing={projection.queuedTurns.length > 0}
						running={running}
						selectionSessionId={sessionId}
						skills={skills}
						taskListEpoch={chat.serverEpoch}
						tasks={projection.tasks}
						thinkingControl={thinkingControl}
					/>
				</div>
			</div>
			{visible && modalInteraction !== undefined && (
				<InteractionHost
					interaction={modalInteraction}
					key={modalInteraction.interactionId}
					onRespond={onRespond}
					sandboxHealth={projection.sandboxHealth}
				/>
			)}
		</div>
	);
});
