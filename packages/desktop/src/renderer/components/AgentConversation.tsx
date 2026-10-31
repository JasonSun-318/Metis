import type { ClientResult, QueuedTurnView } from "@metis/app-protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isAgentRunning } from "../agent-activity.ts";
import { type ConversationSubmission, composerPayload, composerRequestKey } from "../composer-submission.ts";
import type { AgentConversationTarget } from "../conversation-target.ts";
import { useAgentCatalog } from "../hooks/use-agent-catalog.ts";
import { useAgentHistory } from "../hooks/use-agent-history.ts";
import { useAgentQueuedMessages } from "../hooks/use-agent-queued-messages.ts";
import { useAppStore } from "../hooks/use-app-store.ts";
import { ArrowLeft, Info, Stop } from "../icons.tsx";
import { queuedTurnActionError } from "../session-view-utils.ts";
import { AgentConversationDetails } from "./AgentConversationDetails.tsx";
import type { AskUserDraft } from "./AskUserPanel.tsx";
import { Composer, type ComposerPrefillRequest } from "./Composer.tsx";
import { ConversationScopeContext, useConversationScope } from "./ConversationScope.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { QueuedTurnList } from "./QueuedTurnList.tsx";
import type { SessionChatViewContext } from "./SessionChatView.tsx";
import { composerSlashCommands } from "./SlashCommandMenu.tsx";
import { Transcript } from "./Transcript.tsx";

const UNSUPPORTED_AGENT_COMMANDS = new Set(composerSlashCommands);

export interface AgentConversationProps {
	readonly target: AgentConversationTarget;
	readonly context: SessionChatViewContext;
	readonly visible: boolean;
	readonly onOpenParent: (target: AgentConversationTarget | string) => void;
}

export function AgentConversation({ target, context, visible, onOpenParent }: AgentConversationProps) {
	const { api, store, onError } = context;
	const identity = `${target.sessionId}:${target.agentId}`;
	const currentIdentity = useRef(identity);
	currentIdentity.current = identity;
	const scope = useConversationScope();
	const { t } = useTranslation();
	const catalog = useAgentCatalog(api, target.sessionId);
	const agent = catalog.agents.find((candidate) => candidate.agentId === target.agentId);
	const history = useAgentHistory(api, target.sessionId, target.agentId);
	const queued = useAgentQueuedMessages(api, target.sessionId, target.agentId);
	const snapshot = useAppStore(store);
	const root = snapshot.sessionsById.get(target.sessionId);
	const reloadCatalog = catalog.reload;
	const reloadHistory = history.reload;
	const reloadQueue = queued.reload;
	useEffect(() => {
		if (!visible) return;
		const refresh = () => {
			if (document.visibilityState === "hidden") return;
			reloadCatalog();
			reloadHistory();
			reloadQueue();
		};
		refresh();
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [visible, reloadCatalog, reloadHistory, reloadQueue]);
	const mode = agent?.mode ?? root?.mode ?? "chat";
	const running = agent !== undefined && isAgentRunning(agent);
	const settledTaskKey =
		agent && !running
			? `${agent.agentId}:${agent.currentTask?.taskId ?? agent.latestTask?.taskId ?? "none"}:${agent.status}:${agent.runControl ?? "enabled"}:${agent.updatedAt}`
			: undefined;
	// A cold catalog can reach a terminal state after an earlier history read.
	// Reconcile that durable tail even when the live terminal event was missed.
	useEffect(() => {
		if (visible && settledTaskKey) reloadHistory();
	}, [visible, settledTaskKey, reloadHistory]);
	const interaction = snapshot.interactionOrder
		.map((id) => snapshot.interactionsById.get(id))
		.find((pending) => (pending?.actorSessionId ?? pending?.sessionId) === target.agentId);
	const askUserDrafts = useRef(new Map<string, AskUserDraft>());
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [prefill, setPrefill] = useState<{ identity: string; request: ComposerPrefillRequest }>();
	const [pendingQueues, setPendingQueues] = useState<ReadonlySet<string>>(new Set());
	const queueActions = useRef(new Set<string>());
	const queueBusy = pendingQueues.has(identity);
	const [receipt, setReceipt] = useState<ClientResult<"agent/send">>();
	const [sendError, setSendError] = useState<string>();
	const retry = useRef<{ key: string; requestId: string } | undefined>(undefined);
	const transcriptItems = useMemo(
		() => history.items.filter((item) => !(item.origin?.kind === "user" && item.deliveryState === "queued")),
		[history.items],
	);
	const itemsById = useMemo(() => new Map(transcriptItems.map((item) => [item.itemId, item])), [transcriptItems]);
	const itemIds = useMemo(() => transcriptItems.map((item) => item.itemId), [transcriptItems]);
	const activeTurnId = useMemo(() => {
		const task = agent?.currentTask;
		if (!running || agent?.status !== "running" || !task) return null;
		const latest = [...history.items]
			.reverse()
			.find(
				(item) =>
					item.turnId &&
					item.createdAt >= task.createdAt &&
					item.deliveryState !== "queued" &&
					(item.agentTaskId === undefined || item.agentTaskId === task.taskId),
			);
		// A new task can be running before its first durable/live item arrives.
		return latest?.turnId ?? `agent-task:${task.taskId}`;
	}, [agent?.status, agent?.currentTask, history.items, running]);
	const submit = async (input: ConversationSubmission) => {
		if (interaction || queueActions.current.has(identity) || queued.loading || queued.error)
			throw new Error(t("This conversation is not ready to send"));
		const delivery = running || queued.turns.length > 0 ? "queue" : "auto";
		const key = `${identity}:${delivery}:${composerRequestKey(input)}`;
		if (retry.current?.key !== key) retry.current = { key, requestId: crypto.randomUUID() };
		setSendError(undefined);
		try {
			const result = await api.sendAgentMessage({
				sessionId: target.sessionId,
				agentId: target.agentId,
				requestId: retry.current.requestId,
				delivery,
				input: composerPayload(input),
			});
			if (currentIdentity.current !== identity) return;
			setReceipt(result);
			retry.current = undefined;
			history.reload();
			catalog.reload();
			queued.reload();
		} catch (cause) {
			if (currentIdentity.current === identity)
				setSendError(cause instanceof Error ? cause.message : t("Couldn’t send the message."));
			onError(cause);
			throw cause;
		}
	};
	const manageQueuedMessage = async (turn: QueuedTurnView, delivery?: "steer" | "start") => {
		if (interaction || queueActions.current.has(identity) || !context.bootstrapped || !agent || agent.archived)
			throw new Error(t("This conversation is not ready to send"));
		queueActions.current.add(identity);
		setPendingQueues(new Set(queueActions.current));
		setSendError(undefined);
		const input = {
			sessionId: target.sessionId,
			agentId: target.agentId,
			requestId: crypto.randomUUID(),
			queueItemId: turn.queueItemId,
			expectedRevision: turn.revision,
		};
		try {
			if (delivery) await api.sendAgentQueuedMessage({ ...input, delivery });
			else await api.deleteAgentQueuedMessage(input);
		} catch (cause) {
			const error = queuedTurnActionError(cause);
			if (currentIdentity.current === identity) setSendError(t(error.message));
			onError(error);
			throw error;
		} finally {
			queueActions.current.delete(identity);
			setPendingQueues(new Set(queueActions.current));
			if (currentIdentity.current === identity) {
				queued.reload();
				history.reload();
				catalog.reload();
			}
		}
	};
	const editQueuedMessage = async (turn: QueuedTurnView) => {
		await manageQueuedMessage(turn);
		if (currentIdentity.current !== identity) return;
		setPrefill((current) => ({ identity, request: { id: (current?.request.id ?? 0) + 1, text: turn.text } }));
		if (turn.attachments.length > 0)
			context.onNotice("The message was returned to the composer. Add its attachments again before sending.");
	};
	const control = async (action: "stop" | "resume") => {
		try {
			await api.controlAgent({
				sessionId: target.sessionId,
				agentId: target.agentId,
				requestId: crypto.randomUUID(),
				action,
				scope: action === "stop" ? "subtree" : "self",
			});
			catalog.reload();
			history.reload();
		} catch (cause) {
			onError(cause);
		}
	};
	const parent = agent && catalog.agents.find((candidate) => candidate.agentId === agent.parentSessionId);
	const openParent = () =>
		onOpenParent(
			parent ? { sessionId: target.sessionId, agentId: parent.agentId, name: parent.name } : target.sessionId,
		);
	const receiptItem = receipt && history.items.find((item) => item.agentMessageId === receipt.messageId);
	const pendingReceipt = receipt && !receiptItem && receipt.state !== "delivered" ? receipt.state : undefined;
	const statusLabel = !agent
		? "Loading…"
		: agent.runControl && agent.runControl !== "enabled"
			? "Stopped"
			: (
					{
						running: "Running",
						queued: "Queued",
						done: "Completed",
						failed: "Failed",
						interrupted: "Stopped",
						stopped: "Stopped",
						idle: "Ready",
					} as const
				)[agent.status];
	return (
		<ConversationScopeContext.Provider value={{ ...scope, rootSessionId: target.sessionId, openParent }}>
			<div className="agent-conversation conversation-column" data-mode={mode} data-agent-id={target.agentId}>
				<header className="agent-conversation-header">
					<button aria-label={t("Open parent conversation")} onClick={openParent} type="button">
						<ArrowLeft size={15} />
						<span>{parent?.name ?? root?.name ?? t("Parent conversation")}</span>
					</button>
					<div className="agent-conversation-heading">
						<strong>{agent?.name ?? target.name}</strong>
						<span className="agent-conversation-state">{t(statusLabel)}</span>
						<div className="agent-conversation-actions">
							{running && (
								<button
									aria-label={t("Stop agent")}
									title={t("Stop this agent immediately")}
									type="button"
									onClick={() => void control("stop")}
								>
									<Stop aria-hidden="true" size={13} />
									{t("Stop agent")}
								</button>
							)}
							{agent?.runControl && agent.runControl !== "enabled" && (
								<button type="button" onClick={() => void control("resume")}>
									{t("Resume agent")}
								</button>
							)}
							<button
								aria-label={t("Agent details")}
								title={t("Agent details")}
								disabled={!agent}
								type="button"
								onClick={() => setDetailsOpen(true)}
							>
								<Info aria-hidden="true" size={16} />
							</button>
						</div>
					</div>
				</header>
				{Boolean(catalog.error || history.error || queued.error) && (
					<div className="agent-conversation-error" role="alert">
						{t("Couldn’t load this agent conversation.")}{" "}
						<button
							type="button"
							onClick={() => {
								catalog.reload();
								history.reload();
								queued.reload();
							}}
						>
							{t("Retry")}
						</button>
					</div>
				)}
				<Transcript
					interactions={{
						requests: [...snapshot.interactionsById.values()].filter(
							(
								pending,
							): pending is Extract<typeof pending, { kind: "ask_user" | "session_permission_approval" }> =>
								(pending.actorSessionId ?? pending.sessionId) === target.agentId &&
								(pending.kind === "ask_user" || pending.kind === "session_permission_approval"),
						),
						onRespond: context.onRespond,
						askUserDrafts: askUserDrafts.current,
						disabled: !visible || !context.bootstrapped,
					}}
					ariaLabel={t("Agent conversation")}
					appearance={mode}
					submittedMessageId={
						receipt?.state === "failed" || receipt?.state === "cancelled" ? undefined : receipt?.messageId
					}
					activeTurnId={activeTurnId}
					activeRunId={agent?.currentTask?.taskId}
					activeTurnStartedAt={agent?.currentTask?.createdAt}
					retry={agent?.retry}
					waitingForAnswer={interaction?.kind === "ask_user"}
					quoteSessionId={target.agentId}
					hasOlder={history.cursor !== null}
					itemIds={itemIds}
					itemsById={itemsById}
					loadingOlder={history.loading}
					onLoadOlder={history.loadOlder}
					onOpenDeliveredFile={(fileId, action) =>
						void api
							.openDeliveredFile({ sessionId: target.agentId, rootSessionId: target.sessionId, fileId, action })
							.catch(onError)
					}
					onPreviewDeliveredFile={(file) => context.onPreviewDeliveredFile(target.agentId, file, target.sessionId)}
					onCopy={(text) => void navigator.clipboard.writeText(text).catch(onError)}
				/>
				<div className="conversation-composer">
					{agent?.runControl && agent.runControl !== "enabled" && (
						<div className="agent-conversation-notice">
							{t(
								"This agent is stopped. Sending a message resumes this conversation within its parent’s permissions.",
							)}
						</div>
					)}
					{pendingReceipt && (
						<output className="agent-conversation-notice agent-delivery-pending" aria-live="polite">
							{t(
								pendingReceipt === "queued"
									? "Queued for the agent"
									: pendingReceipt === "cancelled"
										? "Message cancelled"
										: pendingReceipt === "failed"
											? "Message delivery failed"
											: "Message saved; waiting for delivery",
							)}
						</output>
					)}
					{sendError && (
						<div className="agent-conversation-error" role="alert">
							{sendError}
						</div>
					)}
					<Composer
						appearance={mode}
						disabledSlashCommands={UNSUPPORTED_AGENT_COMMANDS}
						disabled={!context.bootstrapped || !agent || agent.archived}
						running={running}
						queueing={queued.turns.length > 0}
						submitDisabled={queued.loading || Boolean(queued.error) || queueBusy}
						prefillRequest={prefill?.identity === identity ? prefill.request : undefined}
						interactionPending={interaction !== undefined}
						awaitingAnswer={interaction?.kind === "ask_user"}
						inputId={`agent-composer-${target.agentId}`}
						selectionSessionId={target.agentId}
						onSubmit={submit}
						onInterrupt={() => control("stop")}
						onPickFiles={context.onPickFiles}
						onResolveDroppedFiles={context.onResolveDroppedFiles}
						placeholder={t(running ? "Add instructions for this agent…" : "Message this agent…")}
						modelControl={
							<span className="agent-conversation-model">{agent?.model?.modelId ?? t("Inherited model")}</span>
						}
						queuedTurnControl={
							<QueuedTurnList
								disabled={
									!context.bootstrapped ||
									!agent ||
									agent.archived ||
									queueBusy ||
									Boolean(queued.error) ||
									Boolean(interaction)
								}
								disabledReason={
									interaction ? t("Resolve the pending request to manage queued messages.") : undefined
								}
								onDelete={(turn) => manageQueuedMessage(turn)}
								onEdit={editQueuedMessage}
								onSend={manageQueuedMessage}
								running={running}
								turns={queued.turns}
							/>
						}
						interactionControl={
							interaction &&
							visible &&
							interaction.kind !== "ask_user" &&
							interaction.kind !== "session_permission_approval" ? (
								<InteractionHost interaction={interaction} onRespond={context.onRespond} />
							) : undefined
						}
					/>
				</div>
				{detailsOpen && agent && visible && (
					<AgentConversationDetails agent={agent} onClose={() => setDetailsOpen(false)} />
				)}
			</div>
		</ConversationScopeContext.Provider>
	);
}
