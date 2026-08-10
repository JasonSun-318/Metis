import { ChartBar, Cpu, UserCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { ModelSettingsPanel } from "./ModelSettingsPanel.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";
import { UsagePanel } from "./UsagePanel.tsx";

type SettingsPage = "profile" | "model" | "usage";

export function SettingsDialog({ api, onClose, serverReady }: {
	readonly api: MetisDesktopApi;
	readonly onClose: () => void;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [page, setPage] = useState<SettingsPage>("profile");
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
		{ id: "profile" as const, label: "Profile", icon: UserCircle },
		{ id: "model" as const, label: "Model", icon: Cpu },
		{ id: "usage" as const, label: "Usage", icon: ChartBar },
	];
	return (
		<div className="settings-backdrop">
			<div aria-label={t("Settings")} aria-modal="true" className="settings-dialog" ref={dialogRef} role="dialog">
				<aside className="settings-navigation">
					<span className="settings-navigation-label">{t("Settings")}</span>
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
						<button aria-label={t("Close settings")} onClick={onClose} type="button"><X aria-hidden="true" size={20} /></button>
					</header>
					<div className={`settings-page-scroll settings-page-scroll-${page}`} ref={pageScrollRef}>
						{page === "profile" ? <ProfilePanel api={api} serverReady={serverReady} /> : null}
						{page === "model" ? <ModelSettingsPanel api={api} serverReady={serverReady} /> : null}
						{page === "usage" ? <UsagePanel api={api} serverReady={serverReady} /> : null}
					</div>
				</div>
			</div>
		</div>
	);
}
