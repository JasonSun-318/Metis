import type { ProfileUsageSummaryView } from "@arcmind/app-protocol";
import { ArrowClockwise, Sparkle } from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArcMindDesktopApi } from "../../shared/desktop-api.ts";
import { localeForIntl } from "../i18n.ts";

const DAY_MS = 86_400_000;
const VISIBLE_WEEKS = 53;

interface ActivityCell {
	readonly date: string;
	readonly tokens: number;
	readonly future: boolean;
}

export interface ActivityWeek {
	readonly days: readonly ActivityCell[];
	readonly month: string | null;
}

function dateParts(value: string): [number, number, number] {
	const [year, month, day] = value.split("-").map(Number);
	return [year!, month!, day!];
}

function dayNumber(value: string): number {
	const [year, month, day] = dateParts(value);
	return Math.trunc(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateKey(value: Date): string {
	return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function dateFromDayNumber(value: number): Date {
	const date = new Date(value * DAY_MS);
	return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function buildActivityWeeks(profile: ProfileUsageSummaryView, locale: "en-US" | "zh-CN" = "en-US"): readonly ActivityWeek[] {
	const monthName = new Intl.DateTimeFormat(locale, { month: "short" });
	const today = dateKey(new Date(profile.generatedAt));
	const todayDay = dayNumber(today);
	const firstDay = todayDay - new Date(profile.generatedAt).getDay() - (VISIBLE_WEEKS - 1) * 7;
	const tokensByDate = new Map(profile.activity.map((day) => [day.date, day.tokens]));
	const weeks = Array.from({ length: VISIBLE_WEEKS }, (_, weekIndex) => {
		const days = Array.from({ length: 7 }, (_, weekday) => {
			const value = firstDay + weekIndex * 7 + weekday;
			const date = dateKey(dateFromDayNumber(value));
			return { date, tokens: tokensByDate.get(date) ?? 0, future: value > todayDay };
		});
		const monthStart = days.find((day) => dateParts(day.date)[2] === 1 && !day.future);
		return { days, month: monthStart ? monthName.format(dateFromDayNumber(dayNumber(monthStart.date))) : null };
	});
	const labeledWeeks = weeks.flatMap((week, index) => week.month ? [index] : []);
	for (const index of labeledWeeks.slice(0, -12)) weeks[index] = { ...weeks[index]!, month: null };
	return weeks;
}

export function formatDuration(durationMs: number, locale: "en-US" | "zh-CN" = "en-US"): string {
	const minutes = Math.floor(durationMs / 60_000);
	if (minutes < 60) return locale === "zh-CN" ? `${minutes}分钟` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remaining = minutes % 60;
	if (locale === "zh-CN") return remaining > 0 ? `${hours}小时${remaining}分钟` : `${hours}小时`;
	return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

function formatDays(days: number, locale: "en-US" | "zh-CN", number: Intl.NumberFormat): string {
	return locale === "zh-CN" ? `${number.format(days)} 天` : `${number.format(days)} ${days === 1 ? "day" : "days"}`;
}

function intensity(tokens: number, peak: number): number {
	if (tokens <= 0 || peak <= 0) return 0;
	return Math.min(4, Math.max(1, Math.ceil((tokens / peak) * 4)));
}

function ProfileLoading() {
	const { t } = useTranslation();
	return (
		<div aria-label={t("Loading personal profile")} className="profile-loading" role="status">
			<span className="profile-loading-avatar" />
			<span className="profile-loading-line profile-loading-title" />
			<span className="profile-loading-line" />
			<div className="profile-loading-card" />
			<div className="profile-loading-chart" />
		</div>
	);
}

export function ProfilePanel({ api, serverReady }: {
	readonly api: Pick<ArcMindDesktopApi, "getProfile">;
	readonly serverReady: boolean;
}) {
	const { t, i18n } = useTranslation();
	const locale = localeForIntl(i18n.resolvedLanguage);
	const compactNumber = useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale]);
	const fullNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);
	const fullDate = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
	const [profile, setProfile] = useState<ProfileUsageSummaryView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [request, setRequest] = useState(0);

	const load = useCallback(() => setRequest((current) => current + 1), []);
	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.getProfile().then(
			(result) => { if (current) setProfile(result); },
			(cause) => { if (current) setError(cause instanceof Error ? cause.message : "Personal profile could not be loaded."); },
		);
		return () => { current = false; };
	}, [api, request, serverReady]);

	const weeks = useMemo(() => profile ? buildActivityWeeks(profile, locale) : [], [locale, profile]);
	if (!profile && !error) return <section className="profile-panel"><ProfileLoading /></section>;
	if (!profile) {
		return (
			<section className="profile-panel">
				<div className="profile-error" role="alert">
					<h1>{t("Couldn’t load your profile")}</h1>
					<p>{error === "Personal profile could not be loaded." ? t(error) : error}</p>
					<button disabled={!serverReady} onClick={load} type="button"><ArrowClockwise aria-hidden="true" size={16} />{t("Retry")}</button>
				</div>
			</section>
		);
	}

	const stats = [
		[compactNumber.format(profile.totalTokens), "Total Tokens"],
		[compactNumber.format(profile.peakDailyTokens), "Peak daily Tokens"],
		[formatDuration(profile.longestSessionMs, locale), "Longest chat"],
		[formatDays(profile.currentStreakDays, locale, fullNumber), "Current streak"],
		[formatDays(profile.longestStreakDays, locale, fullNumber), "Longest streak"],
	] as const;
	const mode = profile.mostUsedMode
		? `${t(profile.mostUsedMode === "chat" ? "Chat" : "Code")} · ${profile.mostUsedModePercent}%`
		: "—";
	const thinkingLabels = {
		off: "Off",
		minimal: "Minimal",
		low: "Low",
		medium: "Medium",
		high: "High",
		xhigh: "XHigh",
		max: "Max",
	} as const;
	const thinking = profile.mostUsedThinkingLevel
		? `${t(thinkingLabels[profile.mostUsedThinkingLevel])} · ${profile.mostUsedThinkingLevelPercent}%`
		: "—";
	return (
		<section className="profile-panel">
			<div className="profile-scroll">
				<div className="profile-content">
					<header className="profile-identity">
						<span className="profile-eyebrow">{t("Personal profile")}</span>
						<span aria-hidden="true" className="profile-avatar">A</span>
						<h1>{t("ArcMind User")}</h1>
						<p>{t("Local profile")}</p>
					</header>
					<div aria-label={t("Usage summary")} className="profile-stats">
						{stats.map(([value, label]) => <div key={label}><strong>{value}</strong><span>{t(label)}</span></div>)}
					</div>
					<section className="profile-activity">
						<div className="profile-section-heading">
							<div><span>{t("Token activity")}</span><small>{t("Last 53 weeks")}</small></div>
							<span>{t("Daily")}</span>
						</div>
						<div aria-label={t("Daily Token activity")} className="profile-heatmap-scroll">
							<div className="profile-heatmap">
								{weeks.map((week, index) => (
									<div className="profile-heatmap-week" key={week.days[0]?.date ?? index}>
										{week.days.map((day) => day.future ? <span className="profile-heatmap-future" key={day.date} /> : (
											<span
												aria-label={t("{{date}}: {{tokens}} Tokens", { date: fullDate.format(dateFromDayNumber(dayNumber(day.date))), tokens: fullNumber.format(day.tokens) })}
												className="profile-heatmap-cell"
												data-level={intensity(day.tokens, profile.peakDailyTokens)}
												data-tooltip={t("{{date}} · {{tokens}} Tokens", { date: fullDate.format(dateFromDayNumber(dayNumber(day.date))), tokens: fullNumber.format(day.tokens) })}
												key={day.date}
												style={{ "--profile-cell-index": index } as CSSProperties}
											/>
										))}
										{week.month && <small>{week.month}</small>}
									</div>
								))}
							</div>
						</div>
					</section>
					<div className="profile-details">
						<section>
							<h2>{t("Activity insights")}</h2>
							<dl>
								<div><dt>{t("Most used mode")}</dt><dd>{mode}</dd></div>
								<div><dt>{t("Most used reasoning effort")}</dt><dd>{thinking}</dd></div>
								<div><dt>{t("Skills explored")}</dt><dd>{fullNumber.format(profile.usedSkillCount)}</dd></div>
								<div><dt>{t("Skill uses")}</dt><dd>{fullNumber.format(profile.skillUseCount)}</dd></div>
								<div><dt>{t("Chats")}</dt><dd>{fullNumber.format(profile.sessionCount)}</dd></div>
							</dl>
						</section>
						<section>
							<h2>{t("Most used Skills")}</h2>
							{profile.topSkills.length === 0 ? <p className="profile-skills-empty">{t("Skill activity will appear after you use a Skill.")}</p> : (
								<ol className="profile-skill-list">
									{profile.topSkills.map((skill) => <li key={skill.name}><Sparkle aria-hidden="true" size={15} /><strong>{skill.name}</strong><span>{t(skill.count === 1 ? "{{count}} use" : "{{count}} uses", { count: fullNumber.format(skill.count) })}</span></li>)}
								</ol>
							)}
						</section>
					</div>
				</div>
			</div>
		</section>
	);
}
