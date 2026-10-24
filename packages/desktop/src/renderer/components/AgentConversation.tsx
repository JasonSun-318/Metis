import type { ClientResult } from "@metis/app-protocol";
import { ArrowLeft, Info, Stop } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ConversationSubmission, composerPayload, composerRequestKey } from "../composer-submission.ts";
import type { AgentConversationTarget } from "../conversation-target.ts";
import { useAgentCatalog } from "../hooks/use-agent-catalog.ts";
import { useAgentHistory } from "../hooks/use-agent-history.ts";
import { useAppStore } from "../hooks/use-app-store.ts";
import { AgentConversationDetails } from "./AgentConversationDetails.tsx";
import { Composer } from "./Composer.tsx";
import { ConversationScopeContext, useConversationScope } from "./ConversationScope.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { MenuSelect } from "./MenuSelect.tsx";
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
	const scope = useConversationScope();
	const { t } = useTranslation();
	const catalog = useAgentCatalog(api, target.sessionId);
	const agent = catalog.agents.find((candidate) => candidate.agentId === target.agentId);
	const history = useAgentHistory(api, target.sessionId, target.agentId);
	const snapshot = useAppStore(store);
	const root = snapshot.sessionsById.get(target.sessionId);
	const mode = agent?.mode ?? root?.mode ?? "chat";
	const running = agent?.status === "running" || agent?.status === "queued";
	const interaction = snapshot.interactionOrder
		.map((id) => snapshot.interactionsById.get(id))
		.find((pending) => (pending?.actorSessionId ?? pending?.sessionId) === target.agentId);
	const [queue, setQueue] = useState(false);
	const [detailsOpen, setDetailsOpen] = useState(false);
	useEffect(() => {
		if (!running) setQueue(false);
	}, [running]);
	const [receipt, setReceipt] = useState<ClientResult<"agent/send">>();
	const [sendError, setSendError] = useState<string>();
	const retry = useRef<{ key: string; requestId: string } | undefined>(undefined);
	const itemsById = useMemo(() => new Map(history.items.map((item) => [item.itemId, item])), [history.items]);
	const itemIds = useMemo(() => history.items.map((item) => item.itemId), [history.items]);
	const activeTurnId = useMemo(() => {
		const task = agent?.currentTask;
		if (agent?.status !== "running" || !task) return null;
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
	}, [agent?.status, agent?.currentTask, history.items]);
	const submit = async (input: ConversationSubmission) => {
		const delivery = running && queue ? "queue" : "auto";
		const key = `${delivery}:${composerRequestKey(input)}`;
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
			setReceipt(result);
			retry.current = undefined;
			history.reload();
			catalog.reload();
		} catch (cause) {
			setSendError(cause instanceof Error ? cause.message : t("Couldn’t send the message."));
			onError(cause);
			throw cause;
		}
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
				{Boolean(catalog.error || history.error) && (
					<div className="agent-conversation-error" role="alert">
						{t("Couldn’t load this agent conversation.")}{" "}
						<button
							type="button"
							onClick={() => {
								catalog.reload();
								history.reload();
							}}
						>
							{t("Retry")}
						</button>
					</div>
				)}
				<Transcript
					ariaLabel={t("Agent conversation")}
					appearance={mode}
					activeTurnId={activeTurnId}
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
						queueing={queue}
						interactionPending={interaction !== undefined}
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
						collaborationControl={
							running ? (
								<MenuSelect
									ariaLabel={t("Message timing")}
									className="agent-delivery-select"
									menuMinWidth={280}
									value={queue ? "queue" : "steer"}
									onChange={(value) => setQueue(value === "queue")}
									options={[
										{
											value: "steer",
											label: t("During current task"),
											description: t(
												"The agent reads your message after its current step. Use Stop to interrupt immediately.",
											),
										},
										{
											value: "queue",
											label: t("After current task"),
											description: t("Start a follow-up after this task finishes."),
										},
									]}
								/>
							) : undefined
						}
						interactionControl={
							interaction && visible ? (
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
