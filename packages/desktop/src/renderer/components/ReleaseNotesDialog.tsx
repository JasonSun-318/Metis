import { type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { DesktopChangelog } from "../../shared/desktop-api.ts";
import { BellRing, X } from "../icons.tsx";
import "../styles/release-notes.css";
import { DialogFrame } from "./DialogFrame.tsx";
import { Markdown } from "./Markdown.tsx";

export const RELEASE_NOTES_READ_VERSION_STORAGE_KEY = "metis.release-notes-read-version.v1";

interface ReleaseNotesDialogProps {
	readonly loadChangelog: () => Promise<DesktopChangelog>;
	readonly availableVersion?: string | null;
	readonly variant?: "icon" | "menu";
	readonly returnFocusRef?: RefObject<HTMLElement | null>;
	readonly onOpen?: () => void;
	readonly onUnreadChange?: (unread: boolean) => void;
}

type ChangelogLoader = ReleaseNotesDialogProps["loadChangelog"];

const changelogCache = new WeakMap<ChangelogLoader, DesktopChangelog>();
const changelogLoads = new WeakMap<ChangelogLoader, Promise<DesktopChangelog>>();

function isNewerVersion(version: string | null, previous: string | null): boolean {
	return version !== null && (previous === null || version.localeCompare(previous, "en", { numeric: true }) > 0);
}

function loadReleaseNotes(loadChangelog: ChangelogLoader, force: boolean): Promise<DesktopChangelog> {
	if (!force) {
		const cached = changelogCache.get(loadChangelog);
		if (cached) return Promise.resolve(cached);
		const pending = changelogLoads.get(loadChangelog);
		if (pending) return pending;
	}
	const task = loadChangelog().then(
		(changelog) => {
			if (changelogLoads.get(loadChangelog) === task) {
				changelogCache.set(loadChangelog, changelog);
				changelogLoads.delete(loadChangelog);
			}
			return changelog;
		},
		(error: unknown) => {
			if (changelogLoads.get(loadChangelog) === task) changelogLoads.delete(loadChangelog);
			throw error;
		},
	);
	changelogLoads.set(loadChangelog, task);
	return task;
}

export function ReleaseNotesDialog({
	loadChangelog,
	availableVersion = null,
	variant = "icon",
	returnFocusRef,
	onOpen,
	onUnreadChange,
}: ReleaseNotesDialogProps) {
	const { t } = useTranslation();
	const [changelog, setChangelog] = useState<DesktopChangelog | null>(null);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [readVersion, setReadVersion] = useState<string | null>(() => {
		try {
			return localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY);
		} catch {
			return null;
		}
	});
	const [open, setOpen] = useState(false);
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
	const id = useId();
	const titleId = `${id}-title`;
	const descriptionId = `${id}-description`;
	const selectedRelease =
		changelog?.releases.find((release) => release.version === selectedVersion) ?? changelog?.releases[0];
	const displayedVersion = selectedRelease?.version ?? null;
	const latestVersion = changelog?.releases[0]?.version ?? null;
	const unread = isNewerVersion(latestVersion, readVersion) || isNewerVersion(availableVersion, readVersion);
	const mountedRef = useRef(true);
	const loadTaskRef = useRef<Promise<void> | null>(null);
	useEffect(() => {
		onUnreadChange?.(unread);
	}, [onUnreadChange, unread]);

	const refresh = useCallback(
		(force = false) => {
			if (!force && loadTaskRef.current) return loadTaskRef.current;
			if (mountedRef.current) {
				setLoading(true);
				setFailed(false);
			}
			const task = loadReleaseNotes(loadChangelog, force)
				.then((next) => {
					if (mountedRef.current && loadTaskRef.current === task) setChangelog(next);
				})
				.catch(() => {
					if (mountedRef.current && loadTaskRef.current === task) setFailed(true);
				})
				.finally(() => {
					if (loadTaskRef.current === task) loadTaskRef.current = null;
					if (mountedRef.current && loadTaskRef.current === null) setLoading(false);
				});
			loadTaskRef.current = task;
			return task;
		},
		[loadChangelog],
	);

	useEffect(() => {
		mountedRef.current = true;
		// Update discovery must bypass history cached before this version was published.
		const cachedVersion = changelogCache.get(loadChangelog)?.releases[0]?.version ?? null;
		void refresh(isNewerVersion(availableVersion, cachedVersion));
		return () => {
			mountedRef.current = false;
		};
	}, [availableVersion, loadChangelog, refresh]);

	useEffect(() => {
		// Only acknowledge displayed history, never a version known solely from the updater.
		if (!open || !displayedVersion || !isNewerVersion(displayedVersion, readVersion)) return;
		setReadVersion(displayedVersion);
		try {
			localStorage.setItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY, displayedVersion);
		} catch {
			// Keep the release read for this renderer lifetime when persistence is unavailable.
		}
	}, [displayedVersion, open, readVersion]);

	const triggerRef = useRef<HTMLButtonElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const readerRef = useRef<HTMLElement>(null);
	const close = useCallback(() => setOpen(false), []);
	useLayoutEffect(() => {
		if (!open) return;
		return () => {
			const target = (returnFocusRef ?? triggerRef).current;
			if (target?.isConnected) target.focus({ preventScroll: true });
		};
	}, [open, returnFocusRef]);
	// Each version starts at its heading; background refreshes keep the reading position.
	// biome-ignore lint/correctness/useExhaustiveDependencies(displayedVersion): A version change resets the reading pane.
	useLayoutEffect(() => {
		if (readerRef.current) readerRef.current.scrollTop = 0;
	}, [displayedVersion]);

	const toggle = () => {
		if (open) {
			close();
			return;
		}
		setSelectedVersion(null);
		setOpen(true);
		onOpen?.();
		void refresh(true);
	};

	return (
		<div
			className={variant === "menu" ? "release-notes-control release-notes-menu-control" : "release-notes-control"}
		>
			<button
				aria-description={variant === "menu" && unread ? t("Unread notifications") : undefined}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={t(
					variant === "menu" ? "Notifications" : unread ? "Open unread release notes" : "Open release notes",
				)}
				className={variant === "menu" ? "account-menu-item account-menu-notifications" : "release-notes-trigger"}
				onClick={toggle}
				ref={triggerRef}
				role={variant === "menu" ? "menuitem" : undefined}
				title={t(
					variant === "menu" ? "Notifications" : unread ? "Open unread release notes" : "Open release notes",
				)}
				type="button"
			>
				<BellRing aria-hidden="true" size={17} />
				{variant === "menu" && <span>{t("Notifications")}</span>}
				{unread && (
					<span
						aria-hidden="true"
						className={variant === "menu" ? "account-menu-item-dot" : "release-notes-unread-dot"}
					/>
				)}
			</button>
			{open &&
				createPortal(
					<DialogFrame
						cancellable
						className="release-notes-dialog"
						descriptionId={descriptionId}
						initialFocus={closeButtonRef}
						onCancel={close}
						titleId={titleId}
					>
						<header className="release-notes-header">
							<div>
								<h2 id={titleId}>{t("What's new")}</h2>
								<p id={descriptionId}>{t("Browse updates and release history.")}</p>
							</div>
							<button
								aria-label={t("Close release notes")}
								className="release-notes-close"
								onClick={close}
								ref={closeButtonRef}
								type="button"
							>
								<X aria-hidden="true" size={18} />
							</button>
						</header>
						<div className="release-notes-layout">
							<nav aria-label={t("Release versions")} className="release-notes-versions">
								{changelog?.releases.map((release, index) => (
									<button
										aria-current={release.version === displayedVersion ? "page" : undefined}
										aria-label={`${t("Version")} ${release.version}`}
										className="release-notes-version"
										key={release.version}
										onClick={() => setSelectedVersion(release.version)}
										type="button"
									>
										<span>
											{t("Version")} {release.version}
										</span>
										{index === 0 && <small>{t("Latest")}</small>}
									</button>
								))}
							</nav>
							<section
								aria-label={
									selectedRelease
										? t("Release notes for {{version}}", { version: selectedRelease.version })
										: t("What's new")
								}
								className="release-notes-reader"
								ref={readerRef}
								// biome-ignore lint/a11y/noNoninteractiveTabindex: Long release notes need a keyboard scrolling target.
								tabIndex={0}
							>
								{loading && !changelog && (
									<output className="status-paragraph release-notes-status">
										{t("Loading release notes...")}
									</output>
								)}
								{failed && (
									<div className="release-notes-error" role="alert">
										<p>{t("Could not load release notes. Check your connection and try again.")}</p>
										<button disabled={loading} onClick={() => void refresh(true)} type="button">
											{t("Retry")}
										</button>
									</div>
								)}
								{!loading && !failed && !selectedRelease && (
									<output className="status-paragraph release-notes-status">
										{t("No release notes are available yet.")}
									</output>
								)}
								{selectedRelease && (
									<article>
										<h3>
											{t("Version")} {selectedRelease.version}
											{selectedRelease.version === latestVersion && <small>{t("Latest")}</small>}
										</h3>
										<div className="release-notes-markdown">
											<Markdown text={selectedRelease.notes} />
										</div>
									</article>
								)}
							</section>
						</div>
					</DialogFrame>,
					document.body,
				)}
		</div>
	);
}
