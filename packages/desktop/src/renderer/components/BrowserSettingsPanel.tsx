import {
	ArrowCounterClockwise,
	ArrowLeft,
	ArrowSquareOut,
	CaretDown,
	ClockCounterClockwise,
	DownloadSimple,
	FolderOpen,
	MagnifyingGlass,
	Pause,
	Play,
	Trash,
	X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserImportResult,
	type DesktopBrowserProfile,
	type DesktopDownloadControlType,
	type DesktopDownloadItem,
	type DesktopHistoryEntry,
	type MetisDesktopApi,
} from "../../shared/desktop-api.ts";
import { browserProfileLabel, formatBrowserBytes } from "../browser-display.ts";
import { BrowserImportDialog } from "./BrowserImportDialog.tsx";
import { MenuSelect } from "./MenuSelect.tsx";

type BrowserSettingsView = "overview" | "history" | "downloads";

function HistoryClearDialog({ busy, onCancel, onConfirm }: {
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	const { t } = useTranslation();
	const dialogRef = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialogRef.current?.showModal?.();
		return () => dialogRef.current?.close?.();
	}, []);
	return (
		<dialog
			aria-labelledby="browser-settings-clear-title"
			className="browser-settings-confirm"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onCancel();
			}}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
			ref={dialogRef}
		>
			<div>
				<h2 id="browser-settings-clear-title">{t("Clear browsing history?")}</h2>
				<p>{t("This permanently removes history from the selected Metis browser profile.")}</p>
				<footer>
					<button className="settings-secondary-button" disabled={busy} onClick={onCancel} type="button">{t("Cancel")}</button>
					<button aria-label={t("Confirm clear browsing history")} className="settings-danger-button" disabled={busy} onClick={onConfirm} type="button">
						{t(busy ? "Clearing…" : "Clear history")}
					</button>
				</footer>
			</div>
		</dialog>
	);
}

function DownloadRow({ download, onAction }: {
	readonly download: DesktopDownloadItem;
	readonly onAction: (type: DesktopDownloadControlType, downloadId: string) => void;
}) {
	const { t } = useTranslation();
	const percent = download.totalBytes > 0
		? Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100))
		: null;
	const size = download.totalBytes > 0
		? `${formatBrowserBytes(download.receivedBytes)} / ${formatBrowserBytes(download.totalBytes)}`
		: formatBrowserBytes(download.receivedBytes);
	const state = download.state === "progressing"
		? t("Downloading")
		: download.state === "paused"
			? t("Paused")
			: download.state === "completed"
				? t("Completed")
				: download.state === "cancelled"
					? t("Cancelled")
					: t("Download failed");
	return (
		<li className="browser-settings-download" data-download-state={download.state}>
			<div className="browser-settings-download-copy">
				<strong title={download.filename}>{download.filename}</strong>
				<span>{size} · {state}{percent !== null && download.state === "progressing" ? ` · ${percent}%` : ""}</span>
			</div>
			<div className="browser-settings-download-actions">
				{download.state === "progressing" && <button aria-label={t("Pause download")} onClick={() => onAction("pause", download.downloadId)} type="button"><Pause aria-hidden="true" size={14} /></button>}
				{download.state === "paused" && <button aria-label={t("Resume download")} onClick={() => onAction("resume", download.downloadId)} type="button"><Play aria-hidden="true" size={14} /></button>}
				{(download.state === "progressing" || download.state === "paused") && <button aria-label={t("Cancel download")} onClick={() => onAction("cancel", download.downloadId)} type="button"><X aria-hidden="true" size={14} /></button>}
				{download.state === "completed" && <button aria-label={t("Open file")} onClick={() => onAction("open", download.downloadId)} type="button"><ArrowSquareOut aria-hidden="true" size={14} /></button>}
				{download.state === "completed" && <button aria-label={t("Show in folder")} onClick={() => onAction("reveal", download.downloadId)} type="button"><FolderOpen aria-hidden="true" size={14} /></button>}
				{(download.state === "interrupted" || download.state === "cancelled") && <button aria-label={t("Retry download")} onClick={() => onAction("retry", download.downloadId)} type="button"><ArrowCounterClockwise aria-hidden="true" size={14} /></button>}
				<button aria-label={t("Remove from list")} onClick={() => onAction("remove", download.downloadId)} type="button"><Trash aria-hidden="true" size={14} /></button>
			</div>
			{(download.state === "progressing" || download.state === "paused") && (
				<div aria-hidden="true" className="browser-settings-download-progress"><i style={{ width: `${percent ?? 0}%` }} /></div>
			)}
		</li>
	);
}

export function BrowserSettingsPanel({ api }: { readonly api: MetisDesktopApi }) {
	const { i18n, t } = useTranslation();
	const [view, setView] = useState<BrowserSettingsView>("overview");
	const [profiles, setProfiles] = useState<readonly DesktopBrowserProfile[]>([]);
	const [selectedProfileId, setSelectedProfileId] = useState(DEFAULT_BROWSER_PROFILE_ID);
	const selectedProfileIdRef = useRef(selectedProfileId);
	const [history, setHistory] = useState<readonly DesktopHistoryEntry[]>([]);
	const [downloads, setDownloads] = useState<readonly DesktopDownloadItem[]>([]);
	const [downloadDirectory, setDownloadDirectory] = useState("");
	const [search, setSearch] = useState("");
	const [expandedHistoryDates, setExpandedHistoryDates] = useState<ReadonlySet<string>>(new Set());
	const [loading, setLoading] = useState(true);
	const [historyLoading, setHistoryLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const [clearing, setClearing] = useState(false);

	useEffect(() => { selectedProfileIdRef.current = selectedProfileId; }, [selectedProfileId]);

	useEffect(() => {
		let active = true;
		void Promise.allSettled([
			api.listBrowserProfiles(),
			api.listBrowserDownloads(),
			api.getBrowserDownloadDirectory(),
		]).then(([profileResult, downloadResult, directoryResult]) => {
			if (!active) return;
			if (profileResult.status === "fulfilled") {
				setProfiles(profileResult.value);
				if (!profileResult.value.some(({ profileId }) => profileId === selectedProfileIdRef.current)) {
					setSelectedProfileId(profileResult.value[0]?.profileId ?? DEFAULT_BROWSER_PROFILE_ID);
				}
			}
			if (downloadResult.status === "fulfilled") setDownloads(downloadResult.value);
			if (directoryResult.status === "fulfilled") setDownloadDirectory(directoryResult.value);
			if ([profileResult, downloadResult, directoryResult].some(({ status }) => status === "rejected")) {
				setError(t("Browser settings could not be loaded"));
			}
			setLoading(false);
		});
		const unsubscribe = api.subscribeBrowser((event) => {
			if (!active) return;
			if (event.type === "profiles") setProfiles(event.profiles);
			if (event.type === "downloads") setDownloads(event.downloads);
			if (event.type === "history" && event.profileId === selectedProfileIdRef.current) setHistory(event.entries);
		});
		return () => { active = false; unsubscribe(); };
	}, [api, t]);

	useEffect(() => {
		let active = true;
		setHistoryLoading(true);
		void api.listBrowserHistory({ profileId: selectedProfileId }).then(
			(entries) => { if (active) { setHistory(entries); setHistoryLoading(false); } },
			() => { if (active) { setError(t("Browser settings could not be loaded")); setHistoryLoading(false); } },
		);
		return () => { active = false; };
	}, [api, selectedProfileId, t]);

	const filteredHistory = useMemo(() => {
		const query = search.trim().toLocaleLowerCase();
		return query === "" ? history : history.filter((entry) =>
			entry.title.toLocaleLowerCase().includes(query) || entry.url.toLocaleLowerCase().includes(query));
	}, [history, search]);
	const groupedHistory = useMemo(() => {
		const formatter = new Intl.DateTimeFormat(i18n.language, { year: "numeric", month: "long", day: "numeric" });
		const groups = new Map<string, DesktopHistoryEntry[]>();
		for (const entry of filteredHistory) {
			const label = formatter.format(entry.visitedAt);
			groups.set(label, [...(groups.get(label) ?? []), entry]);
		}
		return [...groups.entries()];
	}, [filteredHistory, i18n.language]);

	useEffect(() => {
		if (search.trim() !== "" || groupedHistory.length === 0) return;
		setExpandedHistoryDates((current) =>
			current.size === 0 ? new Set([groupedHistory[0]![0]]) : current,
		);
	}, [groupedHistory, search]);

	const refreshProfiles = async (result?: DesktopBrowserImportResult) => {
		const next = await api.listBrowserProfiles();
		setProfiles(next);
		if (result) setSelectedProfileId(result.profile.profileId);
	};

	const onImported = (result: DesktopBrowserImportResult) => {
		setImportOpen(false);
		const parts = [
			result.cookies ? t("{{count}} Cookies imported", { count: result.cookies.imported }) : null,
			result.history ? t("{{count}} history entries retained", { count: result.history.retained }) : null,
		].filter(Boolean);
		setNotice(parts.join(" · "));
		void refreshProfiles(result).catch(() => setError(t("Browser settings could not be loaded")));
	};

	const runDownloadAction = async (type: DesktopDownloadControlType, downloadId: string) => {
		setError(null);
		try {
			await api.controlBrowserDownload({ type, downloadId });
			setDownloads(await api.listBrowserDownloads());
		} catch {
			setError(t("Browser action failed"));
		}
	};

	const clearHistory = async () => {
		setClearing(true);
		setError(null);
		try {
			await api.clearBrowserHistory({ profileId: selectedProfileId });
			setHistory([]);
			setConfirmClear(false);
			setNotice(t("Browsing history cleared"));
		} catch {
			setError(t("Browser action failed"));
		} finally {
			setClearing(false);
		}
	};

	if (view === "history") {
		return (
			<div className="settings-page browser-settings-page browser-settings-detail">
				<div className="browser-settings-detail-header">
					<button aria-label={t("Back to browser settings")} className="browser-settings-back" onClick={() => setView("overview")} type="button"><ArrowLeft aria-hidden="true" size={15} />{t("Browser")}</button>
					<div><h2>{t("Browsing history")}</h2><p>{t("Search and manage pages visited in the selected Metis browser profile.")}</p></div>
				</div>
				<div className="browser-settings-toolbar">
					<label className="browser-settings-search">
						<MagnifyingGlass aria-hidden="true" size={15} />
						<input aria-label={t("Search browsing history")} onChange={(event) => setSearch(event.target.value)} placeholder={t("Search browsing history")} value={search} />
					</label>
					<MenuSelect
						ariaLabel={t("Browser profile")}
						className="browser-settings-profile-select"
						onChange={(value) => {
							setSearch("");
							setExpandedHistoryDates(new Set());
							setSelectedProfileId(value);
						}}
						options={profiles.map((profile) => ({ value: profile.profileId, label: browserProfileLabel(profile, t("Default profile")) }))}
						value={selectedProfileId}
					/>
					<button aria-label={t("Clear browsing history")} className="settings-danger-button" disabled={history.length === 0 || historyLoading} onClick={() => setConfirmClear(true)} type="button">{t("Clear history")}</button>
				</div>
				{error && <p className="settings-inline-error" role="alert">{error}</p>}
				{notice && <p className="settings-action-message" role="status">{notice}</p>}
				{historyLoading ? <div className="browser-settings-state" role="status">{t("Loading browsing history…")}</div> : groupedHistory.length === 0 ? (
					<div className="browser-settings-state"><ClockCounterClockwise aria-hidden="true" size={24} /><strong>{t(search.trim() ? "No matching history" : "No history yet")}</strong></div>
				) : (
					<div className="browser-settings-history-groups">
						{groupedHistory.map(([date, entries]) => {
							const expanded = search.trim() !== "" || expandedHistoryDates.has(date);
							return <section className="browser-settings-history-group" key={date}>
								<h3>
									<button
										aria-expanded={expanded}
										onClick={() => setExpandedHistoryDates((current) => {
											const next = new Set(current);
											if (next.has(date)) next.delete(date);
											else next.add(date);
											return next;
										})}
										type="button"
									>
										<span>{date}</span>
										<span>{t("{{count}} visits", { count: entries.length })}</span>
										<CaretDown aria-hidden="true" size={13} />
									</button>
								</h3>
								{expanded && <ul>{entries.map((entry) => (
									<li key={entry.entryId}>
										<span className="browser-settings-history-icon"><ClockCounterClockwise aria-hidden="true" size={14} /></span>
										<div><strong>{entry.title}</strong><span title={entry.url}>{entry.url}</span></div>
										<time dateTime={new Date(entry.visitedAt).toISOString()}>{new Date(entry.visitedAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}</time>
									</li>
								))}</ul>}
							</section>;
						})}
					</div>
				)}
				{confirmClear && <HistoryClearDialog busy={clearing} onCancel={() => setConfirmClear(false)} onConfirm={() => void clearHistory()} />}
			</div>
		);
	}

	if (view === "downloads") {
		return (
			<div className="settings-page browser-settings-page browser-settings-detail">
				<div className="browser-settings-detail-header">
					<button aria-label={t("Back to browser settings")} className="browser-settings-back" onClick={() => setView("overview")} type="button"><ArrowLeft aria-hidden="true" size={15} />{t("Browser")}</button>
					<div><h2>{t("Current-run downloads")}</h2><p>{t("Manage files downloaded by the built-in browser during this app run.")}</p></div>
				</div>
				{error && <p className="settings-inline-error" role="alert">{error}</p>}
				{notice && <p className="settings-action-message" role="status">{notice}</p>}
				{downloads.length === 0 ? (
					<div className="browser-settings-state"><DownloadSimple aria-hidden="true" size={24} /><strong>{t("No downloads in this run")}</strong></div>
				) : <ul className="browser-settings-download-list">{downloads.map((item) => <DownloadRow download={item} key={item.downloadId} onAction={(type, id) => void runDownloadAction(type, id)} />)}</ul>}
			</div>
		);
	}

	return (
		<div className="settings-page browser-settings-page">
			{error && <p className="settings-inline-error" role="alert">{error}</p>}
			{notice && <p className="settings-action-message" role="status">{notice}</p>}
			<section className="settings-section">
				<header className="settings-section-heading"><div><h3>{t("Browser data")}</h3><p>{t("Bring in existing sessions and manage profile-specific history.")}</p></div></header>
				<div className="settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy"><span>{t("Import browser data")}</span><p>{t("Import Cookies and browsing history from a supported Chromium profile.")}</p></div>
						<div className="general-setting-control"><button aria-label={t("Import browser data")} className="settings-secondary-button" onClick={() => setImportOpen(true)} type="button">{t("Import…")}</button></div>
					</div>
					<div className="general-setting-row">
						<div className="general-setting-copy"><span>{t("Browsing history")}</span><p>{t("View and clear up to the newest 500 entries for each isolated browser profile.")}</p><small>{loading ? t("Loading…") : t("{{count}} profiles · {{count2}} entries in selected profile", { count: profiles.length, count2: history.length })}</small></div>
						<div className="general-setting-control"><button aria-label={t("Manage browsing history")} className="settings-secondary-button" onClick={() => setView("history")} type="button">{t("Manage")}</button></div>
					</div>
				</div>
			</section>
			<section className="settings-section">
				<header className="settings-section-heading"><div><h3>{t("Downloads")}</h3><p>{t("Use the system Downloads folder and manage this run's download tasks.")}</p></div></header>
				<div className="settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy"><span>{t("System Downloads folder")}</span><p>{t("The built-in browser currently saves files to the system Downloads folder.")}</p>{downloadDirectory && <small className="browser-settings-path" title={downloadDirectory}>{downloadDirectory}</small>}</div>
						<div className="general-setting-control"><button aria-label={t("Open Downloads folder")} className="settings-secondary-button" disabled={!downloadDirectory} onClick={() => void api.openBrowserDownloadDirectory().catch(() => setError(t("Browser action failed")))} type="button">{t("Open")}</button></div>
					</div>
					<div className="general-setting-row">
						<div className="general-setting-copy"><span>{t("Current-run downloads")}</span><p>{t("View progress and manage files retained during this app run.")}</p><small>{t("{{count}} downloads", { count: downloads.length })}</small></div>
						<div className="general-setting-control"><button aria-label={t("Manage downloads")} className="settings-secondary-button" onClick={() => setView("downloads")} type="button">{t("Manage")}</button></div>
					</div>
				</div>
			</section>
			{importOpen && <BrowserImportDialog api={api} onCancel={() => setImportOpen(false)} onImported={onImported} />}
		</div>
	);
}
