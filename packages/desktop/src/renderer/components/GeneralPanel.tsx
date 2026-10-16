import { Desktop, Moon, Sun } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import {
	CONTENT_FONT_SIZE_OPTIONS,
	type ContentFontSizePreference,
	type GeneralPreferences,
	PROSE_FONT_OPTIONS,
	type ProseFontPreference,
} from "../general-preferences.ts";
import { APP_LOCALES, type AppLocale, setLocale } from "../i18n.ts";
import { APP_THEMES, type AppTheme } from "../theme.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import { WebSearchSettingsPanel } from "./WebSearchSettingsPanel.tsx";

export function GeneralPanel({
	api,
	generalPreferences,
	onGeneralPreferencesChange,
	onThemeChange,
	onDirtyChange,
	serverReady,
	theme,
}: {
	readonly api: Pick<
		MetisDesktopApi,
		"getWebSearchSettings" | "revealWebSearchCredential" | "updateWebSearchSettings"
	>;
	readonly generalPreferences: GeneralPreferences;
	readonly onGeneralPreferencesChange: (preferences: GeneralPreferences) => void;
	readonly onThemeChange: (theme: AppTheme) => void;
	readonly onDirtyChange?: (dirty: boolean) => void;
	readonly serverReady: boolean;
	readonly theme: AppTheme;
}) {
	const { i18n, t } = useTranslation();
	const locale: AppLocale = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";
	const themeIcons = { dark: Moon, light: Sun, system: Desktop } as const;
	const fontOptions = PROSE_FONT_OPTIONS.map((option) => ({ ...option, label: t(option.label) }));

	return (
		<div className="settings-page general-page">
			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Interface & Appearance")}</h3>
				</header>
				<div className="settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Language")}</span>
							<p>{t("Choose the interface display language.")}</p>
						</div>
						<div className="general-setting-control">
							<fieldset aria-label={t("Language")} className="control-group settings-segmented">
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
							</fieldset>
						</div>
					</div>
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Appearance")}</span>
							<p>{t("Select light, dark, or follow system theme.")}</p>
						</div>
						<div className="general-setting-control">
							<fieldset
								aria-label={t("Appearance")}
								className="control-group settings-segmented appearance-segmented"
							>
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
							</fieldset>
						</div>
					</div>
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Motion")}</span>
							<p>{t("Reduce animation in streaming responses and interface elements.")}</p>
						</div>
						<div className="general-setting-control">
							<fieldset aria-label={t("Motion")} className="control-group settings-segmented">
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
							</fieldset>
						</div>
					</div>
				</div>
			</section>

			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Typography")}</h3>
				</header>
				<div className="settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Content font size")}</span>
							<p>{t("Adjust Chat and Code reading text without changing interface controls or layout.")}</p>
						</div>
						<div className="general-setting-control">
							<MenuSelect<ContentFontSizePreference>
								ariaLabel={t("Content font size")}
								className="general-font-select"
								menuAlign="end"
								onChange={(contentFontSize) =>
									onGeneralPreferencesChange({ ...generalPreferences, contentFontSize })
								}
								options={CONTENT_FONT_SIZE_OPTIONS}
								value={generalPreferences.contentFontSize}
							/>
						</div>
					</div>
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Chat font")}</span>
							<p>{t("Font used for Chat replies, greetings, and questions.")}</p>
							{generalPreferences.chatFont === "anthropic-serif" ? (
								<small>{t("Anthropic Serif falls back to the system serif for unsupported characters.")}</small>
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
							<p>
								{t("Font used for Code replies, greetings, and questions. Code and tools remain monospaced.")}
							</p>
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
				</div>
			</section>

			<WebSearchSettingsPanel onDirtyChange={onDirtyChange} api={api} serverReady={serverReady} />
		</div>
	);
}
