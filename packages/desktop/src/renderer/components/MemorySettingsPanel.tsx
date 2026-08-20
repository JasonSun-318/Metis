import type { MemoryEngine, MemorySettingsView } from "@metis/app-protocol";
import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { MenuSelect } from "./MenuSelect.tsx";

const ENGINES: readonly { readonly value: MemoryEngine; readonly labelKey: string }[] = [
	{ value: "index", labelKey: "Index (catalog)" },
	{ value: "extract", labelKey: "Extract (retrieve)" },
];

export function MemorySettingsPanel({ api, serverReady }: {
	readonly api: Pick<MetisDesktopApi, "getMemorySettings" | "updateMemorySettings">;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [settings, setSettings] = useState<MemorySettingsView | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.getMemorySettings().then(
			(result) => {
				if (current) setSettings(result);
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

	if (!settings && !error) {
		return <div aria-label={t("Memory settings")} className="settings-loading" role="status" />;
	}

	const embeddingConfigured = Boolean(settings?.memoryEmbeddingModel.trim());
	const extractBlocked = !embeddingConfigured;
	const engineWarning =
		settings?.memoryEngine === "extract" && extractBlocked
			? t("Extract requires an embedding model (provider/model) before it can be enabled.")
			: extractBlocked
				? t("Set an embedding model before choosing Extract. Extract retrieves relevant facts; Index injects the memory catalog.")
				: null;

	const update = (patch: Partial<MemorySettingsView>) => {
		setSettings((current) => (current ? { ...current, ...patch } : current));
		setNotice(null);
		setError(null);
	};

	const save = async () => {
		if (!settings) return;
		if (settings.memoryEngine === "extract" && !settings.memoryEmbeddingModel.trim()) {
			setError(t("Extract requires an embedding model (provider/model) before it can be enabled."));
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const next = await api.updateMemorySettings({
				autoMemoryEnabled: settings.autoMemoryEnabled,
				memoryEngine: settings.memoryEngine,
				memoryEmbeddingModel: settings.memoryEmbeddingModel.trim(),
				memoryRerankModel: settings.memoryRerankModel.trim(),
			});
			setSettings(next);
			setNotice(t("Saved"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t save memory settings."));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="settings-section personalization-section memory-settings-section">
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

				<div className="general-setting-row">
					<div className="general-setting-copy">
						<span>{t("Memory engine")}</span>
						<p>{t("Index injects the memory catalog. Extract retrieves relevant facts for the current message.")}</p>
					</div>
					<div className="general-setting-control">
						<MenuSelect
							ariaLabel={t("Memory engine")}
							className="memory-engine-select"
							disabled={!serverReady || busy}
							menuAlign="end"
							onChange={(memoryEngine) => update({ memoryEngine })}
							options={ENGINES.map((option) => ({
								value: option.value,
								label: t(option.labelKey),
								disabled: option.value === "extract" && extractBlocked,
							}))}
							value={settings?.memoryEngine ?? "index"}
						/>
					</div>
				</div>

				<div className="general-setting-row">
					<div className="general-setting-copy">
						<span>{t("Embedding model")}</span>
						<p>{t("Required for Extract. Use provider/model, for example openai/text-embedding-3-small.")}</p>
					</div>
					<div className="general-setting-control memory-model-input">
						<label className="sr-only" htmlFor="memory-embedding-model">{t("Embedding model")}</label>
						<input
							autoComplete="off"
							disabled={!serverReady || busy}
							id="memory-embedding-model"
							onChange={(event) => update({ memoryEmbeddingModel: event.target.value })}
							placeholder="openai/text-embedding-3-small"
							spellCheck={false}
							type="text"
							value={settings?.memoryEmbeddingModel ?? ""}
						/>
					</div>
				</div>

				<div className="general-setting-row">
					<div className="general-setting-copy">
						<span>{t("Rerank model")}</span>
						<p>{t("Optional. Improves Extract ranking when configured.")}</p>
					</div>
					<div className="general-setting-control memory-model-input">
						<label className="sr-only" htmlFor="memory-rerank-model">{t("Rerank model")}</label>
						<input
							autoComplete="off"
							disabled={!serverReady || busy}
							id="memory-rerank-model"
							onChange={(event) => update({ memoryRerankModel: event.target.value })}
							placeholder={t("Optional")}
							spellCheck={false}
							type="text"
							value={settings?.memoryRerankModel ?? ""}
						/>
					</div>
				</div>

				{engineWarning ? (
					<p className="settings-action-message memory-settings-warning" role="status">
						{engineWarning}
					</p>
				) : null}

				<div className="settings-form-actions web-search-actions">
					<button
						className="settings-primary-button"
						disabled={!serverReady || busy || (settings?.memoryEngine === "extract" && extractBlocked)}
						onClick={() => void save()}
						type="button"
					>
						{busy ? t("Saving…") : t("Save")}
					</button>
				</div>

				{error ? (
					<p className="settings-action-message error web-search-message" role="alert">
						<XCircle aria-hidden="true" size={15} />
						{error}
					</p>
				) : null}
			</div>
			{notice ? (
				<div className="toast settings-toast" role="status">
					<CheckCircle aria-hidden="true" size={15} />
					{notice}
				</div>
			) : null}
		</section>
	);
}
