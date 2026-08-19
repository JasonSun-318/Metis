import { useTranslation } from "react-i18next";

export interface ContextUsageRingProps {
	readonly percent: number | null;
	readonly onClick: () => void;
}

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextUsageRing({ percent, onClick }: ContextUsageRingProps) {
	const { t } = useTranslation();
	const fill = percent === null ? 0 : Math.max(0, Math.min(100, percent)) / 100;
	const offset = CIRCUMFERENCE * (1 - fill);
	const label =
		percent === null
			? t("Context usage unavailable")
			: t("Context usage {{percent}}%", { percent: Math.round(percent) });
	return (
		<button aria-label={label} className="context-usage-ring" onClick={onClick} type="button">
			<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
				<circle className="context-usage-ring-track" cx="8" cy="8" fill="none" r={RADIUS} strokeWidth="2" />
				<circle
					className="context-usage-ring-meter"
					cx="8"
					cy="8"
					data-circumference={CIRCUMFERENCE}
					fill="none"
					r={RADIUS}
					strokeDasharray={CIRCUMFERENCE}
					strokeDashoffset={offset}
					strokeWidth="2"
					transform="rotate(-90 8 8)"
				/>
			</svg>
		</button>
	);
}
