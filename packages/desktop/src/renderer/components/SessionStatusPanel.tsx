import type { SessionStatusView } from "@metis/app-protocol";
import { X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { contextFillPercent, formatContextTokens } from "../context-usage.ts";

interface SessionStatusPanelProps {
	readonly error?: string;
	readonly loading: boolean;
	readonly onClose: () => void;
	readonly status?: SessionStatusView;
}

export function SessionStatusPanel({ error, loading, onClose, status }: SessionStatusPanelProps) {
	const { t } = useTranslation();
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [onClose]);

	const fill = status ? contextFillPercent(status) : null;
	const tokensLine =
		status && status.contextTokens !== null && status.contextWindow !== null
			? t("~{{used}} / {{total}} Tokens", {
					used: formatContextTokens(status.contextTokens),
					total: formatContextTokens(status.contextWindow),
				})
			: null;

	return (
		<div aria-label={t("Session status")} className="session-status-panel" ref={rootRef} role="dialog">
			<header>
				<strong>{t("Context Usage")}</strong>
				<button aria-label={t("Close status")} onClick={onClose} type="button"><X aria-hidden="true" size={16} /></button>
			</header>
			{loading ? <p className="session-status-message" role="status">{t("Loading session status…")}</p> : error ? (
				<p className="session-status-message is-error" role="alert">{t(error)}</p>
			) : status ? (
				<>
					<p className="context-usage-summary">
						<span>{fill == null ? "—" : t("{{percent}}% Full", { percent: Math.round(fill) })}</span>
						<span>{tokensLine ?? "—"}</span>
					</p>
					<div aria-hidden="true" className="context-usage-bar">
						<div className="context-usage-bar-fill" style={{ width: `${fill ?? 0}%` }} />
					</div>
					{status.cacheHitPercent !== null && (
						<p className="context-usage-cache">{t("Cache hit rate")} {Math.round(status.cacheHitPercent)}%</p>
					)}
				</>
			) : null}
		</div>
	);
}
