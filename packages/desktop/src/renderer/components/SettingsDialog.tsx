import { ArrowLeft, Brain, ChartBar, Cpu, GearSix, Sparkle, UserCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { GeneralPreferences } from "../general-preferences.ts";
import type { AppTheme } from "../theme.ts";
import { GeneralPanel } from "./GeneralPanel.tsx";
import { MemorySettingsPanel } from "./MemorySettingsPanel.tsx";
import { ModelSettingsPanel } from "./ModelSettingsPanel.tsx";
import { PersonalizationPanel } from "./PersonalizationPanel.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";
import { UsagePanel } from "./UsagePanel.tsx";

type SettingsPage = "general" | "personalization" | "profile" | "model" | "memory" | "usage";

export function SettingsDialog({ api, generalPreferences, onClose, onGeneralPreferencesChange, onThemeChange, serverReady, theme }: {
	readonly api: MetisDesktopApi;
	readonly generalPreferences: GeneralPreferences;
	readonly onClose: () => void;
	readonly onGeneralPreferencesChange: (preferences: GeneralPreferences) => void;
	readonly onThemeChange: (theme: AppTheme) => void;
	readonly serverReady: boolean;
	readonly theme: AppTheme;
}) {
	const { t } = useTranslation();
	const [page, setPage] = useState<SettingsPage>("general");
	const dialogRef = useRef<HTMLDivElement>(null);
	const firstNavRef = useRef<HTMLButtonElement>(null);
	const pageScrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
	}, [page]);

	useEffect(() => {
		firstNavRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (dialogRef.current?.querySelector("dialog[open]")) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
			) ?? [])].filter((element) => element.offsetParent !== null);
			if (focusable.length === 0) return;
			const first = focusable[0]!;
			const last = focusable.at(-1)!;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const pages = [
		{ id: "general" as const, label: "General", description: "Manage language, appearance, fonts, motion, and web search.", icon: GearSix },
		{ id: "personalization" as const, label: "Personalization", description: "Set instructions Metis keeps in mind across new tasks.", icon: Sparkle },
		{ id: "profile" as const, label: "Profile", description: "Review your profile and activity at a glance.", icon: UserCircle },
		{ id: "model" as const, label: "Model", description: "Configure model providers and defaults for new tasks.", icon: Cpu },
		{ id: "memory" as const, label: "Memory", description: "Configure long-term memory and the index or extract engine.", icon: Brain },
		{ id: "usage" as const, label: "Usage", description: "Review token usage across Chat and Code tasks.", icon: ChartBar },
	];
	const activePage = pages.find((item) => item.id === page)!;
	return (
		<div className="settings-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
			<div aria-label={t("Settings")} aria-modal="true" className="settings-dialog" ref={dialogRef} role="dialog">
				<aside className="settings-navigation">
					<button aria-label={t("Back to app")} className="settings-back-button" onClick={onClose} type="button">
						<ArrowLeft aria-hidden="true" size={16} />
						<span>{t("Back to app")}</span>
					</button>
					<p className="settings-navigation-label">{t("Preferences")}</p>
					<nav aria-label={t("Settings pages")}>
						{pages.map(({ id, label, icon: Icon }, index) => (
							<button
								aria-current={page === id ? "page" : undefined}
								className={`settings-nav-item ${page === id ? "active" : ""}`}
								key={id}
								onClick={() => setPage(id)}
								ref={index === 0 ? firstNavRef : undefined}
								type="button"
							>
								<Icon aria-hidden="true" size={18} />
								<span>{t(label)}</span>
							</button>
						))}
					</nav>
				</aside>
				<div className="settings-main">
					<header className="settings-main-header">
						<div className="settings-main-heading">
							<h1>{t(activePage.label)}</h1>
							<p>{t(activePage.description)}</p>
						</div>
					</header>
					<div className={`settings-page-scroll settings-page-scroll-${page}`} ref={pageScrollRef}>
						{page === "general" ? (
							<GeneralPanel
								api={api}
								generalPreferences={generalPreferences}
								onGeneralPreferencesChange={onGeneralPreferencesChange}
								onThemeChange={onThemeChange}
								serverReady={serverReady}
								theme={theme}
							/>
						) : null}
						{page === "profile" ? <ProfilePanel api={api} serverReady={serverReady} /> : null}
						{page === "personalization" ? <PersonalizationPanel api={api} serverReady={serverReady} /> : null}
						{page === "model" ? <ModelSettingsPanel api={api} serverReady={serverReady} /> : null}
						{page === "memory" ? <MemorySettingsPanel api={api} serverReady={serverReady} /> : null}
						{page === "usage" ? <UsagePanel api={api} serverReady={serverReady} /> : null}
					</div>
				</div>
			</div>
		</div>
	);
}
