import type { InteractionResponseInput, InteractionView, SessionSnapshot } from "@metis/app-protocol";
import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskUserAnswerSummary } from "./AskUserAnswerSummary.tsx";
import type { AskUserDraft } from "./AskUserPanel.tsx";
import { DrawerDetails } from "./DrawerDetails.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { TaskList } from "./TaskList.tsx";
import { commandText, type ToolCallBlock, type ToolResultBlock, tasksFromTool } from "./transcript-turn-model.ts";
import "../styles/conversation-interactions.css";

export type InlineInteraction = Extract<InteractionView, { kind: "ask_user" | "session_permission_approval" }>;

export interface ConversationInteractions {
	readonly requests: readonly InlineInteraction[];
	readonly onRespond: (response: InteractionResponseInput) => Promise<void>;
	readonly askUserDrafts?: Map<string, AskUserDraft>;
	readonly sandboxHealth?: SessionSnapshot["sandboxHealth"];
	readonly disabled?: boolean;
}

export interface InteractionReceipt {
	readonly request: InlineInteraction;
	readonly response?: InteractionResponseInput;
}

export const ConversationInteractionContext = createContext<
	(ConversationInteractions & { readonly receipts: ReadonlyMap<string, InteractionReceipt> }) | undefined
>(undefined);

export function interactionToolId(request: InlineInteraction): string | undefined {
	return request.toolCallId ?? (request.kind === "session_permission_approval" ? request.actionId : undefined);
}

export function PendingInteractionCard({ request }: { readonly request: InlineInteraction }) {
	const context = useContext(ConversationInteractionContext);
	const { t } = useTranslation();
	const [expired, setExpired] = useState(() =>
		Boolean(request.expiresAt && Date.parse(request.expiresAt) <= Date.now()),
	);
	useEffect(() => {
		if (!request.expiresAt) return;
		const timeout = window.setTimeout(
			() => setExpired(true),
			Math.max(0, Date.parse(request.expiresAt) - Date.now()),
		);
		return () => window.clearTimeout(timeout);
	}, [request.expiresAt]);
	if (!context) return null;
	if (expired)
		return (
			<div className="conversation-interaction-card conversation-card-status">{t("This request has expired")}</div>
		);
	return (
		<div className="conversation-interaction-card is-pending" data-interaction-id={request.interactionId}>
			<InteractionHost
				interaction={request}
				onRespond={context.onRespond}
				askUserDrafts={context.askUserDrafts}
				sandboxHealth={context.sandboxHealth}
				disabled={context.disabled}
			/>
		</div>
	);
}

export function PermissionReceipt({ call }: { readonly call: ToolCallBlock }) {
	const { t } = useTranslation();
	const context = useContext(ConversationInteractionContext);
	const receipt = context?.receipts.get(call.toolCallId);
	const decision = call.permissionDecision;
	if (decision?.source !== "user" && receipt?.request.kind !== "session_permission_approval") return null;
	const response = receipt?.response;
	const choice =
		response?.kind === "session_permission_approval"
			? response.choice
			: decision?.remember === "project"
				? decision.outcome === "deny"
					? "always-deny-exact"
					: "always-allow-exact"
				: decision?.remember === "session"
					? "allow-session-exact"
					: undefined;
	const label =
		choice === "allow-session-exact"
			? "Allowed for this session"
			: choice === "always-allow-exact"
				? "Allowed for this project"
				: choice === "always-deny-exact"
					? "Denied for this project"
					: choice === "allow-once"
						? "Allowed once"
						: choice === "deny-once" || decision?.outcome === "deny"
							? "Rejected"
							: decision?.outcome === "unavailable" || (!decision && call.state === "interrupted")
								? "Approval cancelled or expired"
								: decision?.source === "user"
									? "Approved by you"
									: "Approval ended";
	const command =
		receipt?.request.kind === "session_permission_approval"
			? receipt.request.command
			: commandText(call.inputPreview);
	return (
		<DrawerDetails className="conversation-interaction-card conversation-permission-receipt" summary={t(label)}>
			{command ? (
				<pre className="permission-approval-command">
					<code>{command}</code>
				</pre>
			) : (
				<p>{call.name}</p>
			)}
		</DrawerDetails>
	);
}

/** Cards belong to their tool positions; one task snapshot is anchored at the first update in this turn. */
export function ConversationToolCards({
	calls,
	allCalls,
	results,
}: {
	readonly calls: readonly ToolCallBlock[];
	readonly allCalls: readonly ToolCallBlock[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
}) {
	const context = useContext(ConversationInteractionContext);
	const { t } = useTranslation();
	const taskCalls = allCalls.filter((call) => call.name === "set_tasks");
	const lastTasks = [...taskCalls].reverse().find((call) => {
		const result = results.get(call.toolCallId);
		return result && !result.isError;
	});
	return calls.map((call) => {
		const request = context?.requests.find((request) => interactionToolId(request) === call.toolCallId);
		const receipt = context?.receipts.get(call.toolCallId);
		const result = results.get(call.toolCallId);
		if (request) return <PendingInteractionCard key={request.interactionId} request={request} />;
		if (call.name === "set_tasks") {
			return call === taskCalls[0] && lastTasks ? (
				<TaskList key={call.toolCallId} tasks={tasksFromTool(lastTasks, results.get(lastTasks.toolCallId))} />
			) : null;
		}
		if (call.name === "ask_user") {
			if (result && !result.isError && (result.userAnswers || result.output.startsWith("User answers:\n")))
				return <AskUserAnswerSummary key={call.toolCallId} result={result} />;
			const response = receipt?.response;
			if (response?.kind === "ask_user" && !response.cancelled && receipt?.request.kind === "ask_user") {
				const questions = receipt.request.questions;
				return (
					<AskUserAnswerSummary
						key={call.toolCallId}
						answers={response.answers.map((answer) => {
							const question = questions.find((question) => question.id === answer.questionId)!;
							return {
								question: question.question,
								answer: [
									...question.choices
										.filter((choice) => answer.choiceIds.includes(choice.id))
										.map((choice) => choice.label),
									...(answer.customAnswer ? [answer.customAnswer] : []),
								].join("; "),
							};
						})}
					/>
				);
			}
			return (
				<div key={call.toolCallId} className="conversation-interaction-card conversation-card-status">
					{t(result || call.state === "interrupted" || receipt ? "Questions closed" : "Preparing questions…")}
				</div>
			);
		}
		// Successful deliveries have a file card instead of an execution detail.
		if (call.name === "deliver_file" && !result?.isError)
			return <PermissionReceipt key={call.toolCallId} call={call} />;
		return null;
	});
}
