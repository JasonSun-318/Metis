import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	DesktopBrowserImportResult,
	DesktopBrowserImportSource,
	DesktopBrowserImportStatus,
	DesktopBrowserSourceId,
	MetisDesktopApi,
} from "../../shared/desktop-api.ts";
import { X } from "../icons.tsx";
import "../styles/browser-import-dialog.css";
import { DialogFrame } from "./DialogFrame.tsx";
import { MenuSelect } from "./MenuSelect.tsx";

const KNOWN_STATUSES = new Set<DesktopBrowserImportStatus>([
	"ready",
	"not-found",
	"permission-denied",
	"invalid-metadata",
	"no-profiles",
	"unreadable",
	"process-check-failed",
]);

const FOLDER_RECOVERY_STATUSES = new Set<DesktopBrowserImportStatus>([
	"not-found",
	"permission-denied",
	"invalid-metadata",
	"no-profiles",
	"unreadable",
]);

interface BrowserImportDialogProps {
	readonly api: MetisDesktopApi;
	readonly onCancel: () => void;
	readonly onImported: (result: DesktopBrowserImportResult) => void;
}

function sourceStatus(source: DesktopBrowserImportSource): DesktopBrowserImportStatus | "unknown" | undefined {
	const status: unknown = source.status;
	if (status === undefined) return undefined;
	return typeof status === "string" && KNOWN_STATUSES.has(status as DesktopBrowserImportStatus)
		? (status as DesktopBrowserImportStatus)
		: "unknown";
}

function hasRecoveredMetadata(source: DesktopBrowserImportSource): boolean {
	return (
		source.status === "ready" &&
		source.diagnostic?.stage === "local-state" &&
		["ENOENT", "invalid-json", "invalid-schema"].includes(source.diagnostic.code)
	);
}

function sourceIsImportable(source: DesktopBrowserImportSource): boolean {
	const status = sourceStatus(source);
	return (
		source.running === false &&
		(!source.diagnostic || hasRecoveredMetadata(source)) &&
		(status === undefined || status === "ready") &&
		source.profiles.length > 0
	);
}

function sourceRank(source: DesktopBrowserImportSource): number {
	const status = sourceStatus(source);
	if (sourceIsImportable(source)) return 0;
	if (status === "ready" || status === "process-check-failed" || source.profiles.length > 0) return 1;
	if (status === "permission-denied" || status === "invalid-metadata" || status === "unreadable") return 2;
	if (status === "no-profiles") return 3;
	if (status === "not-found") return 4;
	return 5;
}

function orderSources(sources: readonly DesktopBrowserImportSource[]): readonly DesktopBrowserImportSource[] {
	return sources
		.map((source, index) => ({ source, index, rank: sourceRank(source) }))
		.sort((left, right) => left.rank - right.rank || left.index - right.index)
		.map(({ source }) => source);
}

function errorText(cause: unknown, fallback: string): string {
	const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback;
	return (
		message
			.trim()
			.replace(
				/^Error invoking remote method 'metis:(?:import-browser-data|choose-browser-import-directory|list-browser-import-sources)': (?:Error: )?/u,
				"",
			) || fallback
	);
}

function isCookieFailure(cause: unknown): boolean {
	const text = cause instanceof Error ? `${cause.name} ${cause.message}` : typeof cause === "string" ? cause : "";
	return /cookie/iu.test(text);
}

function safeDiagnostic(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.trim()
		.slice(0, 120);
}

export function BrowserImportDialog({ api, onCancel, onImported }: BrowserImportDialogProps) {
	const { t } = useTranslation();
	const closeRef = useRef<HTMLButtonElement>(null);
	const recheckRef = useRef<HTMLButtonElement>(null);
	const chooseFolderRef = useRef<HTMLButtonElement>(null);
	const refocusAfterChooserRef = useRef<"choose" | "recheck" | null>(null);
	const mountedRef = useRef(true);
	const requestRef = useRef(0);
	const importingRef = useRef(false);
	const selectionRef = useRef<{ sourceId: DesktopBrowserSourceId | ""; sourceProfileId: string }>({
		sourceId: "",
		sourceProfileId: "",
	});
	const supportsCookieImport = api.platform === "darwin";
	const [sources, setSources] = useState<readonly DesktopBrowserImportSource[]>([]);
	const [sourceId, setSourceId] = useState<DesktopBrowserSourceId | "">("");
	const [sourceProfileId, setSourceProfileId] = useState("");
	const [cookies, setCookies] = useState(supportsCookieImport);
	const [history, setHistory] = useState(true);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [chooserPending, setChooserPending] = useState(false);
	const [sourceError, setSourceError] = useState<string | null>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const [cookieFailure, setCookieFailure] = useState(false);
	selectionRef.current = { sourceId, sourceProfileId };

	const selectedSource = sources.find((source) => source.sourceId === sourceId);
	const selectedProfile = selectedSource?.profiles.find((profile) => profile.sourceProfileId === sourceProfileId);
	const status = selectedSource ? sourceStatus(selectedSource) : undefined;
	const canImport = Boolean(
		selectedSource &&
			selectedProfile &&
			sourceIsImportable(selectedSource) &&
			(cookies || history) &&
			!loading &&
			!sourceError &&
			!pending &&
			!chooserPending,
	);

	let statusMessage: string | null = null;
	let statusIsError = false;
	let folderRecovery = false;
	if (selectedSource) {
		if (selectedSource.running === true) {
			statusMessage = t("Close {{browser}} before importing, then check again.", { browser: selectedSource.name });
			statusIsError = true;
		} else if (typeof selectedSource.running !== "boolean") {
			statusMessage = t(
				"Metis could not verify whether {{browser}} is running. Import is blocked until the check succeeds.",
				{
					browser: selectedSource.name,
				},
			);
			statusIsError = true;
		} else if (status === "process-check-failed") {
			statusMessage = t(
				"Metis could not verify whether {{browser}} is running. Import is blocked until the check succeeds.",
				{
					browser: selectedSource.name,
				},
			);
			statusIsError = true;
		} else if (status === "unknown") {
			statusMessage = t(
				"{{browser}} returned an unrecognized status. Import is blocked until Metis can verify it.",
				{
					browser: selectedSource.name,
				},
			);
			statusIsError = true;
		} else if (status === "not-found") {
			statusMessage = t(
				"{{browser}} data was not found at the default location. Choose its data folder to make it available.",
				{ browser: selectedSource.name },
			);
		} else if (status === "unreadable") {
			statusMessage = t(
				"{{browser}} data was found, but Metis cannot read it. Choose its data folder to try again.",
				{
					browser: selectedSource.name,
				},
			);
		} else if (status === "permission-denied") {
			statusMessage = t(
				"{{browser}} data was found, but Metis does not have permission to read it. Choose its data folder to try again.",
				{ browser: selectedSource.name },
			);
		} else if (status === "invalid-metadata") {
			statusMessage = t(
				"{{browser}} data was found, but its profile information is invalid or incomplete. Choose its data folder to try again.",
				{ browser: selectedSource.name },
			);
		} else if (status === "no-profiles") {
			statusMessage = t(
				"{{browser}} was found, but it has no usable profiles. Choose its data folder to try again.",
				{
					browser: selectedSource.name,
				},
			);
		} else if (hasRecoveredMetadata(selectedSource)) {
			statusMessage = t("Profile names were recovered from folders. Choose a profile to import.");
		} else if (selectedSource.diagnostic) {
			statusMessage = t("{{browser}} reported a technical problem. Import is blocked until Metis can verify it.", {
				browser: selectedSource.name,
			});
			statusIsError = true;
		} else if (status === undefined && selectedSource.profiles.length === 0) {
			statusMessage = t("No supported browser profiles found");
		}
		folderRecovery = status !== undefined && status !== "unknown" && FOLDER_RECOVERY_STATUSES.has(status);
	}

	const applySources = useCallback((found: readonly DesktopBrowserImportSource[]) => {
		const ordered = orderSources(found);
		const previous = selectionRef.current;
		const nextSource = ordered.find((source) => source.sourceId === previous.sourceId) ?? ordered[0];
		const nextProfile =
			nextSource?.profiles.find((profile) => profile.sourceProfileId === previous.sourceProfileId) ??
			nextSource?.profiles[0];
		const nextSelection = {
			sourceId: nextSource?.sourceId ?? ("" as const),
			sourceProfileId: nextProfile?.sourceProfileId ?? "",
		};
		selectionRef.current = nextSelection;
		setSources(ordered);
		setSourceId(nextSelection.sourceId);
		setSourceProfileId(nextSelection.sourceProfileId);
	}, []);

	const refresh = useCallback(async () => {
		const request = ++requestRef.current;
		setLoading(true);
		setSourceError(null);
		try {
			const found = await api.listBrowserImportSources();
			if (!mountedRef.current || request !== requestRef.current) return;
			applySources(found);
		} catch (cause) {
			if (!mountedRef.current || request !== requestRef.current) return;
			setSourceError(t(errorText(cause, "Browser data could not be imported")));
		} finally {
			if (mountedRef.current && request === requestRef.current) setLoading(false);
		}
	}, [api, applySources, t]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			requestRef.current += 1;
		};
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (chooserPending || !refocusAfterChooserRef.current) return;
		const target = refocusAfterChooserRef.current === "choose" ? chooseFolderRef.current : recheckRef.current;
		refocusAfterChooserRef.current = null;
		(target ?? recheckRef.current)?.focus();
	}, [chooserPending]);

	const selectSource = (value: string) => {
		const nextSource = sources.find((source) => source.sourceId === value);
		const nextProfileId = nextSource?.profiles[0]?.sourceProfileId ?? "";
		selectionRef.current = {
			sourceId: value as DesktopBrowserSourceId,
			sourceProfileId: nextProfileId,
		};
		setSourceId(value as DesktopBrowserSourceId);
		setSourceProfileId(nextProfileId);
		setImportError(null);
		setCookieFailure(false);
	};

	const selectProfile = (value: string) => {
		selectionRef.current = { sourceId, sourceProfileId: value };
		setSourceProfileId(value);
		setImportError(null);
		setCookieFailure(false);
	};

	const importSelectedData = async (dataTypes: { readonly cookies: boolean; readonly history: boolean }) => {
		if (importingRef.current || !selectedSource || !selectedProfile || !sourceIsImportable(selectedSource)) return;
		if (!dataTypes.cookies && !dataTypes.history) return;
		importingRef.current = true;
		setPending(true);
		setImportError(null);
		setCookieFailure(false);
		try {
			const result = await api.importBrowserData({
				sourceId: selectedSource.sourceId,
				sourceProfileId: selectedProfile.sourceProfileId,
				dataTypes,
			});
			if (!mountedRef.current) return;
			onImported(result);
		} catch (cause) {
			if (!mountedRef.current) return;
			setImportError(t(errorText(cause, "Browser data could not be imported")));
			setCookieFailure(dataTypes.cookies && isCookieFailure(cause));
		} finally {
			importingRef.current = false;
			if (mountedRef.current) setPending(false);
		}
	};

	const submit = () => importSelectedData({ cookies: supportsCookieImport && cookies, history });

	const retryWithHistory = () => {
		if (!history || importingRef.current) return;
		setCookies(false);
		setCookieFailure(false);
		void importSelectedData({ cookies: false, history: true });
	};

	const chooseFolder = async () => {
		if (!selectedSource || pending || chooserPending) return;
		const choose = api.chooseBrowserImportDirectory;
		if (!choose) {
			setSourceError(t("Browser data folder selection is unavailable."));
			return;
		}
		setChooserPending(true);
		setSourceError(null);
		let recovered = false;
		try {
			const chosen = await choose({ sourceId: selectedSource.sourceId });
			if (!mountedRef.current) return;
			if (!chosen) return;
			await refresh();
			if (!mountedRef.current) return;
			recovered = true;
		} catch (cause) {
			if (mountedRef.current) {
				setSourceError(t(errorText(cause, "Browser data folder selection is unavailable.")));
			}
		} finally {
			if (mountedRef.current) {
				refocusAfterChooserRef.current = recovered ? "recheck" : "choose";
				setChooserPending(false);
			}
		}
	};

	const diagnostic = selectedSource?.diagnostic;
	const diagnosticStage = diagnostic ? safeDiagnostic(diagnostic.stage) : "";
	const diagnosticCode = diagnostic ? safeDiagnostic(diagnostic.code) : "";

	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog browser-import-dialog"
			descriptionId="browser-import-description"
			initialFocus={closeRef}
			onCancel={onCancel}
			titleId="browser-import-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onCancel}
				ref={closeRef}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="browser-import-title">{t("Import from browser")}</h2>
			<p id="browser-import-description">{t("Choose data to import into an isolated Metis browser profile.")}</p>
			<div aria-busy={loading} className="browser-import-fields">
				<div className="browser-import-checks">
					<button
						className="button-secondary"
						disabled={pending || chooserPending}
						onClick={() => void refresh()}
						ref={recheckRef}
						type="button"
					>
						{t("Check again")}
					</button>
					{loading && <output className="browser-import-check-status">{t("Checking browser data…")}</output>}
				</div>
				<MenuSelect
					ariaLabel={t("Source browser")}
					disabled={loading || pending || chooserPending || sources.length === 0}
					onChange={selectSource}
					options={sources.map((source) => ({ value: source.sourceId, label: source.name }))}
					placeholder={t("Choose a browser")}
					value={sourceId}
				/>
				<MenuSelect
					ariaLabel={t("Source profile")}
					disabled={
						!selectedSource || selectedSource.profiles.length === 0 || loading || pending || chooserPending
					}
					onChange={selectProfile}
					options={(selectedSource?.profiles ?? []).map((profile) => ({
						value: profile.sourceProfileId,
						label: `${profile.name}${profile.email ? ` · ${profile.email}` : ""}`,
					}))}
					placeholder={t("Choose a profile")}
					value={sourceProfileId}
				/>
				{!loading && sources.length === 0 && !sourceError && (
					<p className="browser-import-empty">{t("No supported browser profiles found")}</p>
				)}
				{!loading && sources.length > 0 && !statusMessage && !sourceError && !selectedProfile && (
					<p className="browser-import-empty">{t("No supported browser profiles found")}</p>
				)}
				{sourceError && (
					<div className="browser-import-warning" role="alert">
						<span>{sourceError}</span>
					</div>
				)}
				{statusMessage && (
					<div className="browser-import-warning" role={statusIsError ? "alert" : "status"}>
						<span>{statusMessage}</span>
						{folderRecovery && (
							<div className="browser-import-actions">
								<button
									className="button-secondary"
									disabled={pending || chooserPending}
									onClick={() => void chooseFolder()}
									ref={chooseFolderRef}
									type="button"
								>
									{t("Choose data folder")}
								</button>
							</div>
						)}
					</div>
				)}
				{selectedSource?.location === "selected" && (
					<p className="browser-import-empty">{t("Using the folder you selected.")}</p>
				)}
				{diagnosticStage && diagnosticCode && (
					<details className="browser-import-diagnostic">
						<summary>{t("Technical details")}</summary>
						<dl>
							<div>
								<dt>{t("Diagnostic stage")}</dt>
								<dd>{diagnosticStage}</dd>
							</div>
							<div>
								<dt>{t("Diagnostic code")}</dt>
								<dd>{diagnosticCode}</dd>
							</div>
						</dl>
					</details>
				)}
				<fieldset aria-label={t("Data to import")} className="control-group browser-import-data">
					{supportsCookieImport && (
						<label>
							<span>{t("Cookies")}</span>
							<small>{t("Import website sign-in state. No numeric limit is applied.")}</small>
							<input
								checked={cookies}
								disabled={pending}
								onChange={(event) => {
									setCookies(event.target.checked);
									setCookieFailure(false);
									setImportError(null);
								}}
								type="checkbox"
							/>
						</label>
					)}
					{!supportsCookieImport && (
						<p className="browser-import-empty">
							{t(
								"On Windows, Metis currently imports browsing history only. Cookies and sign-in state are not imported.",
							)}
						</p>
					)}
					<label>
						<span>{t("Browsing history")}</span>
						<small>{t("Merge with this profile and retain the newest 500 total entries.")}</small>
						<input
							checked={history}
							disabled={pending}
							onChange={(event) => {
								setHistory(event.target.checked);
								setCookieFailure(false);
								setImportError(null);
							}}
							type="checkbox"
						/>
					</label>
				</fieldset>
				{importError && (
					<div className="browser-import-warning" role="alert">
						<span className="mcp-dialog-error">{importError}</span>
						{cookieFailure && (
							<span>{t("Cookies could not be imported. Your selected data types were not changed.")}</span>
						)}
						{cookieFailure && history && (
							<button className="button-secondary" disabled={pending} onClick={retryWithHistory} type="button">
								{t("Retry with history only")}
							</button>
						)}
					</div>
				)}
			</div>
			<div className="mcp-dialog-actions">
				<button className="button-secondary" disabled={pending} onClick={onCancel} type="button">
					{t("Cancel")}
				</button>
				<button aria-busy={pending} disabled={!canImport} onClick={() => void submit()} type="button">
					{t(pending ? "Importing…" : "Import")}
				</button>
			</div>
		</DialogFrame>
	);
}
