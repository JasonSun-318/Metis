import type { AgentMode, ItemView } from "@metis/app-protocol";
import { Markdown } from "./Markdown.tsx";
import { MessageOrigin } from "./MessageOrigin.tsx";
import { messageText } from "./transcript-turn-model.ts";

export function AgentReportMessage({
	item,
	appearance = "chat",
}: {
	readonly item: ItemView;
	readonly appearance?: AgentMode;
}) {
	if (!item.agentReport) return null;
	return (
		<div
			className={`agent-report-message ${appearance === "code" ? "code-turn-user" : "turn-user"}`}
			data-agent-report={item.itemId}
		>
			<MessageOrigin item={item} />
			<div
				className={`agent-report-body ${appearance === "code" ? "code-turn-user-bubble" : "message message-user"}`}
			>
				<Markdown text={messageText(item)} />
			</div>
		</div>
	);
}
