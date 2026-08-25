import type { PlanView } from "@metis/app-protocol";
import { useTranslation } from "react-i18next";
import { Markdown } from "./Markdown.tsx";

export function PlanPreview({ plan }: { readonly plan: PlanView }) {
	const { t } = useTranslation();
	return (
		<section aria-label={t("Plan preview")} className="plan-preview">
			<header className="plan-preview-header">
				<h2>{plan.title}</h2>
				<span>{t("Revision {{revision}}", { revision: plan.revision })}</span>
			</header>
			<div className="plan-preview-body">
				<Markdown text={plan.markdown} />
			</div>
		</section>
	);
}
