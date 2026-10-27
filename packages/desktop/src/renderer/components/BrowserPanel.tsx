import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	DesktopBrowserBounds,
	DesktopBrowserCommand,
	DesktopBrowserHandoffReason,
	DesktopBrowserProfile,
	DesktopBrowserSourceId,
	DesktopBrowserState,
	DesktopDownloadControlType,
	DesktopDownloadItem,
	DesktopHistoryEntry,
	MetisDesktopApi,
} from "../../shared/desktop-api.ts";
import { browserProfileLabel } from "../browser-display.ts";
import {
	ArrowClockwise,
	ArrowCounterClockwise,
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowSquareOut,
	ArrowUp,
	Camera,
	ClockCounterClockwise,
	DotsThreeVertical,
	DownloadSimple,
	Folder,
	Globe,
	MagnifyingGlass,
	Minus,
	Plus,
	Printer,
	Trash,
	User,
	X,
} from "../icons.tsx";
import { useModalPresence } from "../modal-presence.ts";
import { BrowserDownloadActions } from "./BrowserDownloadActions.tsx";
import { BrowserImportDialog } from "./BrowserImportDialog.tsx";
import { BrowserStartPage } from "./BrowserStartPage.tsx";
import { browserDownloadPresentation } from "./browser-download-presentation.ts";
import { MenuSelect } from "./MenuSelect.tsx";

type BrowserProfileChoice = Pick<DesktopBrowserProfile, "profileId" | "name"> & {
	readonly sourceId?: DesktopBrowserSourceId | null;
};

interface BrowserPanelProps {
	readonly api: MetisDesktopApi;
	readonly sessionId: string;
	readonly browserId: string;
	readonly controlState: "idle" | "agent" | "handoff";
	readonly handoffReason?: DesktopBrowserHandoffReason;
	readonly onError: (cause: unknown) => void;
	readonly onOpenProfile?: (profile: BrowserProfileChoice) => void;
	readonly onProfileImported: (profile: DesktopBrowserProfile) => void;
	readonly onState: (state: DesktopBrowserState) => void;
	readonly profile: BrowserProfileChoice;
	readonly profiles?: readonly BrowserProfileChoice[];
	readonly visible: boolean;
	/** A React menu covers the native page; retain its last frame underneath. */
	readonly covered?: boolean;
	readonly startPageTools?: ReactNode;
}

function formatHistoryTime(visitedAt: number): string {
	return new Date(visitedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function BrowserDownloadRow({
	download,
	onAction,
}: {
	readonly download: DesktopDownloadItem;
	readonly onAction: (type: DesktopDownloadControlType, downloadId: string) => void;
}) {
	const { t } = useTranslation();
	const { actions, percent, showProgress, showProgressPercent, size, stateLabel } = browserDownloadPresentation(
		download,
		t,
	);
	return (
		<div className="browser-download-row" data-download-state={download.state}>
			<div className="browser-download-main">
				<div className="browser-download-info">
					<span className="browser-download-name" title={download.filename}>
						{download.filename}
					</span>
					<span className="browser-download-meta">
						{size} · {stateLabel}
						{showProgressPercent ? ` · ${percent}%` : ""}
					</span>
				</div>
				<BrowserDownloadActions
					actions={actions}
					className="browser-download-actions"
					downloadId={download.downloadId}
					iconSize={12}
					menuItem
					onAction={onAction}
					revealIcon={Folder}
				/>
			</div>
			{showProgress && (
				<div aria-hidden="true" className="browser-download-progress">
					<i style={{ width: `${percent ?? 0}%` }} />
				</div>
			)}
		</div>
	);
}

const emptyState = (browserId: string, profileId: string): DesktopBrowserState => ({
	browserId,
	profileId,
	url: "",
	title: "New tab",
	faviconUrl: null,
	loading: false,
	canGoBack: false,
	canGoForward: false,
	zoomPercent: 100,
});

function BrowserClearDialog({
	busy,
	onCancel,
	onConfirm,
}: {
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
			aria-labelledby="browser-clear-title"
			className="browser-clear-dialog"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onCancel();
			}}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
			ref={dialogRef}
		>
			<form method="dialog">
				<h2 id="browser-clear-title">{t("Clear browsing data?")}</h2>
				<p>{t("This clears cookies and site data for the current browser profile. Open tabs will stay open.")}</p>
				<div className="browser-clear-actions">
					<button disabled={busy} onClick={onCancel} type="button">
						{t("Cancel")}
					</button>
					<button
						className="is-danger"
						data-browser-confirm-clear
						disabled={busy}
						onClick={onConfirm}
						type="button"
					>
						{t(busy ? "Clearing…" : "Clear data")}
					</button>
				</div>
			</form>
		</dialog>
	);
}

export function BrowserPanel({
	api,
	sessionId,
	browserId,
	controlState,
	handoffReason,
	onError,
	onOpenProfile,
	onProfileImported,
	onState,
	profile,
	profiles,
	visible,
	covered = false,
	startPageTools,
}: BrowserPanelProps) {
	const { t } = useTranslation();
	const modalPresent = useModalPresence();
	const availableProfiles = profiles ?? [profile];
	const currentProfile = availableProfiles.find((candidate) => candidate.profileId === profile.profileId) ?? profile;
	const profileLabel = (candidate: BrowserProfileChoice) =>
		browserProfileLabel({ name: candidate.name, sourceId: candidate.sourceId ?? null }, t("Default profile"));
	const [state, setState] = useState(() => emptyState(browserId, profile.profileId));
	const [address, setAddress] = useState("");
	const [status, setStatus] = useState<string | null>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const [previewBusy, setPreviewBusy] = useState(false);
	const [pagePreview, setPagePreview] = useState<string | null>(null);
	const [zoomBusy, setZoomBusy] = useState(false);
	const [zoomDraft, setZoomDraft] = useState("100");
	const [findOpen, setFindOpen] = useState(false);
	const [findText, setFindText] = useState("");
	const [findResult, setFindResult] = useState({ activeMatchOrdinal: 0, matches: 0 });
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [clearBusy, setClearBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [downloads, setDownloads] = useState<readonly DesktopDownloadItem[]>([]);
	const [downloadsOpen, setDownloadsOpen] = useState(false);
	const [downloadsStatus, setDownloadsStatus] = useState<"loading" | "ready" | "error">("loading");
	const [history, setHistory] = useState<readonly DesktopHistoryEntry[]>([]);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
	const [takeoverBusy, setTakeoverBusy] = useState(false);
	const [handoffBusy, setHandoffBusy] = useState(false);
	const takeoverBusyRef = useRef(false);
	const handoffBusyRef = useRef(false);
	const anchorRef = useRef<HTMLDivElement>(null);
	const handoffHeadingRef = useRef<HTMLHeadingElement>(null);
	const previousControlStateRef = useRef(controlState);
	const findInputRef = useRef<HTMLInputElement>(null);
	const addressInputRef = useRef<HTMLInputElement>(null);
	const focusAddressOnMount = useRef(visible && controlState === "idle");
	const moreRef = useRef<HTMLDivElement>(null);
	const downloadsRef = useRef<HTMLDivElement>(null);
	const historyRef = useRef<HTMLDivElement>(null);
	const presentationRef = useRef("");
	const boundsRef = useRef<DesktopBrowserBounds | null>(null);
	const presentRef = useRef<(() => void) | null>(null);
	const shouldPresentRef = useRef(false);
	const creationRef = useRef<Promise<DesktopBrowserState> | null>(null);
	const onErrorRef = useRef(onError);
	const onStateRef = useRef(onState);
	const translateRef = useRef(t);
	const visibleRef = useRef(visible);
	const coveredRef = useRef(covered);
	const pageUrlRef = useRef(state.url);
	const addressEditedRef = useRef(false);
	const moreOpenRef = useRef(moreOpen);
	const previewRequestRef = useRef(0);
	const zoomBusyRef = useRef(false);
	const downloadsRequestRef = useRef(0);
	const historyRequestRef = useRef(0);
	const downloadsEventVersionRef = useRef(0);
	const historyEventVersionRef = useRef(0);
	const downloadsRetryBusyRef = useRef(false);
	const historyRetryBusyRef = useRef(false);
	const profileIdRef = useRef(profile.profileId);
	const previousProfileIdRef = useRef(profile.profileId);
	onErrorRef.current = onError;
	onStateRef.current = onState;
	translateRef.current = t;
	visibleRef.current = visible;
	coveredRef.current = covered;
	pageUrlRef.current = state.url;
	moreOpenRef.current = moreOpen;
	profileIdRef.current = profile.profileId;
	useEffect(() => {
		if (focusAddressOnMount.current) addressInputRef.current?.focus();
	}, []);

	function closeDownloads() {
		previewRequestRef.current += 1;
		setDownloadsOpen(false);
	}

	function toggleDownloads() {
		if (downloadsOpen) {
			closeDownloads();
			return;
		}
		previewRequestRef.current += 1;
		setMoreOpen(false);
		setHistoryOpen(false);
		if (state.url === "") {
			setDownloadsOpen(true);
			return;
		}
		const request = ++previewRequestRef.current;
		setPreviewBusy(true);
		void (async () => {
			try {
				// ponytail: WebContentsView sits above React; use a static frame until a live native overlay is required.
				const preview = await capturePreview(request);
				if (preview) setPagePreview(preview);
				setDownloadsOpen(true);
			} catch (cause) {
				if (request !== previewRequestRef.current) return;
				setStatus(translateRef.current("Browser action failed"));
				onErrorRef.current(cause);
			} finally {
				if (request === previewRequestRef.current) setPreviewBusy(false);
			}
		})();
	}

	function runDownloadAction(type: DesktopDownloadControlType, downloadId: string) {
		setNotice(null);
		setStatus(null);
		void api.controlBrowserDownload({ type, downloadId }).catch((cause) => {
			setStatus(translateRef.current("Browser action failed"));
			onErrorRef.current(cause);
		});
	}

	function closeHistory() {
		previewRequestRef.current += 1;
		setHistoryOpen(false);
	}

	function toggleHistory() {
		if (historyOpen) {
			closeHistory();
			return;
		}
		previewRequestRef.current += 1;
		setMoreOpen(false);
		setDownloadsOpen(false);
		if (state.url === "") {
			setHistoryOpen(true);
			return;
		}
		const request = ++previewRequestRef.current;
		setPreviewBusy(true);
		void (async () => {
			try {
				// ponytail: WebContentsView sits above React; use a static frame until a live native overlay is required.
				const preview = await capturePreview(request);
				if (preview) setPagePreview(preview);
				setHistoryOpen(true);
			} catch (cause) {
				if (request !== previewRequestRef.current) return;
				setStatus(translateRef.current("Browser action failed"));
				onErrorRef.current(cause);
			} finally {
				if (request === previewRequestRef.current) setPreviewBusy(false);
			}
		})();
	}

	function openHistoryEntry(url: string) {
		closeHistory();
		setStatus(null);
		void api.controlBrowser({ type: "navigate", sessionId, browserId, url }).catch((cause) => {
			setStatus(t("Browser could not load this page"));
			onErrorRef.current(cause);
		});
	}

	function clearBrowserHistoryEntries() {
		setStatus(null);
		void api.clearBrowserHistory({ profileId: profile.profileId }).catch((cause) => {
			setStatus(translateRef.current("Browser action failed"));
			onErrorRef.current(cause);
		});
	}

	async function capturePreview(request: number): Promise<string | null> {
		const preview = await api.captureBrowserPreview({ sessionId, browserId });
		const image = new Image();
		image.src = preview;
		await image.decode?.();
		return request === previewRequestRef.current && visibleRef.current ? preview : null;
	}

	function toggleMore() {
		if (moreOpen) {
			previewRequestRef.current += 1;
			setMoreOpen(false);
			return;
		}
		closeDownloads();
		closeHistory();
		if (state.url === "") {
			setMoreOpen(true);
			return;
		}
		const request = ++previewRequestRef.current;
		setPreviewBusy(true);
		void (async () => {
			try {
				// ponytail: WebContentsView sits above React; use a static frame until a live native overlay is required.
				const preview = await capturePreview(request);
				if (!preview) return;
				setPagePreview(preview);
				setMoreOpen(true);
			} catch (cause) {
				if (request !== previewRequestRef.current) return;
				setStatus(translateRef.current("Browser action failed"));
				onErrorRef.current(cause);
			} finally {
				if (request === previewRequestRef.current) setPreviewBusy(false);
			}
		})();
	}

	function runZoomAction(
		action:
			| { readonly type: "zoom-in" | "zoom-out" | "zoom-reset" }
			| { readonly type: "set-zoom"; readonly zoomPercent: number },
	) {
		if (zoomBusyRef.current) return;
		zoomBusyRef.current = true;
		setZoomBusy(true);
		setNotice(null);
		setStatus(null);
		const request = ++previewRequestRef.current;
		void (async () => {
			try {
				await api.controlBrowser({ ...action, sessionId, browserId });
				if (!moreOpenRef.current) return;
				const preview = await capturePreview(request);
				if (preview && moreOpenRef.current) setPagePreview(preview);
			} catch (cause) {
				if (request !== previewRequestRef.current) return;
				setStatus(translateRef.current("Browser action failed"));
				onErrorRef.current(cause);
			} finally {
				zoomBusyRef.current = false;
				setZoomBusy(false);
			}
		})();
	}

	function applyZoomDraft() {
		const value = Number(zoomDraft);
		if (!Number.isFinite(value)) {
			setZoomDraft(String(state.zoomPercent));
			return;
		}
		const zoomPercent = Math.min(500, Math.max(25, Math.round(value)));
		setZoomDraft(String(zoomPercent));
		if (zoomPercent !== state.zoomPercent) runZoomAction({ type: "set-zoom", zoomPercent });
	}

	function runPageAction(type: Exclude<DesktopBrowserCommand, "find" | "close-tab"> | "capture-page") {
		setMoreOpen(false);
		setNotice(null);
		setStatus(null);
		void api.controlBrowser({ type, sessionId, browserId }).catch((cause) => {
			setStatus(
				translateRef.current(type === "capture-page" ? "Screenshot could not be saved" : "Browser action failed"),
			);
			onErrorRef.current(cause);
		});
	}

	function openFind() {
		setMoreOpen(false);
		setFindOpen(true);
		requestAnimationFrame(() => findInputRef.current?.focus());
	}

	function closeFind() {
		setFindOpen(false);
		setFindText("");
		setFindResult({ activeMatchOrdinal: 0, matches: 0 });
		void api.controlBrowser({ type: "stop-find", sessionId, browserId }).catch(onErrorRef.current);
	}

	function find(forward: boolean, findNext: boolean, text = findText) {
		// Electron starts a new find session when findNext is true; follow-up navigation uses false.
		void api
			.controlBrowser({ type: "find", sessionId, browserId, text, forward, findNext })
			.catch(onErrorRef.current);
	}

	function runCommand(command: DesktopBrowserCommand) {
		if (pageUrlRef.current === "") return;
		// The workspace owns tab closing; the panel only reacts to in-page commands.
		if (command === "close-tab") return;
		if (command === "find") openFind();
		else if (command === "zoom-in" || command === "zoom-out" || command === "zoom-reset") {
			runZoomAction({ type: command });
		} else runPageAction(command);
	}

	const runCommandRef = useRef(runCommand);
	runCommandRef.current = runCommand;

	function clearBrowserData() {
		if (clearBusy) return;
		setClearBusy(true);
		void api.controlBrowser({ type: "clear-data", sessionId, browserId }).then(
			() => {
				setClearBusy(false);
				setClearConfirmOpen(false);
				setStatus(null);
				setNotice(translateRef.current("Browser data cleared"));
			},
			(cause) => {
				setClearBusy(false);
				setClearConfirmOpen(false);
				setStatus(translateRef.current("Browser action failed"));
				onErrorRef.current(cause);
			},
		);
	}

	const beginDownloadsRead = useCallback(() => {
		const request = ++downloadsRequestRef.current;
		const eventVersion = downloadsEventVersionRef.current;
		setDownloadsStatus("loading");
		void api.listBrowserDownloads().then(
			(listed) => {
				if (request !== downloadsRequestRef.current) return;
				downloadsRetryBusyRef.current = false;
				if (eventVersion === downloadsEventVersionRef.current) setDownloads(listed);
				setDownloadsStatus("ready");
			},
			() => {
				if (request !== downloadsRequestRef.current) return;
				downloadsRetryBusyRef.current = false;
				setDownloadsStatus("error");
			},
		);
	}, [api]);

	const beginHistoryRead = useCallback(
		(profileId: string) => {
			const request = ++historyRequestRef.current;
			const eventVersion = historyEventVersionRef.current;
			setHistoryStatus("loading");
			void api.listBrowserHistory({ profileId }).then(
				(listed) => {
					if (request !== historyRequestRef.current || profileIdRef.current !== profileId) return;
					historyRetryBusyRef.current = false;
					if (eventVersion === historyEventVersionRef.current) setHistory(listed);
					setHistoryStatus("ready");
				},
				() => {
					if (request !== historyRequestRef.current || profileIdRef.current !== profileId) return;
					historyRetryBusyRef.current = false;
					setHistoryStatus("error");
				},
			);
		},
		[api],
	);

	function retryDownloadsRead() {
		if (downloadsRetryBusyRef.current) return;
		downloadsRetryBusyRef.current = true;
		const trigger = downloadsRef.current?.firstElementChild;
		if (trigger instanceof HTMLButtonElement) trigger.focus();
		beginDownloadsRead();
	}

	function retryHistoryRead() {
		if (historyRetryBusyRef.current) return;
		historyRetryBusyRef.current = true;
		const trigger = historyRef.current?.firstElementChild;
		if (trigger instanceof HTMLButtonElement) trigger.focus();
		beginHistoryRead(profileIdRef.current);
	}

	useEffect(() => {
		let active = true;
		const removeBrowserListener = api.subscribeBrowser((event) => {
			if (!active) return;
			if (event.type === "error") {
				if (event.browserId !== browserId) return;
				setStatus(
					event.message === "Browser page crashed" ? translateRef.current("Browser page crashed") : event.message,
				);
				return;
			}
			if (event.type === "find-result") {
				if (event.browserId === browserId) setFindResult(event);
				return;
			}
			if (event.type === "downloads") {
				downloadsEventVersionRef.current += 1;
				setDownloads(event.downloads);
				setDownloadsStatus("ready");
				return;
			}
			if (event.type === "history") {
				if (event.profileId !== profileIdRef.current) return;
				historyEventVersionRef.current += 1;
				setHistory(event.entries);
				setHistoryStatus("ready");
				return;
			}
			if (event.type === "command") {
				if (event.browserId === browserId && visibleRef.current && !coveredRef.current)
					runCommandRef.current(event.command);
				return;
			}
			if (event.type !== "state") return;
			if (event.state.browserId !== browserId) return;
			setState(event.state);
			if (!addressEditedRef.current) setAddress(event.state.url);
			onStateRef.current(event.state);
		});
		if (previousProfileIdRef.current !== profile.profileId) {
			previousProfileIdRef.current = profile.profileId;
			setHistory([]);
		}
		downloadsRetryBusyRef.current = false;
		historyRetryBusyRef.current = false;
		beginDownloadsRead();
		beginHistoryRead(profile.profileId);
		creationRef.current ??= api.createBrowser({ sessionId, browserId, profileId: profile.profileId });
		void creationRef.current.then(
			(created) => {
				if (!active) return;
				setState(created);
				onStateRef.current(created);
			},
			(cause) => {
				if (!active) return;
				setStatus(translateRef.current("Browser could not load this page"));
				onErrorRef.current(cause);
			},
		);
		return () => {
			active = false;
			downloadsRequestRef.current += 1;
			historyRequestRef.current += 1;
			previewRequestRef.current += 1;
			removeBrowserListener();
		};
	}, [api, sessionId, browserId, profile.profileId, beginDownloadsRead, beginHistoryRead]);

	useEffect(() => setZoomDraft(String(state.zoomPercent)), [state.zoomPercent]);

	useEffect(() => {
		const previous = previousControlStateRef.current;
		previousControlStateRef.current = controlState;
		takeoverBusyRef.current = false;
		handoffBusyRef.current = false;
		setTakeoverBusy(false);
		setHandoffBusy(false);
		setMoreOpen(false);
		setDownloadsOpen(false);
		setHistoryOpen(false);
		setFindOpen(false);
		if (controlState === "handoff" && previous !== "handoff") {
			requestAnimationFrame(() => handoffHeadingRef.current?.focus());
		}
	}, [controlState]);

	useEffect(() => {
		if (!moreOpen && !downloadsOpen && !historyOpen) return;
		const close = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!moreRef.current?.contains(target)) setMoreOpen(false);
			if (!downloadsRef.current?.contains(target)) setDownloadsOpen(false);
			if (!historyRef.current?.contains(target)) setHistoryOpen(false);
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMoreOpen(false);
				setDownloadsOpen(false);
				setHistoryOpen(false);
			}
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [moreOpen, downloadsOpen, historyOpen]);

	useEffect(() => {
		if (!visible || covered || clearConfirmOpen || importOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const key = event.key.toLowerCase();
			let command: DesktopBrowserCommand | null = null;
			if (key === "f") command = "find";
			else if (key === "p") command = "print";
			else if (event.key === "-") command = "zoom-out";
			else if (event.key === "+" || event.key === "=") command = "zoom-in";
			else if (event.key === "0") command = "zoom-reset";
			if (!command) return;
			event.preventDefault();
			runCommandRef.current(command);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [visible, covered, clearConfirmOpen, importOpen]);

	useEffect(() => {
		let frame = 0;
		let followup = 0;
		let active = true;
		const send = () => {
			const anchor = anchorRef.current;
			if (!active || !anchor) return;
			const rect = anchor.getBoundingClientRect();
			const bounds = {
				x: Math.max(0, Math.round(rect.x)),
				y: Math.max(0, Math.round(rect.y)),
				width: Math.max(1, Math.round(rect.width)),
				height: Math.max(1, Math.round(rect.height)),
			};
			boundsRef.current = bounds;
			const presented = shouldPresentRef.current;
			if (!presented && !presentationRef.current) return;
			const key = `${presented}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
			if (key === presentationRef.current) return;
			presentationRef.current = key;
			void api.controlBrowser({ type: "present", sessionId, browserId, visible: presented, bounds }).then(
				() => {
					if (presented && shouldPresentRef.current) setPagePreview(null);
				},
				(cause) => {
					if (presentationRef.current === key) presentationRef.current = "";
					onErrorRef.current(cause);
				},
			);
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(send);
		};
		presentRef.current = send;
		const observer = new ResizeObserver(schedule);
		const anchor = anchorRef.current;
		const panel = anchor?.closest(".workspace-panel");
		if (anchor) observer.observe(anchor);
		if (panel) {
			observer.observe(panel);
			panel.addEventListener("workspace-panel-layout", schedule);
		}
		const viewport = window.visualViewport;
		window.addEventListener("resize", schedule);
		window.addEventListener("animationend", schedule);
		window.addEventListener("transitionend", schedule);
		viewport?.addEventListener("resize", schedule);
		schedule();
		followup = requestAnimationFrame(() => {
			if (active) schedule();
		});
		return () => {
			active = false;
			cancelAnimationFrame(frame);
			cancelAnimationFrame(followup);
			observer.disconnect();
			panel?.removeEventListener("workspace-panel-layout", schedule);
			window.removeEventListener("resize", schedule);
			window.removeEventListener("animationend", schedule);
			window.removeEventListener("transitionend", schedule);
			viewport?.removeEventListener("resize", schedule);
			presentRef.current = null;
			const bounds = boundsRef.current;
			if (bounds && shouldPresentRef.current) {
				void api
					.controlBrowser({ type: "present", sessionId, browserId, visible: false, bounds })
					.catch(() => undefined);
			}
		};
	}, [api, browserId, sessionId]);

	useLayoutEffect(() => {
		if (!visible || !covered || state.url === "") return;
		let active = true;
		void api.captureBrowserPreview({ sessionId, browserId }).then(
			(preview) => {
				if (active) setPagePreview(preview);
			},
			(cause) => {
				if (active) onErrorRef.current(cause);
			},
		);
		return () => {
			active = false;
		};
	}, [api, browserId, covered, sessionId, state.url, visible]);

	useLayoutEffect(() => {
		shouldPresentRef.current =
			visible &&
			!covered &&
			!modalPresent &&
			state.url !== "" &&
			!moreOpen &&
			!downloadsOpen &&
			!historyOpen &&
			!clearConfirmOpen &&
			!importOpen &&
			status === null;
		presentRef.current?.();
	}, [
		clearConfirmOpen,
		covered,
		downloadsOpen,
		historyOpen,
		importOpen,
		modalPresent,
		moreOpen,
		state.url,
		status,
		visible,
	]);

	const takeControl = () => {
		if (takeoverBusyRef.current) return;
		takeoverBusyRef.current = true;
		setTakeoverBusy(true);
		void api.takeBrowserControl({ sessionId, browserId }).catch((cause) => {
			takeoverBusyRef.current = false;
			setTakeoverBusy(false);
			onErrorRef.current(cause);
		});
	};

	const resolveHandoff = (decision: "complete" | "cancel") => {
		if (handoffBusyRef.current) return;
		handoffBusyRef.current = true;
		setHandoffBusy(true);
		void api.resolveBrowserHandoff({ sessionId, browserId, decision }).catch((cause) => {
			handoffBusyRef.current = false;
			setHandoffBusy(false);
			onErrorRef.current(cause);
		});
	};

	const handoffMessage =
		handoffReason === "login"
			? t("Sign in on this page, then continue when you are done.")
			: handoffReason === "otp"
				? t("Enter the verification code on this page, then continue.")
				: handoffReason === "passkey"
					? t("Complete the passkey prompt, then continue.")
					: handoffReason === "device_approval"
						? t("Approve this sign-in on your device, then continue.")
						: handoffReason === "captcha"
							? t("Complete the human verification on this page, then continue.")
							: handoffReason === "sensitive_action"
								? t("Review and complete the sensitive action yourself, then continue.")
								: t("Complete the requested step on this page, then continue.");

	const navigate = (url: string) => {
		const target = url.trim();
		if (!target) return;
		addressEditedRef.current = false;
		setAddress(target);
		setStatus(null);
		setNotice(null);
		void (creationRef.current ?? Promise.resolve())
			.then(() => api.controlBrowser({ type: "navigate", sessionId, browserId, url: target }))
			.catch((cause) => {
				setStatus(t("Browser could not load this page"));
				onErrorRef.current(cause);
			});
	};
	const control = (type: "back" | "forward" | "reload" | "open-external") => {
		setStatus(null);
		void api.controlBrowser({ type, sessionId, browserId }).catch((cause) => {
			setStatus(t("Browser could not load this page"));
			onErrorRef.current(cause);
		});
	};

	return (
		<section
			aria-hidden={!visible}
			aria-label={t("Browser")}
			className={`browser-panel${visible ? " is-visible" : ""}${controlState !== "idle" ? " has-control-bar" : ""}`}
			inert={covered}
			id={`browser-panel-${browserId}`}
			role="tabpanel"
		>
			<div aria-disabled={controlState !== "idle"} className="browser-toolbar" inert={controlState !== "idle"}>
				<MenuSelect
					ariaLabel={t("Browser profile: {{name}}", { name: profileLabel(currentProfile) })}
					className="browser-profile-select"
					menuMinWidth={220}
					onChange={(profileId) => {
						const selected = availableProfiles.find((candidate) => candidate.profileId === profileId);
						if (selected) onOpenProfile?.(selected);
					}}
					options={availableProfiles.map((candidate) => ({
						value: candidate.profileId,
						label: profileLabel(candidate),
					}))}
					popoverClassName="browser-profile-popover"
					triggerIcon={<User aria-hidden="true" size={13} weight="fill" />}
					value={profile.profileId}
				/>
				<div className="browser-navigation">
					<button
						aria-label={t("Back")}
						className="browser-toolbar-button"
						disabled={!state.canGoBack}
						onClick={() => control("back")}
						type="button"
					>
						<ArrowLeft aria-hidden="true" size={14} />
					</button>
					<button
						aria-label={t("Forward")}
						className="browser-forward browser-toolbar-button"
						disabled={!state.canGoForward}
						onClick={() => control("forward")}
						type="button"
					>
						<ArrowRight aria-hidden="true" size={14} />
					</button>
					<button
						aria-label={t("Reload")}
						className="browser-toolbar-button"
						disabled={state.url === ""}
						onClick={() => control("reload")}
						type="button"
					>
						<ArrowClockwise aria-hidden="true" className={state.loading ? "is-spinning" : undefined} size={14} />
					</button>
				</div>
				<form
					className="browser-address-form"
					onSubmit={(event) => {
						event.preventDefault();
						navigate(address);
					}}
				>
					<div className="browser-address-field">
						<span className="sr-only">{t("Browser address")}</span>
						<input
							aria-label={t("Browser address")}
							onChange={(event) => {
								addressEditedRef.current = true;
								setAddress(event.target.value);
							}}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									addressEditedRef.current = false;
									setAddress(pageUrlRef.current);
								}
							}}
							placeholder={t("Enter URL")}
							ref={addressInputRef}
							spellCheck={false}
							value={address}
						/>
						<button
							aria-label={t("Open in default browser")}
							className="browser-address-open"
							disabled={state.url === ""}
							onClick={() => control("open-external")}
							type="button"
						>
							<ArrowSquareOut aria-hidden="true" size={13} />
						</button>
					</div>
				</form>
				<div className="browser-history" ref={historyRef}>
					<button
						aria-busy={previewBusy}
						aria-expanded={historyOpen}
						aria-label={t("History")}
						className="browser-toolbar-button"
						disabled={previewBusy}
						onClick={toggleHistory}
						type="button"
					>
						<ClockCounterClockwise aria-hidden="true" size={14} />
					</button>
					{historyOpen && (
						<div aria-label={t("History")} className="browser-downloads-menu" role="menu">
							<div className="browser-downloads-header">
								<span>{t("History")}</span>
								<button
									className="browser-history-clear"
									disabled={history.length === 0}
									onClick={clearBrowserHistoryEntries}
									role="menuitem"
									type="button"
								>
									{t("Clear history")}
								</button>
							</div>
							{historyStatus === "loading" && history.length === 0 && (
								<p className="browser-downloads-empty">{t("Loading browsing history…")}</p>
							)}
							{historyStatus === "error" && (
								<div className="browser-downloads-error" role="alert">
									<span>{t("History could not be loaded")}</span>
									<button className="browser-history-clear" onClick={retryHistoryRead} type="button">
										{t("Retry")}
									</button>
								</div>
							)}
							{history.length === 0
								? historyStatus === "ready" && <p className="browser-downloads-empty">{t("No history yet")}</p>
								: history.map((entry) => (
										<button
											className="browser-history-row"
											key={entry.entryId}
											onClick={() => openHistoryEntry(entry.url)}
											role="menuitem"
											title={entry.url}
											type="button"
										>
											<span className="browser-download-name">{entry.title}</span>
											<span className="browser-download-meta">
												{formatHistoryTime(entry.visitedAt)} · {entry.url}
											</span>
										</button>
									))}
						</div>
					)}
				</div>
				<div className="browser-downloads" ref={downloadsRef}>
					<button
						aria-busy={previewBusy}
						aria-expanded={downloadsOpen}
						aria-label={t("Downloads")}
						className="browser-toolbar-button browser-downloads-button"
						disabled={previewBusy}
						onClick={toggleDownloads}
						type="button"
					>
						<DownloadSimple aria-hidden="true" size={14} />
						{downloads.some((download) => download.state === "progressing" || download.state === "paused") && (
							<span aria-hidden="true" className="browser-download-badge" />
						)}
					</button>
					{downloadsOpen && (
						<div aria-label={t("Downloads")} className="browser-downloads-menu" role="menu">
							<div className="browser-downloads-header">{t("Downloads")}</div>
							{downloadsStatus === "loading" && downloads.length === 0 && (
								<p className="browser-downloads-empty">{t("Loading downloads…")}</p>
							)}
							{downloadsStatus === "error" && (
								<div className="browser-downloads-error" role="alert">
									<span>{t("Downloads could not be loaded")}</span>
									<button className="browser-history-clear" onClick={retryDownloadsRead} type="button">
										{t("Retry")}
									</button>
								</div>
							)}
							{downloads.length === 0
								? downloadsStatus === "ready" && (
										<p className="browser-downloads-empty">{t("No downloads yet")}</p>
									)
								: downloads.map((download) => (
										<BrowserDownloadRow
											download={download}
											key={download.downloadId}
											onAction={runDownloadAction}
										/>
									))}
						</div>
					)}
				</div>
				<div className="browser-more" ref={moreRef}>
					<button
						aria-busy={previewBusy}
						aria-expanded={moreOpen}
						aria-haspopup="menu"
						aria-label={t("More browser actions")}
						className="browser-toolbar-button"
						disabled={previewBusy}
						onClick={toggleMore}
						type="button"
					>
						<DotsThreeVertical aria-hidden="true" size={16} weight="bold" />
					</button>
					{moreOpen && (
						<div className="browser-more-menu" role="menu">
							<button
								data-browser-action="find"
								disabled={state.url === ""}
								onClick={openFind}
								role="menuitem"
								type="button"
							>
								<MagnifyingGlass aria-hidden="true" size={14} />
								<span>{t("Find in page")}</span>
								<kbd>{api.platform === "darwin" ? "⌘F" : "Ctrl+F"}</kbd>
							</button>
							<button
								disabled={state.url === ""}
								onClick={() => runPageAction("print")}
								role="menuitem"
								type="button"
							>
								<Printer aria-hidden="true" size={14} />
								<span>{t("Print")}</span>
								<kbd>{api.platform === "darwin" ? "⌘P" : "Ctrl+P"}</kbd>
							</button>
							<hr className="browser-menu-separator" />
							<fieldset aria-label={t("Zoom")} className="control-group browser-zoom-row">
								<span>{t("Zoom")}</span>
								<button
									aria-label={t("Zoom out")}
									disabled={zoomBusy || state.url === "" || state.zoomPercent === 25}
									onClick={() => runZoomAction({ type: "zoom-out" })}
									role="menuitem"
									type="button"
								>
									<Minus aria-hidden="true" size={13} />
								</button>
								<label className="browser-zoom-value">
									<input
										aria-label={t("Zoom percentage")}
										disabled={zoomBusy || state.url === ""}
										inputMode="numeric"
										max={500}
										min={25}
										onChange={(event) => setZoomDraft(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												applyZoomDraft();
											} else if (event.key === "Escape") {
												setZoomDraft(String(state.zoomPercent));
												event.currentTarget.blur();
											}
										}}
										step={1}
										type="number"
										value={zoomDraft}
									/>
									<span aria-hidden="true">%</span>
								</label>
								<button
									aria-label={t("Zoom in")}
									disabled={zoomBusy || state.url === "" || state.zoomPercent === 500}
									onClick={() => runZoomAction({ type: "zoom-in" })}
									role="menuitem"
									type="button"
								>
									<Plus aria-hidden="true" size={13} />
								</button>
								<button
									aria-label={t("Reset zoom")}
									disabled={zoomBusy || state.url === "" || state.zoomPercent === 100}
									onClick={() => runZoomAction({ type: "zoom-reset" })}
									role="menuitem"
									type="button"
								>
									<ArrowCounterClockwise aria-hidden="true" size={13} />
								</button>
							</fieldset>
							<button
								disabled={state.url === ""}
								onClick={() => runPageAction("capture-page")}
								role="menuitem"
								type="button"
							>
								<Camera aria-hidden="true" size={14} />
								<span>{t("Screenshot")}</span>
							</button>
							<hr className="browser-menu-separator" />
							<button
								onClick={() => {
									const trigger = moreRef.current?.firstElementChild;
									if (trigger instanceof HTMLButtonElement) trigger.focus({ preventScroll: true });
									setMoreOpen(false);
									setImportOpen(true);
								}}
								role="menuitem"
								type="button"
							>
								<DownloadSimple aria-hidden="true" size={14} />
								<span>{t("Import browser data…")}</span>
							</button>
							<button
								data-browser-action="clear-data"
								onClick={() => {
									setMoreOpen(false);
									setClearConfirmOpen(true);
								}}
								role="menuitem"
								type="button"
							>
								<Trash aria-hidden="true" size={14} />
								<span>{t("Clear browsing data")}</span>
							</button>
						</div>
					)}
				</div>
			</div>
			{controlState === "agent" && (
				<output
					aria-label={t("Browser automation active")}
					className="status-block browser-control-bar browser-automation-bar"
				>
					<span>{t("Metis is controlling this page")}</span>
					<button disabled={takeoverBusy} onClick={takeControl} type="button">
						{t(takeoverBusy ? "Taking control…" : "Take control")}
					</button>
				</output>
			)}
			{controlState === "handoff" && (
				<div
					aria-label={t("Your action is needed")}
					className="browser-control-bar browser-handoff-bar"
					role="alert"
				>
					<div>
						<h2 ref={handoffHeadingRef} tabIndex={-1}>
							{t("Your action is needed")}
						</h2>
						<p>{handoffMessage}</p>
					</div>
					<div className="browser-control-actions">
						<button disabled={handoffBusy} onClick={() => resolveHandoff("cancel")} type="button">
							{t("Cancel")}
						</button>
						<button
							className="is-primary"
							disabled={handoffBusy}
							onClick={() => resolveHandoff("complete")}
							type="button"
						>
							{t(handoffBusy ? "Continuing…" : "Done, continue")}
						</button>
					</div>
				</div>
			)}
			{findOpen && (
				<search aria-label={t("Find in page")} className="browser-find-panel">
					<div className="browser-find-query">
						<MagnifyingGlass aria-hidden="true" size={13} />
						<input
							aria-label={t("Find in page")}
							onChange={(event) => {
								setFindText(event.target.value);
								find(true, true, event.target.value);
							}}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									closeFind();
								} else if (event.key === "Enter") {
									event.preventDefault();
									find(!event.shiftKey, false);
								}
							}}
							ref={findInputRef}
							spellCheck={false}
							value={findText}
						/>
						<button aria-label={t("Close find")} onClick={closeFind} type="button">
							<X aria-hidden="true" size={13} />
						</button>
					</div>
					<div className="browser-find-controls">
						<button
							aria-label={t("Previous match")}
							disabled={findResult.matches === 0}
							onClick={() => find(false, false)}
							type="button"
						>
							<ArrowUp aria-hidden="true" size={13} />
						</button>
						<button
							aria-label={t("Next match")}
							disabled={findResult.matches === 0}
							onClick={() => find(true, false)}
							type="button"
						>
							<ArrowDown aria-hidden="true" size={13} />
						</button>
						<output className="browser-find-count">
							{t("{{active}} / {{total}} results", {
								active: findResult.activeMatchOrdinal,
								total: findResult.matches,
							})}
						</output>
					</div>
				</search>
			)}
			<div className="browser-view-anchor" ref={anchorRef}>
				{pagePreview && (
					<img alt="" aria-hidden="true" className="browser-view-preview" draggable={false} src={pagePreview} />
				)}
			</div>
			{state.url === "" &&
				(startPageTools ? (
					<BrowserStartPage tools={startPageTools} history={history} onNavigate={navigate} />
				) : (
					<div className="browser-empty">
						<div className="browser-empty-content">
							<Globe aria-hidden="true" size={25} weight="light" />
							<strong>{t("Start browsing")}</strong>
							<span>{t("Enter a URL to open a page")}</span>
						</div>
					</div>
				))}
			{clearConfirmOpen && (
				<BrowserClearDialog
					busy={clearBusy}
					onCancel={() => setClearConfirmOpen(false)}
					onConfirm={clearBrowserData}
				/>
			)}
			{importOpen && (
				<BrowserImportDialog
					api={api}
					onCancel={() => setImportOpen(false)}
					onImported={(result) => {
						const summary = [
							result.cookies
								? t("Imported {{count}} Cookies ({{skipped}} skipped).", {
										count: result.cookies.imported,
										skipped: result.cookies.skipped,
									})
								: "",
							result.history ? t("{{count}} history entries retained.", { count: result.history.retained }) : "",
						]
							.filter(Boolean)
							.join(" ");
						setImportOpen(false);
						setNotice(summary);
						onProfileImported(result.profile);
					}}
				/>
			)}
			{notice && <output className="status-block browser-toolbar-notice">{notice}</output>}
			{status && <output className="status-block browser-status">{status}</output>}
		</section>
	);
}
