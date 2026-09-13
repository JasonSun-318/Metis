import type { MemorySettingsView } from "@metis/app-protocol";
import { BookBookmark, Cpu, Info, Sparkle, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { FloatingSystemNotice } from "./SystemNotice.tsx";
export function MemorySettingsPanel({ api, onConfigureModels, serverReady, onDirtyChange }: {
	readonly api: Pick<MetisDesktopApi, "getMemorySettings" | "updateMemorySettings">;
	readonly onConfigureModels: () => void;
	readonly onDirtyChange?: (dirty: boolean) => void;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [settings, setSettings] = useState<MemorySettingsView | null>(null);
	const [savedSettings, setSavedSettings] = useState<MemorySettingsView | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.getMemorySettings().then(
			(result) => {
				if (current) { setSettings(result); setSavedSettings(result); }
			},
			(cause) => {
				if (current) setError(cause instanceof Error ? cause.message : t("Couldn’t load memory settings."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, serverReady, t]);

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), 2_500);
		return () => clearTimeout(timer);
	}, [notice]);

	const dirty = Boolean(savedSettings && (settings?.autoMemoryEnabled !== savedSettings.autoMemoryEnabled || settings?.memoryEngine !== savedSettings.memoryEngine));
	useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
	if (!settings && !error) {
		return <div aria-label={t("Memory settings")} className="settings-loading" role="status" />;
	}

	const embeddingConfigured = settings?.embeddingConfigured ?? false;
	const extractBlocked = !embeddingConfigured;
	const engineWarning =
		settings?.memoryEngine === "extract" && extractBlocked
			? t("Extract requires a configured Embedding model and credential before it can be enabled.")
			: extractBlocked
				? t("Configure an Embedding model before choosing Extract. Index injects the memory catalog.")
				: null;

	const update = (patch: Partial<MemorySettingsView>) => {
		setSettings((current) => (current ? { ...current, ...patch } : current));
		setNotice(null);
		setError(null);
	};

	const save = async () => {
		if (!settings) return;
		if (settings.memoryEngine === "extract" && !settings.embeddingConfigured) {
			setError(t("Extract requires a configured Embedding model and credential before it can be enabled."));
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const next = await api.updateMemorySettings({
				autoMemoryEnabled: settings.autoMemoryEnabled,
				memoryEngine: settings.memoryEngine,
			});
			setSettings(next);
			setSavedSettings(next);
			setNotice(t("Saved"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t save memory settings."));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="settings-page memory-page">
			<section className="settings-section memory-settings-section">
				<header className="settings-section-heading">
					<h3>{t("Long-term memory")}</h3>
				</header>
				<div className="settings-card memory-settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Enable long-term memory")}</span>
							<p>{t("Keep facts outside session history and inject them into new turns.")}</p>
						</div>
						<div className="general-setting-control">
							<label className="web-search-toggle">
								<span className="sr-only">{t("Enable long-term memory")}</span>
								<input
									aria-label={t("Enable long-term memory")}
									checked={settings?.autoMemoryEnabled ?? false}
									disabled={!serverReady || busy}
									onChange={(event) => update({ autoMemoryEnabled: event.target.checked })}
									role="switch"
									type="checkbox"
								/>
								<span aria-hidden="true" className="web-search-toggle-track" />
							</label>
						</div>
					</div>
				</div>
			</section>

			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Memory engine")}</h3>
				</header>
				<div className="settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Active engine")}</span>
							<p>{t("Index injects the memory catalog. Extract retrieves relevant facts for the current message.")}</p>
						</div>
					</div>

					<div aria-label={t("Memory engine")} className="memory-engine-grid" role="group">
						<button
							className={`memory-engine-card ${settings?.memoryEngine === "index" ? "selected" : ""}`}
							onClick={() => update({ memoryEngine: "index" })}
							type="button"
							aria-pressed={settings?.memoryEngine === "index"}
							disabled={!serverReady || busy}
						>
							<div className="memory-engine-card-header">
								<div className="memory-engine-card-title">
									<BookBookmark aria-hidden="true" size={16} />
									<strong>{t("Index (catalog)")}</strong>
								</div>
								<span className="memory-engine-badge">{t("Zero-config")}</span>
							</div>
							<p className="memory-engine-card-desc">
								{t("Injects memory catalog outlines directly into prompt context. Lightweight, deterministic, and works without embedding models.")}
							</p>
						</button>

						<button
							className={`memory-engine-card ${settings?.memoryEngine === "extract" ? "selected" : ""} ${extractBlocked ? "disabled" : ""}`}
							onClick={() => { if (!extractBlocked) update({ memoryEngine: "extract" }); }}
							type="button"
							aria-pressed={settings?.memoryEngine === "extract"}
							disabled={!serverReady || busy || extractBlocked}
						>
							<div className="memory-engine-card-header">
								<div className="memory-engine-card-title">
									<Sparkle aria-hidden="true" size={16} />
									<strong>{t("Extract (retrieve)")}</strong>
								</div>
								<span className={`memory-engine-badge ${embeddingConfigured ? "configured" : "warning"}`}>
									{embeddingConfigured ? t("Ready") : t("Embedding needed")}
								</span>
							</div>
							<p className="memory-engine-card-desc">
								{t("Performs semantic vector search over memory items. Retrieves only targeted, highly relevant facts for each user query.")}
							</p>
						</button>
					</div>

					<div className="memory-info-banner">
						<Info aria-hidden="true" size={15} />
						<span>{t("Extract sends the bounded query and stored facts to your Embedding service, and candidates to optional Rerank.")}</span>
					</div>

					{engineWarning ? (
						<div className={`${settings?.memoryEngine === "extract" ? "memory-warning-banner" : "memory-info-banner"} memory-settings-warning`} role="status">
							<Info aria-hidden="true" size={15} />
							<span>{engineWarning}</span>
						</div>
					) : null}
					{settings?.memoryMigrationNotice ? (
						<div className="memory-warning-banner memory-settings-warning" role="status">
							<WarningCircle aria-hidden="true" size={15} />
							<span>{settings.memoryMigrationNotice}</span>
						</div>
					) : null}
					{settings?.lastError ? (
						<div className="settings-action-message error memory-error-banner" role="alert">
							<XCircle aria-hidden="true" size={15} />
							<span>{settings.lastError}</span>
						</div>
					) : null}
				</div>
			</section>

			<section className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Model dependencies")}</h3>
				</header>
				<div className="settings-card">
					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Embedding model")}</span>
							<p>{embeddingConfigured ? t("Configured in Model settings.") : t("Required for Extract and not configured.")}</p>
						</div>
						<div className="general-setting-control">
							<span className={`model-provider-badge ${embeddingConfigured ? "configured" : ""}`}>
								{embeddingConfigured ? t("Configured") : t("Not configured")}
							</span>
						</div>
					</div>

					<div className="general-setting-row">
						<div className="general-setting-copy">
							<span>{t("Rerank model")}</span>
							<p>{t("Optional. Reranks up to 50 candidate facts when configured.")}</p>
						</div>
						<div className="general-setting-control">
							<span className={`model-provider-badge ${settings?.rerankConfigured ? "configured" : ""}`}>
								{settings?.rerankConfigured ? t("Configured") : t("Not configured")}
							</span>
						</div>
					</div>

					<div className="memory-models-action-row">
						<p>{t("Configure embedding and rerank models in Model settings to power Extract mode.")}</p>
						<button className="settings-secondary-button" disabled={!serverReady || busy} onClick={onConfigureModels} type="button">
							<Cpu aria-hidden="true" size={15} />
							{t("Configure in Models")}
						</button>
					</div>
				</div>
			</section>

			<div className="settings-form-actions memory-form-actions">
				{dirty && <span className="settings-unsaved-label" role="status">{t("Unsaved changes")}</span>}
				{error ? (
					<p className="settings-action-message error web-search-message" role="alert">
						<XCircle aria-hidden="true" size={15} />
						{error}
					</p>
				) : null}
				<button
					className="settings-primary-button"
					disabled={!serverReady || busy || (settings?.memoryEngine === "extract" && extractBlocked)}
					onClick={() => void save()}
					type="button"
				>
					{busy ? t("Saving…") : t("Save")}
				</button>
			</div>

			{notice ? <FloatingSystemNotice title={notice} tone="success" /> : null}
		</div>
	);
}
