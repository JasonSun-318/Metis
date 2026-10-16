import type { SessionStatusView } from "@metis/app-protocol";
import { Info, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { contextFillPercent, contextUsagePercent, formatContextTokens } from "../context-usage.ts";

interface SessionStatusPanelProps {
	readonly closing?: boolean;
	readonly error?: string;
	readonly loading: boolean;
	readonly onClose: () => void;
	readonly status?: SessionStatusView;
}

export function SessionStatusPanel({ closing = false, error, loading, onClose, status }: SessionStatusPanelProps) {
	const { t } = useTranslation();
	const [cacheInfoOpen, setCacheInfoOpen] = useState(false);
	const [cacheInfoHovered, setCacheInfoHovered] = useState(false);
	const cacheInfoId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeButtonRef.current?.focus();
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && rootRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest('[aria-controls="session-status-panel"]')) return;
			onClose();
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
			if (previousFocus?.isConnected) previousFocus.focus();
		};
	}, [onClose]);

	const fill = status ? contextFillPercent(status) : null;
	const usagePercent = status ? contextUsagePercent(status) : null;
	const cacheHitPercent =
		status?.cacheHitPercent == null ? null : Math.max(0, Math.min(100, Math.round(status.cacheHitPercent * 10) / 10));
	const breakdown = status?.contextBreakdown ?? [];
	const categoryLabels: Record<(typeof breakdown)[number]["category"], string> = {
		system_prompt: "System prompt",
		tool_definitions: "Tool definitions",
		rules: "Rules",
		skills: "Skills",
		mcp_dynamic_tools: "MCP & dynamic tools",
		agent_definitions: "Agent definitions",
		summarized_conversation: "Summarized conversation",
		conversation: "Conversation",
	};
	const tokensLine =
		status && status.contextTokens !== null && status.contextWindow !== null
			? t("~{{used}} / {{total}} Tokens", {
					used: formatContextTokens(status.contextTokens),
					total: formatContextTokens(status.contextWindow),
				})
			: null;

	return (
		<div
			aria-labelledby="session-status-title"
			className={`session-status-panel${closing ? " is-closing" : ""}`}
			id="session-status-panel"
			ref={rootRef}
			role="dialog"
		>
			<header>
				<strong id="session-status-title">{t("Context Usage")}</strong>
				<button aria-label={t("Close status")} onClick={onClose} ref={closeButtonRef} type="button">
					<X aria-hidden="true" size={16} />
				</button>
			</header>
			{loading ? (
				<output className="status-paragraph session-status-message">{t("Loading session status…")}</output>
			) : error ? (
				<p className="session-status-message is-error" role="alert">
					{t(error)}
				</p>
			) : status ? (
				<>
					<p className="context-usage-summary">
						<span>
							{usagePercent == null
								? "—"
								: t("{{percent}}% Full", { percent: Math.round(usagePercent * 10) / 10 })}
						</span>
						<span>{tokensLine ?? "—"}</span>
					</p>
					<div aria-hidden="true" className="context-usage-bar">
						<div className="context-usage-bar-used" style={{ width: `${fill ?? 0}%` }}>
							{breakdown.map((item) => (
								<span
									className="context-usage-segment"
									data-category={item.category}
									key={item.category}
									style={{ flexGrow: item.tokens }}
								/>
							))}
						</div>
					</div>
					{usagePercent !== null && usagePercent > 100 && (
						<p className="context-usage-overflow">{t("Context exceeded")}</p>
					)}
					{status.contextBasis === "unavailable" ? (
						<p className="context-usage-basis">{t("Context usage unavailable")}</p>
					) : status.contextBreakdown === null ? (
						<p className="context-usage-basis">{t("Context breakdown unavailable")}</p>
					) : (
						<>
							<p className="context-usage-basis">
								{t(
									status.contextBasis === "reported_total"
										? "Current context, including history. Total based on reported usage; category shares are estimates of used tokens."
										: "Current context, including history. Token counts and category shares are estimates of used tokens.",
								)}
							</p>
							<ul className="context-usage-breakdown">
								{breakdown.map((item) => (
									<li data-category={item.category} key={item.category}>
										<span aria-hidden="true" className="context-usage-swatch" />
										<span className="context-usage-breakdown-name">{t(categoryLabels[item.category])}</span>
										<span className="context-usage-breakdown-value">~{formatContextTokens(item.tokens)}</span>
										<span className="context-usage-breakdown-percent">
											{status.contextTokens && `${((item.tokens / status.contextTokens) * 100).toFixed(1)}%`}
										</span>
									</li>
								))}
							</ul>
						</>
					)}
					<div className="context-usage-cache">
						<div className="context-usage-cache-heading">
							<span>{t("Cache hit rate")}</span>
							<small>{t("Latest completed request")}</small>
							<span className="context-usage-cache-info">
								<button
									type="button"
									aria-label={t("About cache hit rate")}
									aria-describedby={cacheInfoId}
									onMouseEnter={() => setCacheInfoHovered(true)}
									onMouseLeave={() => setCacheInfoHovered(false)}
									onFocus={() => setCacheInfoOpen(true)}
									onBlur={() => setCacheInfoOpen(false)}
									onClick={() => setCacheInfoOpen(true)}
									onKeyDown={(event) => {
										if (event.key === "Escape" && (cacheInfoOpen || cacheInfoHovered)) {
											event.stopPropagation();
											setCacheInfoOpen(false);
											setCacheInfoHovered(false);
										}
									}}
								>
									<Info aria-hidden="true" size={13} />
								</button>
								<p id={cacheInfoId} role="tooltip" hidden={!cacheInfoOpen && !cacheInfoHovered}>
									{t(
										cacheHitPercent === null
											? "Cache usage not reported for a completed request on this model."
											: "Cached input / total input for one model request; output tokens are excluded.",
									)}
								</p>
							</span>
						</div>
						<span className="context-usage-cache-value">
							{cacheHitPercent === null ? "—" : `${cacheHitPercent}%`}
						</span>
					</div>
				</>
			) : null}
		</div>
	);
}
