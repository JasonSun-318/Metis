import type { ProfileUsageSummaryView } from "@metis/app-protocol";
import { ArrowClockwise, Camera, PencilSimple, Sparkle, Trash } from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { localeForIntl } from "../i18n.ts";
import {
	DEFAULT_PROFILE_IDENTITY,
	type ProfileIdentity,
	saveProfileIdentity,
	useProfileIdentity,
} from "../profile-identity.ts";
import { UsagePanel } from "./UsagePanel.tsx";

const DAY_MS = 86_400_000;
const VISIBLE_WEEKS = 53;
const MAX_AVATAR_BYTES = 2_000_000;
const MAX_AVATAR_DIMENSION = 256;
const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

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

export function buildActivityWeeks(
	profile: ProfileUsageSummaryView,
	locale: "en-US" | "zh-CN" = "en-US",
): readonly ActivityWeek[] {
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
	const labeledWeeks = weeks.flatMap((week, index) => (week.month ? [index] : []));
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

function formatActivityTokens(tokens: number, compact: Intl.NumberFormat): string {
	return tokens < 10_000 ? String(tokens) : compact.format(tokens);
}

function ProfileLoading() {
	const { t } = useTranslation();
	return (
		<output aria-label={t("Loading personal profile")} className="status-block profile-loading">
			<span className="profile-loading-avatar" />
			<span className="profile-loading-line profile-loading-title" />
			<span className="profile-loading-line" />
			<div className="profile-loading-card" />
			<div className="profile-loading-chart" />
		</output>
	);
}

export function ProfilePanel({
	api,
	initialTab = "activity",
	onTabChange,
	serverReady,
}: {
	readonly api: Pick<MetisDesktopApi, "getProfile"> & Partial<Pick<MetisDesktopApi, "getUsage">>;
	readonly initialTab?: "activity" | "usage";
	readonly onTabChange?: (tab: "activity" | "usage") => void;
	readonly serverReady: boolean;
}) {
	const { t, i18n } = useTranslation();
	const locale = localeForIntl(i18n.resolvedLanguage);
	const compactNumber = useMemo(
		() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }),
		[locale],
	);
	const fullNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);
	const fullDate = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
	const [activeTab, setActiveTab] = useState<"activity" | "usage">(initialTab);
	const [profile, setProfile] = useState<ProfileUsageSummaryView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [request, setRequest] = useState(0);
	const identity = useProfileIdentity();
	const [editingName, setEditingName] = useState(false);
	const nameInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (editingName) nameInputRef.current?.focus();
	}, [editingName]);
	const [nameDraft, setNameDraft] = useState(identity.displayName);
	const [identityError, setIdentityError] = useState<string | null>(null);
	const avatarInputRef = useRef<HTMLInputElement>(null);

	const handleTabChange = (nextTab: "activity" | "usage") => {
		setActiveTab(nextTab);
		onTabChange?.(nextTab);
	};

	const load = useCallback(() => setRequest((current) => current + 1), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies(request): Retry explicitly reloads the personal profile.
	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.getProfile().then(
			(result) => {
				if (current) setProfile(result);
			},
			(cause) => {
				if (current) setError(cause instanceof Error ? cause.message : "Personal profile could not be loaded.");
			},
		);
		return () => {
			current = false;
		};
	}, [api, request, serverReady]);

	const weeks = useMemo(() => (profile ? buildActivityWeeks(profile, locale) : []), [locale, profile]);
	const saveIdentity = (next: ProfileIdentity) => {
		try {
			saveProfileIdentity(next);
			setIdentityError(null);
		} catch {
			setIdentityError(t("Profile could not be saved."));
		}
	};
	const saveDisplayName = () => {
		const displayName = nameDraft.trim().slice(0, 80) || DEFAULT_PROFILE_IDENTITY.displayName;
		setNameDraft(displayName);
		saveIdentity({ ...identity, displayName });
		setEditingName(false);
	};
	const selectAvatar = async (file: File | undefined) => {
		if (!file) return;
		if (!AVATAR_TYPES.has(file.type) || file.size > MAX_AVATAR_BYTES) {
			setIdentityError(t("Choose a PNG, JPEG, or WebP image under 2 MB."));
			return;
		}
		let bitmap: ImageBitmap | undefined;
		try {
			bitmap = await createImageBitmap(file);
			if (bitmap.width < 1 || bitmap.height < 1) throw new Error("Invalid avatar dimensions");
			const scale = Math.min(1, MAX_AVATAR_DIMENSION / Math.max(bitmap.width, bitmap.height));
			const width = Math.max(1, Math.round(bitmap.width * scale));
			const height = Math.max(1, Math.round(bitmap.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Avatar canvas is unavailable");
			context.drawImage(bitmap, 0, 0, width, height);
			const avatarDataUrl = canvas.toDataURL("image/webp", 0.86);
			if (!/^data:image\/(?:png|webp);base64,/u.test(avatarDataUrl)) throw new Error("Avatar encoding failed");
			saveIdentity({ ...identity, avatarDataUrl });
		} catch {
			setIdentityError(t("Profile image could not be saved."));
		} finally {
			bitmap?.close();
		}
	};
	if (!profile && !error)
		return (
			<section className="profile-panel">
				<ProfileLoading />
			</section>
		);
	if (!profile) {
		return (
			<section className="profile-panel">
				<div className="profile-error" role="alert">
					<h1>{t("Couldn’t load your profile")}</h1>
					<p>{error === "Personal profile could not be loaded." ? t(error) : error}</p>
					<button disabled={!serverReady} onClick={load} type="button">
						<ArrowClockwise aria-hidden="true" size={16} />
						{t("Retry")}
					</button>
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
						<div className="profile-identity-main">
							<div className="profile-avatar-actions">
								<button
									aria-label={t("Change avatar")}
									className="profile-avatar"
									onClick={() => avatarInputRef.current?.click()}
									type="button"
								>
									{identity.avatarDataUrl ? (
										<img alt="" src={identity.avatarDataUrl} />
									) : (
										<span aria-hidden="true">{identity.displayName.trim()[0]?.toUpperCase() ?? "A"}</span>
									)}
									<i aria-hidden="true">
										<Camera size={14} />
									</i>
								</button>
								{identity.avatarDataUrl ? (
									<button
										aria-label={t("Remove avatar")}
										className="profile-avatar-remove"
										onClick={() => saveIdentity({ ...identity, avatarDataUrl: null })}
										type="button"
									>
										<Trash aria-hidden="true" size={14} />
									</button>
								) : null}
								<input
									accept="image/png,image/jpeg,image/webp"
									hidden
									onChange={(event) => {
										void selectAvatar(event.target.files?.[0]);
										event.target.value = "";
									}}
									ref={avatarInputRef}
									type="file"
								/>
							</div>
							<div className="profile-identity-copy">
								<div className="profile-name-row">
									{editingName ? (
										<input
											aria-label={t("Display name")}
											ref={nameInputRef}
											maxLength={80}
											onBlur={saveDisplayName}
											onChange={(event) => setNameDraft(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter") event.currentTarget.blur();
												if (event.key === "Escape") {
													setNameDraft(identity.displayName);
													setEditingName(false);
												}
											}}
											value={nameDraft}
										/>
									) : (
										<h1>{identity.displayName}</h1>
									)}
									<button
										aria-label={t("Edit display name")}
										onClick={() => setEditingName(true)}
										type="button"
									>
										<PencilSimple aria-hidden="true" size={15} />
									</button>
								</div>
								<p>{t("Local profile")}</p>
								{identityError ? (
									<p className="profile-identity-error" role="alert">
										{identityError}
									</p>
								) : null}
							</div>
							<fieldset
								aria-label={t("Profile view")}
								className="control-group settings-segmented profile-tab-switch"
							>
								<button
									aria-pressed={activeTab === "activity"}
									onClick={() => handleTabChange("activity")}
									type="button"
								>
									{t("Activity")}
								</button>
								<button
									aria-pressed={activeTab === "usage"}
									onClick={() => handleTabChange("usage")}
									type="button"
								>
									{t("Usage")}
								</button>
							</fieldset>
						</div>
					</header>
					<section aria-label={t("Usage summary")} className="profile-stats">
						{stats.map(([value, label]) => (
							<div key={label}>
								<strong>{value}</strong>
								<span>{t(label)}</span>
							</div>
						))}
					</section>
					{activeTab === "activity" ? (
						<div className="profile-activity-view">
							<section className="profile-activity">
								<div className="profile-section-heading">
									<div>
										<span>{t("Token activity")}</span>
										<small>{t("Last 53 weeks")}</small>
									</div>
									<span>{t("Daily")}</span>
								</div>
								<section aria-label={t("Daily Token activity")} className="profile-heatmap-scroll">
									<div className="profile-heatmap">
										{weeks.map((week, index) => (
											<div className="profile-heatmap-week" key={week.days[0]?.date ?? index}>
												{week.days.map((day) => {
													if (day.future)
														return <span className="profile-heatmap-future" key={day.date} />;
													const tokens = formatActivityTokens(day.tokens, compactNumber);
													const date = fullDate.format(dateFromDayNumber(dayNumber(day.date)));
													return (
														<span
															role="img"
															aria-label={t("{{date}}: {{tokens}} Tokens", { date, tokens })}
															className="profile-heatmap-cell"
															data-level={intensity(day.tokens, profile.peakDailyTokens)}
															data-tooltip={t("{{date}} · {{tokens}} Tokens", { date, tokens })}
															key={day.date}
															style={{ "--profile-cell-index": index } as CSSProperties}
														/>
													);
												})}
												{week.month && <small>{week.month}</small>}
											</div>
										))}
									</div>
								</section>
							</section>
							<div className="profile-details">
								<section>
									<h2>{t("Activity insights")}</h2>
									<dl>
										<div>
											<dt>{t("Most used mode")}</dt>
											<dd>{mode}</dd>
										</div>
										<div>
											<dt>{t("Most used reasoning effort")}</dt>
											<dd>{thinking}</dd>
										</div>
										<div>
											<dt>{t("Skills explored")}</dt>
											<dd>{fullNumber.format(profile.usedSkillCount)}</dd>
										</div>
										<div>
											<dt>{t("Skill uses")}</dt>
											<dd>{fullNumber.format(profile.skillUseCount)}</dd>
										</div>
										<div>
											<dt>{t("Chats")}</dt>
											<dd>{fullNumber.format(profile.sessionCount)}</dd>
										</div>
									</dl>
								</section>
								<section>
									<h2>{t("Most used Skills")}</h2>
									{profile.topSkills.length === 0 ? (
										<p className="profile-skills-empty">
											{t("Skill activity will appear after you use a Skill.")}
										</p>
									) : (
										<ol className="profile-skill-list">
											{profile.topSkills.map((skill) => (
												<li key={skill.name}>
													<Sparkle aria-hidden="true" size={15} />
													<strong>{skill.name}</strong>
													<span>
														{t(skill.count === 1 ? "{{count}} use" : "{{count}} uses", {
															count: fullNumber.format(skill.count),
														})}
													</span>
												</li>
											))}
										</ol>
									)}
								</section>
							</div>
						</div>
					) : (
						<div className="profile-usage-view">
							{api.getUsage ? (
								<UsagePanel api={api as Pick<MetisDesktopApi, "getUsage">} serverReady={serverReady} />
							) : null}
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
