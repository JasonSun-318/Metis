import type { SessionStatusView } from "@metis/app-protocol";
import { X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface SessionStatusPanelProps {
	readonly error?: string;
	readonly loading: boolean;
	readonly onClose: () => void;
	readonly status?: SessionStatusView;
}

function percent(value: number | null): string {
	return value === null ? "—" : `${Math.round(value)}%`;
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

	return (
		<div aria-label={t("Session status")} className="session-status-panel" ref={rootRef} role="dialog">
			<header>
				<strong>{t("Status")}</strong>
				<button aria-label={t("Close status")} onClick={onClose} type="button"><X aria-hidden="true" size={16} /></button>
			</header>
			{loading ? <p className="session-status-message" role="status">{t("Loading session status…")}</p> : error ? (
				<p className="session-status-message is-error" role="alert">{t(error)}</p>
			) : status ? (
				<dl>
					<div><dt>{t("Session ID")}</dt><dd>{status.sessionId}</dd></div>
					<div><dt>{t("Mode")}</dt><dd>{t(status.mode === "chat" ? "Chat" : "Code")}</dd></div>
					<div><dt>{t("Context")}</dt><dd>{status.contextTokens === null || status.contextWindow === null ? "—" : `${status.contextTokens.toLocaleString()} / ${status.contextWindow.toLocaleString()}`}</dd></div>
					<div><dt>{t("Remaining")}</dt><dd>{percent(status.remainingPercent)}</dd></div>
					<div><dt>{t("Cache hit rate")}</dt><dd>{percent(status.cacheHitPercent)}</dd></div>
				</dl>
			) : null}
		</div>
	);
}
