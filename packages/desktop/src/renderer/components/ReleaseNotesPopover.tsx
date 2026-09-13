import { BellSimple, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopUpdateState } from "../../shared/desktop-api.ts";
import { Markdown } from "./Markdown.tsx";

export const RELEASE_NOTES_READ_VERSION_STORAGE_KEY = "metis.release-notes-read-version.v1";

interface ReleaseNotesPopoverProps {
	readonly checking: boolean;
	readonly checkFailure: "failed" | "unsupported" | null;
	readonly onCheck: () => void;
	readonly onUpdate: () => void;
	readonly state: DesktopUpdateState;
}

export function ReleaseNotesPopover({
	checking,
	checkFailure,
	onCheck,
	onUpdate,
	state,
}: ReleaseNotesPopoverProps) {
	const { t } = useTranslation();
	const release = "version" in state
		? { version: state.version, releaseNotes: state.releaseNotes }
		: null;
	const [readVersion, setReadVersion] = useState<string | null>(() => {
		try {
			return localStorage.getItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY);
		} catch {
			return null;
		}
	});
	const [open, setOpen] = useState(false);
	const unread = release !== null && release.version !== readVersion;

	useEffect(() => {
		if (!open || !release || release.version === readVersion) return;
		setReadVersion(release.version);
		try {
			localStorage.setItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY, release.version);
		} catch {
			// Keep the release read for this renderer lifetime when persistence is unavailable.
		}
	}, [open, readVersion, release]);

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
		onCheck();
	};

	const statusText = checking || state.status === "checking"
		? t("Checking for updates")
		: checkFailure === "unsupported"
			? t("Update checks are not supported in this build")
			: checkFailure === "failed"
				? t("Could not check for updates. Check your connection and try again.")
				: t("Metis is up to date");
	const updateLabel = state.status === "available"
		? t("Update to new version")
		: state.status === "downloading"
			? t("Downloading update {{progress}}%", { progress: state.progress })
			: state.status === "ready"
				? t("Open installer")
				: null;

	return (
		<div className="release-notes-control" ref={rootRef}>
			<button
				aria-busy={checking}
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
					{release ? (
						<div className="release-notes-body">
							<p className="release-notes-version">{t("Version")} {release.version}</p>
							{release.releaseNotes
								? <Markdown text={release.releaseNotes} />
								: <p>{t("Release notes are unavailable for this version.")}</p>}
						</div>
					) : (
						<p
							className={`release-notes-status${checkFailure === "failed" ? " is-error" : ""}`}
							role={checkFailure === "failed" ? "alert" : "status"}
						>
							{statusText}
						</p>
					)}
					{updateLabel && (
						<footer className="release-notes-actions">
							<button
								aria-label={updateLabel}
								className="release-notes-update-button"
								disabled={state.status === "downloading"}
								onClick={onUpdate}
								type="button"
							>
								{updateLabel}
							</button>
						</footer>
					)}
				</section>
			)}
		</div>
	);
}
