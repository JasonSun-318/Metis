import { useTranslation } from "react-i18next";

export function ModelSettingsCard({
	ariaLabel,
	className = "model-provider-card",
	description,
	disabled,
	onClick,
	status,
	title,
}: {
	readonly ariaLabel?: string;
	readonly className?: string;
	readonly description: string;
	readonly disabled?: boolean;
	readonly onClick: () => void;
	readonly status: "configured" | "unconfigured" | "invalid";
	readonly title: string;
}) {
	const { t } = useTranslation();
	const stateClass = status === "unconfigured" ? "" : status;
	return (
		<button
			aria-label={ariaLabel}
			aria-haspopup="dialog"
			className={`model-settings-card ${className}`}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			<span className="model-provider-card-heading">
				<span className="model-provider-card-title">
					<span className={`model-provider-dot ${stateClass}`} />
					<strong title={title}>{title}</strong>
				</span>
				<span className={`model-provider-badge ${stateClass}`}>
					{t(status === "configured" ? "Configured" : status === "invalid" ? "Needs attention" : "Set up")}
				</span>
			</span>
			<small title={description}>{description}</small>
		</button>
	);
}
