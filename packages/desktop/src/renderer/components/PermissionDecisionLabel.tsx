import type { PermissionDecisionView } from "@metis/app-protocol";
import { useTranslation } from "react-i18next";
import { type PermissionRuleReference, useConversationScope } from "./ConversationScope.tsx";

export type { PermissionRuleReference } from "./ConversationScope.tsx";

const SOURCE_LABELS = {
	rule: "Allowed by rule",
	model: "Approved by model",
	user: "Approved by you",
	full: "Full access",
} as const;

const MANUAL_REASON_LABELS = {
	sensitive: "sensitive file",
	write: "command or tool writes files",
	network: "network access",
	destructive: "destructive action",
	"analysis-incomplete": "incomplete analysis",
	critical: "critical action",
	"model-denied": "approval model declined",
	"model-unavailable": "approval model unavailable",
	"model-timeout": "approval model timed out",
	policy: "approval policy",
} as const;

export function PermissionDecisionLabel({
	source,
	matchedRule,
	ruleIds,
	manualReason,
}: {
	readonly source?: "rule" | "model" | "user" | "full";
	readonly matchedRule?: PermissionRuleReference;
	readonly ruleIds?: readonly string[];
	readonly manualReason?: PermissionDecisionView["manualReason"];
}) {
	const { t } = useTranslation();
	const scope = useConversationScope();
	if (!source) return null;
	const sourceLabel =
		source === "rule" && matchedRule?.scope === "project"
			? "Allowed by project permission"
			: source === "rule" && matchedRule?.scope === "session"
				? "Allowed by session permission"
				: SOURCE_LABELS[source];
	return (
		<span className="tool-permission-source">
			<span>{t(sourceLabel)}</span>
			{source === "rule" ? (
				matchedRule ? (
					<>
						<span className="tool-permission-rule-name" title={matchedRule.scope}>
							{matchedRule.name}
						</span>
						{scope.viewPermissionRule ? (
							<button
								className="tool-permission-rule-open"
								onClick={(event) => {
									event.stopPropagation();
									scope.viewPermissionRule?.(matchedRule);
								}}
								type="button"
							>
								{t("View rule")}
							</button>
						) : null}
					</>
				) : (
					<>
						<span className="tool-permission-rule-name">
							{t("rule details were not saved for this older record")}
						</span>
						{ruleIds?.length && scope.viewPermissionRule ? (
							<button
								className="tool-permission-rule-open"
								onClick={(event) => {
									event.stopPropagation();
									scope.viewPermissionRule?.({ id: ruleIds[0]!, name: ruleIds[0]!, scope: "" });
								}}
								type="button"
							>
								{t("View rule")}
							</button>
						) : null}
					</>
				)
			) : null}
			{source === "user" && manualReason ? (
				<span className="tool-permission-manual-reason">
					{t("Manual review")}: {t(MANUAL_REASON_LABELS[manualReason])}
				</span>
			) : null}
		</span>
	);
}
