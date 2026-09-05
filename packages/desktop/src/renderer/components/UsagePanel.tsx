import type { UsageDailyView, UsageRangeDays, UsageSummaryView } from "@metis/app-protocol";
import { ChartBar, Rows } from "@phosphor-icons/react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { localeForIntl } from "../i18n.ts";

type UsageDisplay = "chart" | "table";

function dayTotal(day: UsageDailyView): number {
	return day.chatTokens + day.codeTokens;
}

export function UsagePanel({ api, serverReady }: {
	readonly api: Pick<MetisDesktopApi, "getUsage">;
	readonly serverReady: boolean;
}) {
	const { t, i18n } = useTranslation();
	const locale = localeForIntl(i18n.resolvedLanguage);
	const [rangeDays, setRangeDays] = useState<UsageRangeDays>(30);
	const [display, setDisplay] = useState<UsageDisplay>("chart");
	const [usage, setUsage] = useState<UsageSummaryView | null>(null);
	const [hovered, setHovered] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const activeSelectedRef = useRef<UsageDailyView | null>(null);
	const activeLeftRef = useRef<number>(50);
	const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale]);
	const full = useMemo(() => new Intl.NumberFormat(locale), [locale]);
	const date = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }), [locale]);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.getUsage({ rangeDays }).then(
			(result) => { if (current) { setUsage(result); setHovered(null); } },
			(cause) => { if (current) setError(cause instanceof Error ? cause.message : t("Usage could not be loaded.")); },
		);
		return () => { current = false; };
	}, [api, rangeDays, serverReady, t]);

	if (!usage && !error) return <div aria-label={t("Loading usage")} className="settings-loading" role="status" />;
	if (!usage) return <p className="settings-inline-error" role="alert">{error}</p>;
	const peak = Math.max(1, ...usage.daily.map(dayTotal));
	const selected = hovered === null ? null : usage.daily[hovered] ?? null;
	if (selected && usage.daily.length > 0) {
		activeSelectedRef.current = selected;
		activeLeftRef.current = Math.min(88, Math.max(12, ((hovered! + 0.5) / usage.daily.length) * 100));
	}
	const displaySelected = selected ?? activeSelectedRef.current;
	const displayLeft = selected && usage.daily.length > 0
		? Math.min(88, Math.max(12, ((hovered! + 0.5) / usage.daily.length) * 100))
		: activeLeftRef.current;
	const modeShare = usage.totalTokens === 0 ? 0 : Math.round((usage.codeTokens / usage.totalTokens) * 100);

	return (
		<section className="settings-page usage-page">
			<div className="usage-toolbar">
				<p>{t("Local token usage across Chat and Code on this device.")}</p>
				<div aria-label={t("Usage range")} className="settings-segmented">
					{([7, 30, 90] as const).map((days) => (
						<button aria-pressed={rangeDays === days} key={days} onClick={() => setRangeDays(days)} type="button">
							{days}d
						</button>
					))}
				</div>
			</div>

			<div className="usage-summary-cards">
				<article className="usage-metric-card">
					<div className="usage-metric-header">
						<span>{t("Chat")}</span>
						<span className="usage-metric-badge chat">{full.format(usage.chatSessionCount)} {t("sessions")}</span>
					</div>
					<strong>{compact.format(usage.chatTokens)}</strong>
					<small>{t("{{count}} sessions", { count: full.format(usage.chatSessionCount) })}</small>
				</article>
				<article className="usage-metric-card">
					<div className="usage-metric-header">
						<span>{t("Code")}</span>
						<span className="usage-metric-badge code">{full.format(usage.codeSessionCount)} {t("sessions")}</span>
					</div>
					<strong>{compact.format(usage.codeTokens)}</strong>
					<small>{t("{{count}} sessions", { count: full.format(usage.codeSessionCount) })}</small>
				</article>
			</div>

			<section className="settings-card usage-chart-card">
				<header className="usage-chart-header">
					<div>
						<h2>{t("Tokens per day")}</h2>
						<p>{t("Input and output tokens by mode, last {{count}} days", { count: rangeDays })}</p>
					</div>
					<div aria-label={t("Usage view")} className="usage-view-toggle">
						<button aria-label={t("Chart view")} aria-pressed={display === "chart"} onClick={() => setDisplay("chart")} type="button">
							<ChartBar aria-hidden="true" size={18} />
						</button>
						<button aria-label={t("Table view")} aria-pressed={display === "table"} onClick={() => setDisplay("table")} type="button">
							<Rows aria-hidden="true" size={18} />
						</button>
					</div>
				</header>
				<div className="usage-legend">
					<span><i className="chat" />{t("Chat")}</span>
					<span><i className="code" />{t("Code")}</span>
				</div>
				{display === "chart" ? (
					<div className="usage-chart-wrap">
						<div
							aria-label={t("Daily token chart")}
							className="usage-chart"
							key={rangeDays}
							onMouseLeave={() => setHovered(null)}
							onPointerLeave={() => setHovered(null)}
							role="img"
						>
							{usage.daily.map((day, index) => {
								const chatHeight = (day.chatTokens / peak) * 100;
								const codeHeight = (day.codeTokens / peak) * 100;
								return (
									<span
										className={`usage-bar ${hovered === index ? "active" : ""}`}
										key={day.date}
										onMouseEnter={() => setHovered(index)}
										onPointerEnter={() => setHovered(index)}
										style={{ "--bar-index": index } as CSSProperties}
									>
										<i className="code" style={{ height: `${codeHeight}%` }} />
										<i className="chat" style={{ height: `${chatHeight}%` }} />
									</span>
								);
							})}
						</div>
						<div className="usage-chart-axis">
							<span>{date.format(new Date(`${usage.daily[0]!.date}T12:00:00`))}</span>
							<span>{date.format(new Date(`${usage.daily[Math.floor(usage.daily.length / 2)]!.date}T12:00:00`))}</span>
							<span>{date.format(new Date(`${usage.daily.at(-1)!.date}T12:00:00`))}</span>
						</div>
						{displaySelected ? (
							<div
								className={`usage-tooltip ${hovered !== null && selected !== null ? "is-visible" : ""}`}
								role="status"
								style={{ left: `${displayLeft}%` }}
							>
								<strong>{date.format(new Date(`${displaySelected.date}T12:00:00`))}</strong>
								<span><i className="chat" />{full.format(displaySelected.chatTokens)} {t("Chat")}</span>
								<span><i className="code" />{full.format(displaySelected.codeTokens)} {t("Code")}</span>
							</div>
						) : null}
					</div>
				) : (
					<div className="usage-table-wrap">
						<table>
							<thead>
								<tr>
									<th>{t("Date")}</th>
									<th>{t("Chat")}</th>
									<th>{t("Code")}</th>
									<th>{t("Total")}</th>
								</tr>
							</thead>
							<tbody>
								{[...usage.daily].reverse().map((day) => (
									<tr key={day.date}>
										<td>{date.format(new Date(`${day.date}T12:00:00`))}</td>
										<td>{full.format(day.chatTokens)}</td>
										<td>{full.format(day.codeTokens)}</td>
										<td>{full.format(dayTotal(day))}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<div className="usage-details-grid">
				<section className="settings-card usage-detail-card">
					<h2>{t("Token composition")}</h2>
					<dl>
						<div><dt>{t("Input")}</dt><dd>{compact.format(usage.inputTokens)}</dd></div>
						<div><dt>{t("Output")}</dt><dd>{compact.format(usage.outputTokens)}</dd></div>
						<div><dt>{t("Cache read")}</dt><dd>{compact.format(usage.cacheReadTokens)}</dd></div>
						<div><dt>{t("Cache write")}</dt><dd>{compact.format(usage.cacheWriteTokens)}</dd></div>
					</dl>
				</section>
				<section className="settings-card usage-detail-card">
					<h2>{t("Usage insights")}</h2>
					<dl>
						<div><dt>{t("Total Tokens")}</dt><dd>{compact.format(usage.totalTokens)}</dd></div>
						<div><dt>{t("Sessions")}</dt><dd>{full.format(usage.sessionCount)}</dd></div>
						<div><dt>{t("Code share")}</dt><dd>{modeShare}%</dd></div>
					</dl>
				</section>
				<section className="settings-card usage-detail-card">
					<h2>{t("Top models")}</h2>
					{usage.topModels.length === 0 ? (
						<p>{t("Model usage will appear after you complete a task.")}</p>
					) : (
						<ol>
							{usage.topModels.map((model) => (
								<li key={`${model.provider}/${model.modelId}`}>
									<span><strong>{model.modelId}</strong><small>{model.provider}</small></span>
									<b>{compact.format(model.totalTokens)}</b>
								</li>
							))}
						</ol>
					)}
				</section>
			</div>
			{error ? <p className="settings-action-message error" role="alert">{error}</p> : null}
		</section>
	);
}
