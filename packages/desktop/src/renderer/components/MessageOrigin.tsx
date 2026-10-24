import type { ItemView } from "@metis/app-protocol";
import { useTranslation } from "react-i18next";

import { useConversationScope } from "./ConversationScope.tsx";

export function MessageOrigin({ item }: { readonly item: ItemView }) {
	const { t } = useTranslation();
	const scope = useConversationScope();
	if (!item.origin) return null;
	const deliveryLabel =
		item.deliveryState === "queued"
			? "Queued"
			: item.deliveryState === "accepted"
				? "Waiting to be read"
				: item.deliveryState === "failed"
					? "Message delivery failed"
					: item.deliveryState === "cancelled"
						? "Message cancelled"
						: undefined;
	if (item.origin.kind === "user" && !deliveryLabel) return null;
	return (
		<div className="message-origin" data-origin={item.origin.kind}>
			{item.origin.kind !== "user" && (
				<span>{t(item.origin.kind === "agent" ? "Parent agent" : "Agent coordination")}</span>
			)}
			{item.agentTargetId && scope.openAgent && (
				<button
					type="button"
					onClick={() =>
						scope.openAgent?.({
							sessionId: scope.rootSessionId ?? item.sessionId,
							agentId: item.agentTargetId!,
							name: t("Agent conversation"),
						})
					}
				>
					{t("Open agent conversation")}
				</button>
			)}
			{item.origin.kind === "agent" && scope.openParent && (
				<button type="button" onClick={scope.openParent}>
					{t("Open parent conversation")}
				</button>
			)}
			{deliveryLabel && <span>{t(deliveryLabel)}</span>}
		</div>
	);
}
