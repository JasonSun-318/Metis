import { ArrowLeft, ChartBar, Cpu, GearSix, UserCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { AppTheme } from "../theme.ts";
import { GeneralPanel } from "./GeneralPanel.tsx";
import { ModelSettingsPanel } from "./ModelSettingsPanel.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";
import { UsagePanel } from "./UsagePanel.tsx";

type SettingsPage = "general" | "profile" | "model" | "usage";

export function SettingsDialog({ api, onClose, onThemeChange, serverReady, theme }: {
	readonly api: MetisDesktopApi;
	readonly onClose: () => void;
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
		{ id: "general" as const, label: "General", icon: GearSix },
		{ id: "profile" as const, label: "Profile", icon: UserCircle },
		{ id: "model" as const, label: "Model", icon: Cpu },
		{ id: "usage" as const, label: "Usage", icon: ChartBar },
	];
	return (
		<div className="settings-backdrop">
			<div aria-label={t("Settings")} aria-modal="true" className="settings-dialog" ref={dialogRef} role="dialog">
				<aside className="settings-navigation">
					<button aria-label={t("Back to app")} className="settings-back-button" onClick={onClose} type="button">
						<ArrowLeft aria-hidden="true" size={18} />
						<span>{t("Back to app")}</span>
					</button>
					<nav aria-label={t("Settings pages")}>
						{pages.map(({ id, label, icon: Icon }, index) => (
							<button
								aria-current={page === id ? "page" : undefined}
								key={id}
								onClick={() => setPage(id)}
								ref={index === 0 ? firstNavRef : undefined}
								type="button"
							>
								<Icon aria-hidden="true" size={19} />
								<span>{t(label)}</span>
							</button>
						))}
					</nav>
				</aside>
				<div className="settings-main">
					<header className="settings-main-header">
						<h1>{t(pages.find((item) => item.id === page)!.label)}</h1>
					</header>
					<div className={`settings-page-scroll settings-page-scroll-${page}`} ref={pageScrollRef}>
						{page === "general" ? <GeneralPanel onThemeChange={onThemeChange} theme={theme} /> : null}
						{page === "profile" ? <ProfilePanel api={api} serverReady={serverReady} /> : null}
						{page === "model" ? <ModelSettingsPanel api={api} serverReady={serverReady} /> : null}
						{page === "usage" ? <UsagePanel api={api} serverReady={serverReady} /> : null}
					</div>
				</div>
			</div>
		</div>
	);
}
