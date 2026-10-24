import type { AgentSummaryView } from "@metis/app-protocol";
import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DialogFrame } from "./DialogFrame.tsx";

export function AgentConversationDetails({
	agent,
	onClose,
}: {
	readonly agent: AgentSummaryView;
	readonly onClose: () => void;
}) {
	const { t } = useTranslation();
	const id = useId();
	const close = useRef<HTMLButtonElement>(null);
	return (
		<DialogFrame
			cancellable
			className="project-dialog agent-details-dialog"
			descriptionId={`${id}-description`}
			initialFocus={close}
			onCancel={onClose}
			titleId={`${id}-title`}
		>
			<h2 id={`${id}-title`}>{t("Agent details")}</h2>
			<p id={`${id}-description`}>{agent.name}</p>
			<dl>
				<div>
					<dt>{t("Agent type")}</dt>
					<dd>{agent.agentType}</dd>
				</div>
				<div>
					<dt>{t("Model")}</dt>
					<dd>{agent.model?.modelId ?? t("Inherited model")}</dd>
				</div>
				<div>
					<dt>{t("Tools")}</dt>
					<dd>{agent.tools?.join(", ") || t("Capabilities are recorded when the agent starts.")}</dd>
				</div>
				<div>
					<dt>{t("Permissions")}</dt>
					<dd>
						{t(agent.writePolicy === "deny" ? "Filesystem writes denied" : "Inherits parent write permissions")}
					</dd>
				</div>
			</dl>
			<p className="agent-details-context">{t("Independent context · No automatic memory or skills loading")}</p>
			<div className="project-dialog-actions">
				<button className="button-secondary" onClick={onClose} ref={close} type="button">
					{t("Close")}
				</button>
			</div>
		</DialogFrame>
	);
}
