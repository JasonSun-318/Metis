import { ArrowLeft, Brain, Browser, Cpu, GearSix, Robot, ShieldCheck, Sparkle, UserCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { GeneralPreferences } from "../general-preferences.ts";
import type { AppTheme } from "../theme.ts";
import { AgentTypesSettingsPanel } from "./AgentTypesSettingsPanel.tsx";
import { AutoCommandAllowlistPanel } from "./AutoCommandAllowlistPanel.tsx";
import { BrowserSettingsPanel } from "./BrowserSettingsPanel.tsx";
import { GeneralPanel } from "./GeneralPanel.tsx";
import { MemorySettingsPanel } from "./MemorySettingsPanel.tsx";
import { ModelSettingsPanel } from "./ModelSettingsPanel.tsx";
import { PersonalizationPanel } from "./PersonalizationPanel.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";

type SettingsPage = "profile" | "general" | "model" | "personalization" | "memory" | "agentTypes" | "permissions" | "browser" | "usage";

export function SettingsDialog({ api, closeDelayMs, generalPreferences, onClose, onGeneralPreferencesChange, onThemeChange, serverReady, theme }: {
	readonly api: MetisDesktopApi;
	readonly closeDelayMs?: number;
	readonly generalPreferences: GeneralPreferences;
	readonly onClose: () => void;
	readonly onGeneralPreferencesChange: (preferences: GeneralPreferences) => void;
	readonly onThemeChange: (theme: AppTheme) => void;
	readonly serverReady: boolean;
	readonly theme: AppTheme;
}) {
	const { t } = useTranslation();
	const [page, setPage] = useState<SettingsPage>("general");
	const [closing, setClosing] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	const firstNavRef = useRef<HTMLButtonElement>(null);
	const pageScrollRef = useRef<HTMLDivElement>(null);
	const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const delay = closeDelayMs ?? ((globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === "test" ? 0 : 160);

	const triggerClose = () => {
		if (closing) return;
		setClosing(true);
		if (delay <= 0) {
			onClose();
			return;
		}
		closingTimerRef.current = setTimeout(onClose, delay);
	};

	useEffect(() => {
		return () => {
			if (closingTimerRef.current) {
				clearTimeout(closingTimerRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
	}, [page]);

	useEffect(() => {
		firstNavRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (dialogRef.current?.querySelector("dialog[open]")) return;
			if (event.key === "Escape") {
				event.preventDefault();
				triggerClose();
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
	}, [triggerClose]);

	const pages = [
		{ id: "profile" as const, label: "Profile", description: "Review your profile and token usage.", icon: UserCircle },
		{ id: "general" as const, label: "General", description: "Manage language, appearance, fonts, motion, and web search.", icon: GearSix },
		{ id: "model" as const, label: "Model", description: "Configure model providers and defaults for new tasks.", icon: Cpu },
		{ id: "personalization" as const, label: "Personalization", description: "Set instructions Metis keeps in mind across new tasks.", icon: Sparkle },
		{ id: "memory" as const, label: "Memory", description: "Configure long-term memory and the index or extract engine.", icon: Brain },
		{ id: "agentTypes" as const, label: "Agent types", description: "Review built-in subagents and configure custom ones.", icon: Robot },
		{ id: "permissions" as const, label: "Permissions", description: "Control which simple commands Auto mode can run without review.", icon: ShieldCheck },
		{ id: "browser" as const, label: "Browser", description: "Import browser data and manage history and downloads.", icon: Browser },
	];
	const activePageId = page === "usage" ? "profile" : page;
	const activePage = pages.find((item) => item.id === activePageId) ?? pages[0]!;

	return (
		<div className={`settings-backdrop ${closing ? "is-closing" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) triggerClose(); }}>
			<div aria-label={t("Settings")} aria-modal="true" className="settings-dialog" data-platform={api.platform} ref={dialogRef} role="dialog">
				<aside className="settings-navigation" data-platform={api.platform}>
					<div className="settings-navigation-top" />
					<div className="settings-navigation-actions">
						<button aria-label={t("Back to app")} className="settings-back-button" onClick={triggerClose} type="button">
							<ArrowLeft aria-hidden="true" size={16} />
							<span>{t("Back to app")}</span>
						</button>
					</div>
					<div className="settings-nav-divider" />
					<nav aria-label={t("Settings pages")}>
						{pages.map(({ id, label, icon: Icon }, index) => {
							const isActive = page === id || (id === "profile" && page === "usage");
							return (
								<button
									aria-current={isActive ? "page" : undefined}
									className={`settings-nav-item ${isActive ? "active" : ""}`}
									key={id}
									onClick={() => setPage(id)}
									ref={id === "general" ? firstNavRef : undefined}
									type="button"
								>
									<Icon aria-hidden="true" size={18} />
									<span>{t(label)}</span>
								</button>
							);
						})}
					</nav>
				</aside>
				<div className="settings-main">
					<header className="settings-main-header">
						<div className="settings-main-header-content">
							<div className="settings-main-heading">
								<h1>{t(activePage.label)}</h1>
								<p>{t(activePage.description)}</p>
							</div>
							<button aria-label={t("Back to app")} className="settings-close-button" onClick={triggerClose} title={`${t("Back to app")} (Esc)`} type="button">
								<X aria-hidden="true" size={16} />
							</button>
						</div>
					</header>
					<div className={`settings-page-scroll settings-page-scroll-${page}`} ref={pageScrollRef}>
						<div className="settings-page-mount" key={page}>
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
							{page === "model" ? <ModelSettingsPanel api={api} serverReady={serverReady} /> : null}
							{page === "personalization" ? <PersonalizationPanel api={api} serverReady={serverReady} /> : null}
							{page === "memory" ? <MemorySettingsPanel api={api} onConfigureModels={() => setPage("model")} serverReady={serverReady} /> : null}
							{page === "agentTypes" ? <AgentTypesSettingsPanel api={api} serverReady={serverReady} /> : null}
							{page === "permissions" ? <AutoCommandAllowlistPanel api={api} serverReady={serverReady} /> : null}
							{page === "browser" ? <BrowserSettingsPanel api={api} /> : null}
							{page === "profile" || page === "usage" ? (
								<ProfilePanel
									api={api}
									initialTab={page === "usage" ? "usage" : "activity"}
									onTabChange={() => {
										if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
									}}
									serverReady={serverReady}
								/>
							) : null}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
