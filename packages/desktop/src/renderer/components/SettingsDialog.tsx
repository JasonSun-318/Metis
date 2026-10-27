import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { GeneralPreferences } from "../general-preferences.ts";
import {
	ArrowLeft,
	Browser,
	Database,
	GearSix,
	Robot,
	ShieldCheck,
	Sparkles,
	TuningSquare,
	UserCircle,
} from "../icons.tsx";
import type { AppTheme } from "../theme.ts";
import { AgentTypesSettingsPanel } from "./AgentTypesSettingsPanel.tsx";
import { AutoCommandAllowlistPanel } from "./AutoCommandAllowlistPanel.tsx";
import { BrowserSettingsPanel } from "./BrowserSettingsPanel.tsx";
import { trapDialogTab } from "./dialog-focus.ts";
import { GeneralPanel } from "./GeneralPanel.tsx";
import { MemorySettingsPanel } from "./MemorySettingsPanel.tsx";
import { ModelSettingsPanel } from "./ModelSettingsPanel.tsx";
import { PersonalizationPanel } from "./PersonalizationPanel.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";

type SettingsPage =
	| "profile"
	| "general"
	| "model"
	| "personalization"
	| "memory"
	| "agentTypes"
	| "permissions"
	| "browser"
	| "usage";

export function SettingsDialog({
	api,
	closeDelayMs,
	generalPreferences,
	onClose,
	onGeneralPreferencesChange,
	onThemeChange,
	serverReady,
	sessionId,
	theme,
}: {
	readonly api: MetisDesktopApi;
	readonly closeDelayMs?: number;
	readonly generalPreferences: GeneralPreferences;
	readonly onClose: () => void;
	readonly onGeneralPreferencesChange: (preferences: GeneralPreferences) => void;
	readonly onThemeChange: (theme: AppTheme) => void;
	readonly serverReady: boolean;
	readonly sessionId?: string;
	readonly theme: AppTheme;
}) {
	const { t } = useTranslation();
	const [page, setPage] = useState<SettingsPage>("profile");
	const [closing, setClosing] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [pendingDestination, setPendingDestination] = useState<SettingsPage | "close" | null>(null);
	const unsavedDialog = useRef<HTMLDialogElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const firstNavRef = useRef<HTMLButtonElement>(null);
	const pageScrollRef = useRef<HTMLDivElement>(null);
	const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const delay =
		closeDelayMs ??
		((globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === "test" ? 0 : 160);

	const finishClose = useCallback(() => {
		if (closing) return;
		setClosing(true);
		if (delay <= 0) {
			onClose();
			return;
		}
		closingTimerRef.current = setTimeout(onClose, delay);
	}, [closing, delay, onClose]);
	const triggerClose = useCallback(() => {
		if (dirty) setPendingDestination("close");
		else finishClose();
	}, [dirty, finishClose]);
	const navigate = (target: SettingsPage) => {
		if (target === page) return;
		if (dirty) setPendingDestination(target);
		else setPage(target);
	};
	useEffect(() => {
		firstNavRef.current?.focus();
	}, []);
	useEffect(() => {
		if (!pendingDestination) return;
		const dialog = unsavedDialog.current!;
		const previous = document.activeElement as HTMLElement | null;
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		dialog.querySelector<HTMLButtonElement>("button")?.focus();
		return () => {
			if (typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
			if (previous?.isConnected) previous.focus();
		};
	}, [pendingDestination]);

	useEffect(() => {
		return () => {
			if (closingTimerRef.current) {
				clearTimeout(closingTimerRef.current);
			}
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies(page): Changing the settings page resets its scroll position.
	useEffect(() => {
		if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
	}, [page]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (dialogRef.current?.querySelector("dialog[open]")) return;
			if (event.key === "Escape") {
				event.preventDefault();
				triggerClose();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = [
				...(dialogRef.current?.querySelectorAll<HTMLElement>(
					'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
				) ?? []),
			].filter((element) => element.offsetParent !== null);
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
		{
			id: "profile" as const,
			label: "Profile",
			description: "Review your profile and token usage.",
			icon: UserCircle,
		},
		{
			id: "general" as const,
			label: "General",
			description: "Manage language, appearance, fonts, motion, and web search.",
			icon: GearSix,
		},
		{
			id: "model" as const,
			label: "Model",
			description: "Configure model providers and defaults for new tasks.",
			icon: Sparkles,
		},
		{
			id: "personalization" as const,
			label: "Personalization",
			description: "Set instructions Metis keeps in mind across new tasks.",
			icon: TuningSquare,
		},
		{
			id: "memory" as const,
			label: "Memory",
			description: "Configure long-term memory and review recent changes.",
			icon: Database,
		},
		{
			id: "agentTypes" as const,
			label: "Agent types",
			description: "Review built-in subagents and configure custom ones.",
			icon: Robot,
		},
		{
			id: "permissions" as const,
			label: "Permissions",
			description: "Control which simple commands Auto mode can run without review.",
			icon: ShieldCheck,
		},
		{
			id: "browser" as const,
			label: "Browser",
			description: "Import browser data and manage history and downloads.",
			icon: Browser,
		},
	];
	const activePageId = page === "usage" ? "profile" : page;
	const activePage = pages.find((item) => item.id === activePageId) ?? pages[0]!;

	return (
		<div
			className={`settings-backdrop ${closing ? "is-closing" : ""}`}
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) triggerClose();
			}}
		>
			<div
				aria-label={t("Settings")}
				aria-modal="true"
				className="settings-dialog"
				data-platform={api.platform}
				ref={dialogRef}
				role="dialog"
			>
				<aside className="settings-navigation" data-platform={api.platform}>
					<div className="settings-navigation-top" />
					<div className="settings-navigation-actions">
						<button
							aria-label={t("Back to app")}
							className="settings-back-button"
							onClick={triggerClose}
							type="button"
						>
							<ArrowLeft aria-hidden="true" size={16} />
							<span>{t("Back to app")}</span>
						</button>
					</div>
					<div className="settings-nav-divider" />
					<nav aria-label={t("Settings pages")}>
						{pages.map(({ id, label, icon: Icon }) => {
							const isActive = page === id || (id === "profile" && page === "usage");
							return (
								<button
									aria-current={isActive ? "page" : undefined}
									className={`settings-nav-item ${isActive ? "active" : ""}`}
									key={id}
									onClick={() => {
										navigate(id);
									}}
									ref={id === "profile" ? firstNavRef : undefined}
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
						</div>
					</header>
					<div className={`settings-page-scroll settings-page-scroll-${page}`} ref={pageScrollRef}>
						<div className="settings-page-mount" key={page}>
							{page === "general" ? (
								<GeneralPanel
									api={api}
									generalPreferences={generalPreferences}
									onDirtyChange={setDirty}
									onGeneralPreferencesChange={onGeneralPreferencesChange}
									onThemeChange={onThemeChange}
									serverReady={serverReady}
									theme={theme}
								/>
							) : null}
							{page === "model" ? (
								<ModelSettingsPanel api={api} onDirtyChange={setDirty} serverReady={serverReady} />
							) : null}
							{page === "personalization" ? (
								<PersonalizationPanel onDirtyChange={setDirty} api={api} serverReady={serverReady} />
							) : null}
							{page === "memory" ? (
								<MemorySettingsPanel
									api={api}
									onDirtyChange={setDirty}
									serverReady={serverReady}
									sessionId={sessionId}
									theme={theme === "light" ? "light" : "dark"}
								/>
							) : null}
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
				{pendingDestination && (
					<dialog
						aria-labelledby="settings-unsaved-title"
						aria-describedby="settings-unsaved-copy"
						className="settings-unsaved-dialog"
						onKeyDown={(event) => trapDialogTab(event, event.currentTarget)}
						onCancel={(event) => {
							event.preventDefault();
							setPendingDestination(null);
						}}
						ref={unsavedDialog}
					>
						<h2 id="settings-unsaved-title">{t("Unsaved changes")}</h2>
						<p id="settings-unsaved-copy">
							{t("Your changes have not been saved. Keep editing to save them, or discard them to leave.")}
						</p>
						<div className="settings-form-actions">
							<button
								className="settings-primary-button"
								onClick={() => setPendingDestination(null)}
								type="button"
							>
								{t("Keep editing")}
							</button>
							<button
								className="settings-secondary-button"
								onClick={() => {
									const target = pendingDestination;
									setPendingDestination(null);
									setDirty(false);
									if (target === "close") finishClose();
									else setPage(target);
								}}
								type="button"
							>
								{t("Discard changes")}
							</button>
						</div>
					</dialog>
				)}
			</div>
		</div>
	);
}
