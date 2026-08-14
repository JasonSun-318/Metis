import { Desktop, Moon, Sun } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
	type GeneralPreferences,
	PROSE_FONT_OPTIONS,
	type ProseFontPreference,
} from "../general-preferences.ts";
import { APP_LOCALES, type AppLocale, setLocale } from "../i18n.ts";
import { APP_THEMES, type AppTheme } from "../theme.ts";
import { MenuSelect } from "./MenuSelect.tsx";

export function GeneralPanel({
	generalPreferences,
	onGeneralPreferencesChange,
	onThemeChange,
	theme,
}: {
	readonly generalPreferences: GeneralPreferences;
	readonly onGeneralPreferencesChange: (preferences: GeneralPreferences) => void;
	readonly onThemeChange: (theme: AppTheme) => void;
	readonly theme: AppTheme;
}) {
	const { i18n, t } = useTranslation();
	const locale: AppLocale = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";
	const themeIcons = { dark: Moon, light: Sun, system: Desktop } as const;
	const fontOptions = PROSE_FONT_OPTIONS.map((option) => ({ ...option, label: t(option.label) }));

	return (
		<div className="settings-page general-page">
			<section className="general-section">
				<header className="general-section-heading">
					<h2>{t("Preferences")}</h2>
					<p>{t("Choose your language, typography, and motion preferences.")}</p>
				</header>
				<div className="general-setting-row">
					<div className="general-setting-copy"><span>{t("Language")}</span></div>
					<div className="general-setting-control">
						<div aria-label={t("Language")} className="settings-segmented" role="group">
							{APP_LOCALES.map((option) => (
								<button
									aria-pressed={locale === option.value}
									key={option.value}
									onClick={() => void setLocale(option.value)}
									type="button"
								>
									{option.label}
								</button>
							))}
						</div>
					</div>
				</div>
				<div className="general-setting-row">
					<div className="general-setting-copy"><span>{t("Appearance")}</span></div>
					<div className="general-setting-control">
						<div aria-label={t("Appearance")} className="settings-segmented appearance-segmented" role="group">
							{APP_THEMES.map(({ value, label }) => {
								const Icon = themeIcons[value];
								return (
									<button
										aria-label={t(label)}
										aria-pressed={theme === value}
										key={value}
										onClick={() => onThemeChange(value)}
										title={t(label)}
										type="button"
									>
										<Icon aria-hidden="true" size={17} />
									</button>
								);
							})}
						</div>
					</div>
				</div>
				<div className="general-setting-row">
					<div className="general-setting-copy">
						<span>{t("Chat font")}</span>
						<p>{t("Font used for assistant prose in Chat mode.")}</p>
						{generalPreferences.chatFont === "anthropic-serif" ? (
							<p>{t("Anthropic Serif falls back to the system serif for unsupported characters.")}</p>
						) : null}
					</div>
					<div className="general-setting-control">
						<MenuSelect<ProseFontPreference>
							ariaLabel={t("Chat font")}
							className="general-font-select"
							menuAlign="end"
							onChange={(chatFont) => onGeneralPreferencesChange({ ...generalPreferences, chatFont })}
							options={fontOptions}
							value={generalPreferences.chatFont}
						/>
					</div>
				</div>
				<div className="general-setting-row">
					<div className="general-setting-copy">
						<span>{t("Code font")}</span>
						<p>{t("Font used for assistant prose in Code mode. Code and tools remain monospaced.")}</p>
					</div>
					<div className="general-setting-control">
						<MenuSelect<ProseFontPreference>
							ariaLabel={t("Code font")}
							className="general-font-select"
							menuAlign="end"
							onChange={(codeFont) => onGeneralPreferencesChange({ ...generalPreferences, codeFont })}
							options={fontOptions}
							value={generalPreferences.codeFont}
						/>
					</div>
				</div>
				<div className="general-setting-row">
					<div className="general-setting-copy">
						<span>{t("Motion")}</span>
						<p>{t("Reduce animation in streaming responses and interface elements.")}</p>
					</div>
					<div className="general-setting-control">
						<div aria-label={t("Motion")} className="settings-segmented" role="group">
							{(["system", "reduced"] as const).map((motion) => (
								<button
									aria-pressed={generalPreferences.motion === motion}
									key={motion}
									onClick={() => onGeneralPreferencesChange({ ...generalPreferences, motion })}
									type="button"
								>
									{t(motion === "system" ? "System" : "Reduced")}
								</button>
							))}
						</div>
					</div>
				</div>
			</section>
		</div>
	);
}
