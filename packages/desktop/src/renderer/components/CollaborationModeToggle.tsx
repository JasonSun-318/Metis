import type { CollaborationModeView } from "@metis/app-protocol";
import { useTranslation } from "react-i18next";

export function CollaborationModeToggle({
	disabled,
	value,
	onChange,
}: {
	readonly disabled: boolean;
	readonly value: CollaborationModeView;
	readonly onChange: (value: CollaborationModeView) => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			aria-label={t("Plan mode")}
			aria-pressed={value === "plan"}
			className={`collaboration-mode-toggle${value === "plan" ? " is-active" : ""}`}
			disabled={disabled}
			onClick={() => onChange(value === "plan" ? "default" : "plan")}
			type="button"
		>
			{t("Plan")}
		</button>
	);
}
