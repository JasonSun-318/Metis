import {
	ArrowCounterClockwise,
	ArrowClockwise,
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowSquareOut,
	ArrowUp,
	Camera,
	DotsThreeVertical,
	Globe,
	MagnifyingGlass,
	Minus,
	Plus,
	Printer,
	Trash,
	X,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	MetisDesktopApi,
	DesktopBrowserBounds,
	DesktopBrowserCommand,
	DesktopBrowserState,
} from "../../shared/desktop-api.ts";

interface BrowserPanelProps {
	readonly api: MetisDesktopApi;
	readonly browserId: string;
	readonly onError: (cause: unknown) => void;
	readonly onState: (state: DesktopBrowserState) => void;
	readonly visible: boolean;
}

const emptyState = (browserId: string): DesktopBrowserState => ({
	browserId,
	url: "",
	title: "New tab",
	faviconUrl: null,
	loading: false,
	canGoBack: false,
	canGoForward: false,
	zoomPercent: 100,
});

function BrowserClearDialog({ busy, onCancel, onConfirm }: {
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
				<p>{t("This clears cookies and site data for every Metis browser tab. Open tabs will stay open.")}</p>
				<div className="browser-clear-actions">
					<button disabled={busy} onClick={onCancel} type="button">{t("Cancel")}</button>
					<button className="is-danger" data-browser-confirm-clear disabled={busy} onClick={onConfirm} type="button">{t(busy ? "Clearing…" : "Clear data")}</button>
				</div>
			</form>
		</dialog>
	);
}

export function BrowserPanel({ api, browserId, onError, onState, visible }: BrowserPanelProps) {
	const { t } = useTranslation();
	const [state, setState] = useState(() => emptyState(browserId));
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
	const [clearBusy, setClearBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const anchorRef = useRef<HTMLDivElement>(null);
	const findInputRef = useRef<HTMLInputElement>(null);
	const moreRef = useRef<HTMLDivElement>(null);
	const presentationRef = useRef("");
	const boundsRef = useRef<DesktopBrowserBounds | null>(null);
	const presentRef = useRef<(() => void) | null>(null);
	const shouldPresentRef = useRef(false);
	const creationRef = useRef<Promise<DesktopBrowserState> | null>(null);
	const onErrorRef = useRef(onError);
	const onStateRef = useRef(onState);
	const translateRef = useRef(t);
	const visibleRef = useRef(visible);
	const moreOpenRef = useRef(moreOpen);
	const previewRequestRef = useRef(0);
	const zoomBusyRef = useRef(false);
	onErrorRef.current = onError;
	onStateRef.current = onState;
	translateRef.current = t;
	visibleRef.current = visible;
	moreOpenRef.current = moreOpen;

	async function capturePreview(request: number): Promise<string | null> {
		const preview = await api.captureBrowserPreview({ browserId });
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
				await api.controlBrowser({ ...action, browserId });
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

	function runPageAction(type: Exclude<DesktopBrowserCommand, "find"> | "capture-page") {
		setMoreOpen(false);
		setNotice(null);
		setStatus(null);
		void api.controlBrowser({ type, browserId }).catch((cause) => {
			setStatus(translateRef.current(type === "capture-page" ? "Screenshot could not be saved" : "Browser action failed"));
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
		void api.controlBrowser({ type: "stop-find", browserId }).catch(onErrorRef.current);
	}

	function find(forward: boolean, findNext: boolean, text = findText) {
		// Electron starts a new find session when findNext is true; follow-up navigation uses false.
		void api.controlBrowser({ type: "find", browserId, text, forward, findNext }).catch(onErrorRef.current);
	}

	function runCommand(command: DesktopBrowserCommand) {
		if (command === "find") openFind();
		else if (command === "zoom-in" || command === "zoom-out" || command === "zoom-reset") {
			runZoomAction({ type: command });
		}
		else runPageAction(command);
	}

	function clearBrowserData() {
		if (clearBusy) return;
		setClearBusy(true);
		void api.controlBrowser({ type: "clear-data", browserId }).then(
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
			if (event.type === "command") {
				if (event.browserId === browserId && visibleRef.current) runCommand(event.command);
				return;
			}
			if (event.state.browserId !== browserId) return;
			setState(event.state);
			setAddress(event.state.url);
			onStateRef.current(event.state);
		});
		creationRef.current ??= api.createBrowser({ browserId });
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
			previewRequestRef.current += 1;
			removeBrowserListener();
		};
	}, [api, browserId]);

	useEffect(() => setZoomDraft(String(state.zoomPercent)), [state.zoomPercent]);

	useEffect(() => {
		if (!moreOpen) return;
		const close = (event: PointerEvent) => {
			if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMoreOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", escape);
		};
	}, [moreOpen]);

	useEffect(() => {
		if (!visible || clearConfirmOpen) return;
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
			runCommand(command);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [api, browserId, clearConfirmOpen, visible]);

	useEffect(() => {
		let frame = 0;
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
			const key = `${presented}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
			if (key === presentationRef.current) return;
			presentationRef.current = key;
			void api.controlBrowser({ type: "present", browserId, visible: presented, bounds }).then(
				() => {
					if (presented) setPagePreview(null);
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
		if (anchorRef.current) observer.observe(anchorRef.current);
		window.addEventListener("resize", schedule);
		schedule();
		return () => {
			active = false;
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", schedule);
			presentRef.current = null;
			const bounds = boundsRef.current;
			if (bounds && shouldPresentRef.current) {
				void api.controlBrowser({ type: "present", browserId, visible: false, bounds }).catch(() => undefined);
			}
		};
	}, [api, browserId]);

	useLayoutEffect(() => {
		shouldPresentRef.current =
			visible && state.url !== "" && !moreOpen && !clearConfirmOpen && status === null;
		presentRef.current?.();
	}, [clearConfirmOpen, moreOpen, state.url, status, visible]);

	const control = (type: "back" | "forward" | "reload" | "open-external") => {
		setStatus(null);
		void api.controlBrowser({ type, browserId }).catch((cause) => {
			setStatus(t("Browser could not load this page"));
			onErrorRef.current(cause);
		});
	};

	return (
		<section
			aria-hidden={!visible}
			aria-label={t("Browser")}
			className={`browser-panel${visible ? " is-visible" : ""}`}
			id={`browser-panel-${browserId}`}
			role="tabpanel"
		>
			<div className="browser-toolbar">
				<button aria-label={t("Back")} className="browser-toolbar-button" disabled={!state.canGoBack} onClick={() => control("back")} type="button"><ArrowLeft aria-hidden="true" size={14} /></button>
				<button aria-label={t("Forward")} className="browser-forward browser-toolbar-button" disabled={!state.canGoForward} onClick={() => control("forward")} type="button"><ArrowRight aria-hidden="true" size={14} /></button>
				<button aria-label={t("Reload")} className="browser-toolbar-button" disabled={state.url === ""} onClick={() => control("reload")} type="button"><ArrowClockwise aria-hidden="true" className={state.loading ? "is-spinning" : undefined} size={14} /></button>
				<form
					className="browser-address-form"
					onSubmit={(event) => {
						event.preventDefault();
						const url = address.trim();
						if (!url) return;
						setStatus(null);
						setNotice(null);
						void api.controlBrowser({ type: "navigate", browserId, url }).catch((cause) => {
							setStatus(t("Browser could not load this page"));
							onErrorRef.current(cause);
						});
					}}
				>
					<div className="browser-address-field">
						<span className="sr-only">{t("Browser address")}</span>
						<input aria-label={t("Browser address")} onChange={(event) => setAddress(event.target.value)} placeholder={t("Enter URL")} spellCheck={false} value={address} />
						<button aria-label={t("Open in default browser")} className="browser-address-open" disabled={state.url === ""} onClick={(event) => { event.preventDefault(); control("open-external"); }} type="button"><ArrowSquareOut aria-hidden="true" size={13} /></button>
					</div>
				</form>
				<div className="browser-more" ref={moreRef}>
					<button aria-busy={previewBusy} aria-expanded={moreOpen} aria-haspopup="menu" aria-label={t("More browser actions")} className="browser-toolbar-button" disabled={previewBusy} onClick={toggleMore} type="button"><DotsThreeVertical aria-hidden="true" size={16} weight="bold" /></button>
					{moreOpen && (
						<div className="browser-more-menu" role="menu">
							<button data-browser-action="find" disabled={state.url === ""} onClick={openFind} role="menuitem" type="button"><MagnifyingGlass aria-hidden="true" size={14} /><span>{t("Find in page")}</span><kbd>⌘F</kbd></button>
							<button disabled={state.url === ""} onClick={() => runPageAction("print")} role="menuitem" type="button"><Printer aria-hidden="true" size={14} /><span>{t("Print")}</span><kbd>⌘P</kbd></button>
							<div className="browser-menu-separator" role="separator" />
							<div aria-label={t("Zoom")} className="browser-zoom-row" role="group">
								<span>{t("Zoom")}</span>
								<button aria-label={t("Zoom out")} disabled={zoomBusy || state.url === "" || state.zoomPercent === 25} onClick={() => runZoomAction({ type: "zoom-out" })} role="menuitem" type="button"><Minus aria-hidden="true" size={13} /></button>
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
								<button aria-label={t("Zoom in")} disabled={zoomBusy || state.url === "" || state.zoomPercent === 500} onClick={() => runZoomAction({ type: "zoom-in" })} role="menuitem" type="button"><Plus aria-hidden="true" size={13} /></button>
								<button aria-label={t("Reset zoom")} disabled={zoomBusy || state.url === "" || state.zoomPercent === 100} onClick={() => runZoomAction({ type: "zoom-reset" })} role="menuitem" type="button"><ArrowCounterClockwise aria-hidden="true" size={13} /></button>
							</div>
							<button disabled={state.url === ""} onClick={() => runPageAction("capture-page")} role="menuitem" type="button"><Camera aria-hidden="true" size={14} /><span>{t("Screenshot")}</span></button>
							<div className="browser-menu-separator" role="separator" />
							<button data-browser-action="clear-data" onClick={() => { setMoreOpen(false); setClearConfirmOpen(true); }} role="menuitem" type="button"><Trash aria-hidden="true" size={14} /><span>{t("Clear browsing data")}</span></button>
						</div>
					)}
				</div>
			</div>
			{findOpen && (
				<div aria-label={t("Find in page")} className="browser-find-panel" role="search">
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
						<button aria-label={t("Close find")} onClick={closeFind} type="button"><X aria-hidden="true" size={13} /></button>
					</div>
					<div className="browser-find-controls">
						<button aria-label={t("Previous match")} disabled={findResult.matches === 0} onClick={() => find(false, false)} type="button"><ArrowUp aria-hidden="true" size={13} /></button>
						<button aria-label={t("Next match")} disabled={findResult.matches === 0} onClick={() => find(true, false)} type="button"><ArrowDown aria-hidden="true" size={13} /></button>
						<output className="browser-find-count">{t("{{active}} / {{total}} results", { active: findResult.activeMatchOrdinal, total: findResult.matches })}</output>
					</div>
				</div>
			)}
			<div className="browser-view-anchor" ref={anchorRef}>
				{pagePreview && <img alt="" aria-hidden="true" className="browser-view-preview" draggable={false} src={pagePreview} />}
			</div>
			{state.url === "" && (
				<div className="browser-empty">
					<div className="browser-empty-content">
						<Globe aria-hidden="true" size={25} weight="light" />
						<strong>{t("Start browsing")}</strong>
						<span>{t("Enter a URL to open a page")}</span>
					</div>
				</div>
			)}
			{clearConfirmOpen && <BrowserClearDialog busy={clearBusy} onCancel={() => setClearConfirmOpen(false)} onConfirm={clearBrowserData} />}
			{notice && <div className="browser-toolbar-notice" role="status">{notice}</div>}
			{status && <div className="browser-status" role="status">{status}</div>}
		</section>
	);
}
