import { useTranslation } from "react-i18next";
import { APP_THEMES, type AppTheme } from "../theme.ts";

export function GeneralPanel({ onThemeChange, theme }: {
	readonly onThemeChange: (theme: AppTheme) => void;
	readonly theme: AppTheme;
}) {
	const { t } = useTranslation();
	return (
		<div className="settings-page general-page">
			<section className="settings-section-heading">
				<div>
					<h2>{t("Appearance")}</h2>
					<p>{t("Choose how the Metis interface looks.")}</p>
				</div>
			</section>
			<section className="settings-section-card theme-card">
				<div className="theme-card-heading">
					<span>{t("Theme")}</span>
					<p>{t("Dark is the default; Light uses a clean white palette.")}</p>
				</div>
				<div aria-label={t("Theme")} className="settings-segmented theme-segmented" role="group">
					{APP_THEMES.map(({ value, label }) => (
						<button
							aria-pressed={theme === value}
							key={value}
							onClick={() => onThemeChange(value)}
							type="button"
						>
							<i aria-hidden="true" className={`theme-swatch theme-swatch-${value}`} />
							<span>{t(label)}</span>
						</button>
					))}
				</div>
			</section>
		</div>
	);
}
