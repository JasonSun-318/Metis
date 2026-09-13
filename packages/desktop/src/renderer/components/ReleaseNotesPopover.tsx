import { BellSimple, CaretDown, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopChangelog } from "../../shared/desktop-api.ts";
import { Markdown } from "./Markdown.tsx";

export const RELEASE_NOTES_READ_VERSION_STORAGE_KEY = "metis.release-notes-read-version.v1";

interface ReleaseNotesPopoverProps {
	readonly loadChangelog: () => Promise<DesktopChangelog>;
}

function ReleaseNotesEntry({
	latest,
	notes,
	version,
}: {
	readonly latest: boolean;
	readonly notes: string;
	readonly version: string;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(latest);
	return (
		<details
			className="release-notes-release"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
			open={expanded}
		>
			<summary>
				<span>{t("Version")} {version}</span>
				{latest && <small>{t("Latest")}</small>}
				<CaretDown aria-hidden="true" size={14} />
			</summary>
			<div className="release-notes-markdown"><Markdown text={notes} /></div>
		</details>
	);
}

export function ReleaseNotesPopover({ loadChangelog }: ReleaseNotesPopoverProps) {
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
	const latestVersion = changelog?.releases[0]?.version ?? null;
	const unread = latestVersion !== null && latestVersion !== readVersion;
	const mountedRef = useRef(true);
	const loadTaskRef = useRef<Promise<void> | null>(null);

	const refresh = useCallback(() => {
		if (loadTaskRef.current) return loadTaskRef.current;
		if (mountedRef.current) {
			setLoading(true);
			setFailed(false);
		}
		const task = loadChangelog()
			.then((next) => {
				if (mountedRef.current) setChangelog(next);
			})
			.catch(() => {
				if (mountedRef.current) setFailed(true);
			})
			.finally(() => {
				if (loadTaskRef.current === task) loadTaskRef.current = null;
				if (mountedRef.current) setLoading(false);
			});
		loadTaskRef.current = task;
		return task;
	}, [loadChangelog]);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		return () => {
			mountedRef.current = false;
		};
	}, [refresh]);

	useEffect(() => {
		if (!open || !latestVersion || latestVersion === readVersion) return;
		setReadVersion(latestVersion);
		try {
			localStorage.setItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY, latestVersion);
		} catch {
			// Keep the release read for this renderer lifetime when persistence is unavailable.
		}
	}, [latestVersion, open, readVersion]);

	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => setOpen(false), []);

	useEffect(() => {
		if (!open) return;
		closeButtonRef.current?.focus();
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			if (triggerRef.current?.isConnected) triggerRef.current.focus();
		};
	}, [close, open]);

	const toggle = () => {
		if (open) {
			close();
			return;
		}
		setOpen(true);
		void refresh();
	};

	return (
		<div className="release-notes-control" ref={rootRef}>
			<button
				aria-controls="release-notes-popover"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={t(unread ? "Open unread release notes" : "Open release notes")}
				className="release-notes-trigger"
				onClick={toggle}
				ref={triggerRef}
				title={t(unread ? "Open unread release notes" : "Open release notes")}
				type="button"
			>
				<BellSimple aria-hidden="true" size={17} />
				{unread && <span aria-hidden="true" className="release-notes-unread-dot" />}
			</button>
			{open && (
				<section
					aria-labelledby="release-notes-title"
					className="release-notes-popover"
					id="release-notes-popover"
					role="dialog"
				>
					<header>
						<strong id="release-notes-title">{t("What's new")}</strong>
						<button aria-label={t("Close release notes")} className="release-notes-close" onClick={close} ref={closeButtonRef} type="button">
							<X aria-hidden="true" size={16} />
						</button>
					</header>
					<div className="release-notes-body">
						{loading && !changelog && <p className="release-notes-status" role="status">{t("Loading release notes...")}</p>}
						{failed && <p className="release-notes-status is-error" role="alert">{t("Could not load release notes. Check your connection and try again.")}</p>}
						{!loading && !failed && (!changelog || changelog.releases.length === 0) && <p className="release-notes-status" role="status">{t("No release notes are available yet.")}</p>}
						{changelog?.releases.map((release, index) => (
							<ReleaseNotesEntry
								key={release.version}
								latest={index === 0}
								notes={release.notes}
								version={release.version}
							/>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
