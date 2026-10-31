import type { PlanView } from "@metis/app-protocol";
import { useTranslation } from "react-i18next";

const STATUS_KEYS: Record<PlanView["status"], string> = {
	proposed: "Proposed",
	superseded: "Superseded",
	accepted: "Accepted",
	cancelled: "Cancelled",
};

export interface PlanCardProps {
	readonly busy: boolean;
	readonly plan: PlanView;
	readonly onStart: (plan: PlanView) => void;
	readonly onCancel: (plan: PlanView) => void;
	readonly onOpen: (plan: PlanView) => void;
	readonly onRevise: (plan: PlanView) => void;
}

export function PlanCard({ busy, plan, onStart, onCancel, onOpen, onRevise }: PlanCardProps) {
	const { t } = useTranslation();
	const isProposed = plan.status === "proposed";
	const actionLabel = `${plan.title} · r${plan.revision}`;
	return (
		<section className="plan-card conversation-interaction-card" aria-label={t("Plan")}>
			<header className="plan-card-header">
				<div>
					<h2 className="plan-card-title">{plan.title}</h2>
					<span className="plan-card-meta">
						{t("Revision {{revision}}", { revision: plan.revision })} · {t(STATUS_KEYS[plan.status])}
					</span>
				</div>
				<button
					aria-label={`${t("Open plan")}: ${actionLabel}`}
					data-plan-action="open"
					onClick={() => onOpen(plan)}
					type="button"
				>
					{t("Open plan")}
				</button>
			</header>
			{isProposed && (
				<footer className="plan-card-actions">
					<button
						aria-label={`${t("Cancel plan")}: ${actionLabel}`}
						data-plan-action="cancel"
						disabled={busy}
						onClick={() => onCancel(plan)}
						type="button"
					>
						{t("Cancel plan")}
					</button>
					<button
						aria-label={`${t("Revise plan")}: ${actionLabel}`}
						data-plan-action="revise"
						disabled={busy}
						onClick={() => onRevise(plan)}
						type="button"
					>
						{t("Revise plan")}
					</button>
					<button
						aria-label={`${t("Start execution")}: ${actionLabel}`}
						data-plan-action="start"
						disabled={busy}
						onClick={() => onStart(plan)}
						type="button"
					>
						{t("Start execution")}
					</button>
				</footer>
			)}
		</section>
	);
}
