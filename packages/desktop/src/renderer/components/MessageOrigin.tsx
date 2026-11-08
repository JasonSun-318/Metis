import type { ItemView } from "@metis/app-protocol";
import { useTranslation } from "react-i18next";

import { useConversationScope } from "./ConversationScope.tsx";

export function MessageOrigin({ item }: { readonly item: ItemView }) {
	const { t } = useTranslation();
	const scope = useConversationScope();
	if (!item.origin) return null;
	const report = item.agentReport;
	const deliveryLabel = report
		? undefined
		: item.deliveryState === "queued"
			? "Queued"
			: item.deliveryState === "accepted"
				? "Waiting to be read"
				: item.deliveryState === "failed"
					? "Message delivery failed"
					: item.deliveryState === "cancelled"
						? "Message cancelled"
						: undefined;
	if (item.origin.kind === "user" && !deliveryLabel) return null;
	const label = report
		? "From subagent"
		: item.origin.kind === "agent"
			? "From parent agent"
			: item.origin.kind === "user"
				? "Open agent conversation"
				: "Agent coordination";
	const openSource =
		item.origin.kind === "agent"
			? scope.openParent
			: item.agentTargetId && scope.openAgent
				? () =>
						scope.openAgent?.({
							sessionId: scope.rootSessionId ?? item.sessionId,
							agentId: item.agentTargetId!,
							name: report?.name ?? t("Agent conversation"),
						})
				: undefined;
	const source = (
		<>
			<span>{t(label)}</span>
			{report && <span className="message-origin-name">{report.name}</span>}
		</>
	);
	return (
		<div className="message-origin" data-origin={item.origin.kind}>
			{(item.origin.kind !== "user" || openSource) &&
				(openSource ? (
					<button
						type="button"
						className="message-origin-source"
						title={t(item.origin.kind === "agent" ? "Open parent conversation" : "Open agent conversation")}
						onClick={openSource}
					>
						{source}
					</button>
				) : (
					<div className="message-origin-source">{source}</div>
				))}
			{report && report.status !== "done" && (
				<span>{t(report.status === "failed" ? "Subagent failed" : "Subagent stopped")}</span>
			)}
			{deliveryLabel && <span>{t(deliveryLabel)}</span>}
		</div>
	);
}
