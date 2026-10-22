import { X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	DesktopBrowserImportResult,
	DesktopBrowserImportSource,
	DesktopBrowserSourceId,
	MetisDesktopApi,
} from "../../shared/desktop-api.ts";
import { DialogFrame } from "./DialogFrame.tsx";
import { MenuSelect } from "./MenuSelect.tsx";

interface BrowserImportDialogProps {
	readonly api: MetisDesktopApi;
	readonly onCancel: () => void;
	readonly onImported: (result: DesktopBrowserImportResult) => void;
}

export function BrowserImportDialog({ api, onCancel, onImported }: BrowserImportDialogProps) {
	const { t } = useTranslation();
	const closeRef = useRef<HTMLButtonElement>(null);
	const supportsCookieImport = api.platform === "darwin";
	const [sources, setSources] = useState<readonly DesktopBrowserImportSource[]>([]);
	const [sourceId, setSourceId] = useState<DesktopBrowserSourceId | "">("");
	const [sourceProfileId, setSourceProfileId] = useState("");
	const [cookies, setCookies] = useState(supportsCookieImport);
	const [history, setHistory] = useState(true);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [sourceError, setSourceError] = useState<string | null>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const selectedSource = sources.find((source) => source.sourceId === sourceId);
	const selectedProfile = selectedSource?.profiles.find((profile) => profile.sourceProfileId === sourceProfileId);
	const canImport = Boolean(
		selectedSource && selectedProfile && (cookies || history) && !selectedSource.running && !pending,
	);

	const refresh = useCallback(async () => {
		setLoading(true);
		setSourceError(null);
		try {
			const found = await api.listBrowserImportSources();
			setSources(found);
			const source = found[0];
			setSourceId(source?.sourceId ?? "");
			setSourceProfileId(source?.profiles[0]?.sourceProfileId ?? "");
		} catch (cause) {
			setSourceError(cause instanceof Error ? cause.message : t("Browser data could not be imported"));
		} finally {
			setLoading(false);
		}
	}, [api, t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const submit = async () => {
		if (!canImport || !sourceId) return;
		setPending(true);
		setImportError(null);
		try {
			onImported(
				await api.importBrowserData({
					sourceId,
					sourceProfileId,
					dataTypes: { cookies: supportsCookieImport && cookies, history },
				}),
			);
		} catch (cause) {
			setImportError(cause instanceof Error ? cause.message : t("Browser data could not be imported"));
			setPending(false);
		}
	};

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
			<div className="browser-import-fields">
				<MenuSelect
					ariaLabel={t("Source browser")}
					disabled={loading || pending || sources.length === 0}
					onChange={(value) => {
						setSourceId(value);
						setSourceProfileId(
							sources.find((source) => source.sourceId === value)?.profiles[0]?.sourceProfileId ?? "",
						);
					}}
					options={sources.map((source) => ({ value: source.sourceId, label: source.name }))}
					placeholder={t("Choose a browser")}
					value={sourceId}
				/>
				<MenuSelect
					ariaLabel={t("Source profile")}
					disabled={!selectedSource || loading || pending}
					onChange={setSourceProfileId}
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
				{sourceError && (
					<div className="browser-import-warning" role="alert">
						<span>{sourceError}</span>
						<button className="button-secondary" disabled={loading} onClick={() => void refresh()} type="button">
							{t("Retry")}
						</button>
					</div>
				)}
				{selectedSource?.running && (
					<div className="browser-import-warning" role="alert">
						<span>
							{t("Close {{browser}} before importing, then check again.", { browser: selectedSource.name })}
						</span>
						<button className="button-secondary" disabled={loading} onClick={() => void refresh()} type="button">
							{t("Check again")}
						</button>
					</div>
				)}
				<fieldset aria-label={t("Data to import")} className="control-group browser-import-data">
					{supportsCookieImport && (
						<label>
							<span>{t("Cookies")}</span>
							<small>{t("Import website sign-in state. No numeric limit is applied.")}</small>
							<input
								checked={cookies}
								disabled={pending}
								onChange={(event) => setCookies(event.target.checked)}
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
							onChange={(event) => setHistory(event.target.checked)}
							type="checkbox"
						/>
					</label>
				</fieldset>
				{importError && (
					<p className="mcp-dialog-error" role="alert">
						{importError}
					</p>
				)}
			</div>
			<div className="mcp-dialog-actions">
				<button className="button-secondary" disabled={pending} onClick={onCancel} type="button">
					{t("Cancel")}
				</button>
				<button disabled={!canImport} onClick={() => void submit()} type="button">
					{t(pending ? "Importing…" : "Import")}
				</button>
			</div>
		</DialogFrame>
	);
}
