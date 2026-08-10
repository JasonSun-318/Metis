import type {
	ModelSettingsProviderView,
	ModelSettingsView,
	ThinkingSelectionView,
} from "@metis/app-protocol";
import { CheckCircle, Key, X, XCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { MenuSelect } from "./MenuSelect.tsx";

interface ProviderDraft {
	readonly provider: string;
	readonly name: string;
	readonly apiKey: string;
	readonly testModelId: string;
}

function providerDraft(provider: ModelSettingsProviderView, defaultModel: ModelSettingsView["defaultModel"]): ProviderDraft {
	return {
		provider: provider.provider,
		name: provider.name,
		apiKey: "",
		testModelId: defaultModel?.provider === provider.provider
			? defaultModel.modelId
			: provider.models[0]?.modelId ?? "",
	};
}

const THINKING_LEVELS: readonly ThinkingSelectionView[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function ModelSettingsPanel({ api, serverReady }: {
	readonly api: Pick<MetisDesktopApi, "getModelSettings" | "updateModelSettings" | "testModelConnection">;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [settings, setSettings] = useState<ModelSettingsView | null>(null);
	const [draft, setDraft] = useState<ProviderDraft | null>(null);
	const [defaultThinking, setDefaultThinking] = useState<ThinkingSelectionView>("medium");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const providerDialogRef = useRef<HTMLDialogElement>(null);

	const applySettings = useCallback((next: ModelSettingsView) => {
		setSettings(next);
		setDefaultThinking(next.defaultThinkingSelection);
	}, []);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.getModelSettings().then(
			(result) => { if (current) applySettings(result); },
			(cause) => { if (current) setError(cause instanceof Error ? cause.message : t("Model settings could not be loaded.")); },
		);
		return () => { current = false; };
	}, [api, applySettings, serverReady, t]);

	const selectedProvider = draft
		? settings?.providers.find((provider) => provider.provider === draft.provider)
		: undefined;
	const providers = useMemo(
		() => [...(settings?.providers ?? [])].sort((left, right) =>
			Number(right.auth.configured) - Number(left.auth.configured) || left.name.localeCompare(right.name)),
		[settings],
	);

	const closeProvider = useCallback(() => {
		setDraft(null);
		setError(null);
		setNotice(null);
	}, []);

	useEffect(() => {
		if (!draft) return;
		const dialog = providerDialogRef.current;
		if (!dialog) return;
		try {
			if (typeof dialog.showModal === "function") dialog.showModal();
			else dialog.setAttribute("open", "");
		} catch {
			dialog.setAttribute("open", "");
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			closeProvider();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
		};
	}, [closeProvider, draft?.provider]);

	const runUpdate = async (mutation: Parameters<MetisDesktopApi["updateModelSettings"]>[0]["mutation"], success: string) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const next = await api.updateModelSettings({ requestId: crypto.randomUUID(), mutation });
			applySettings(next);
			setNotice(success);
			return next;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Model settings could not be saved."));
			return null;
		} finally {
			setBusy(false);
		}
	};

	const saveDefaults = () => {
		if (!draft?.testModelId) return;
		void runUpdate({
			type: "set_defaults",
			model: { provider: draft.provider, modelId: draft.testModelId },
			thinkingSelection: defaultThinking,
		}, t("Defaults saved"));
	};

	const saveProvider = async (credentialAction: "set" | "remove" = "set") => {
		if (!draft) return;
		if (credentialAction === "set" && !draft.apiKey.trim()) {
			setError(t("Enter an API key to save."));
			return;
		}
		const next = await runUpdate({
			type: "save_provider",
			provider: draft.provider,
			name: draft.name,
			baseUrl: null,
			api: null,
			models: [],
			credential: credentialAction === "remove"
				? { action: "remove" }
				: { action: "set", value: draft.apiKey.trim() },
		}, credentialAction === "remove" ? t("Credentials cleared") : t("Provider saved"));
		if (!next) return;
		const saved = next.providers.find((item) => item.provider === draft.provider);
		setDraft(saved ? providerDraft(saved, next.defaultModel) : null);
	};

	const testConnection = async () => {
		const testModelId = draft?.testModelId;
		if (!selectedProvider || !testModelId) return;
		const model = selectedProvider.models.find((candidate) => candidate.modelId === testModelId) ?? selectedProvider.models[0];
		if (!model) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.testModelConnection({ requestId: crypto.randomUUID(), provider: selectedProvider.provider, modelId: model.modelId });
			setNotice(`${t(result.ok ? "Connection succeeded" : "Connection failed")} · ${result.latencyMs} ms${result.ok ? "" : ` · ${result.message}`}`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Connection test failed."));
		} finally {
			setBusy(false);
		}
	};

	const openProvider = (provider: ModelSettingsProviderView) => {
		setError(null);
		setNotice(null);
		setDraft(providerDraft(provider, settings?.defaultModel ?? null));
	};

	if (!settings && !error) return <div aria-label={t("Loading model settings")} className="settings-loading" role="status" />;
	const thinkingOptions = THINKING_LEVELS.map((level) => ({
		value: level,
		label: t(level === "off" ? "Off" : level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1)),
	}));
	return (
		<section className="settings-page model-settings-page">
			<p className="model-provider-intro">{t("Select a provider to configure its credentials. Built-in model details stay managed by Metis.")}</p>
			{settings?.loadError ? <p className="settings-inline-error" role="alert">{settings.loadError}</p> : null}
			<div className="model-provider-grid">
				{providers.map((provider) => (
					<button aria-haspopup="dialog" className="model-provider-card" key={provider.provider} onClick={() => openProvider(provider)} type="button">
						<span className="model-provider-card-heading"><strong>{provider.name}</strong><span className={provider.auth.configured ? "configured" : ""}>{provider.auth.configured ? t("Configured") : t("Set up")}</span></span>
						<small>{t("{{count}} models", { count: provider.models.length })}</small>
					</button>
				))}
			</div>
			{draft ? <dialog
				aria-label={t("Configure {{provider}}", { provider: draft.name })}
				className="model-provider-dialog"
				onCancel={(event) => { event.preventDefault(); closeProvider(); }}
				onClick={(event) => { if (event.target === event.currentTarget) closeProvider(); }}
				ref={providerDialogRef}
			>
				<div className="model-provider-dialog-content">
					<form className="model-provider-editor" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
						<header className="model-provider-editor-header">
							<div><h2>{draft.name}</h2><p>{t("Add the provider API key. Endpoint, protocol, and model catalog are already configured.")}</p></div>
							<div className="model-provider-dialog-heading-actions">
								{selectedProvider ? <span className={selectedProvider.auth.configured ? "configured" : ""}>{selectedProvider.auth.configured ? <CheckCircle aria-hidden="true" size={14} /> : <Key aria-hidden="true" size={14} />}{selectedProvider.auth.configured ? t("Configured") : t("Not configured")}</span> : null}
								<button aria-label={t("Close provider settings")} className="model-provider-dialog-close" onClick={closeProvider} type="button"><X aria-hidden="true" size={18} /></button>
							</div>
						</header>

						{selectedProvider?.auth.configured ? <div className="model-saved-credential"><span>{t("Saved API key")}</span><code>••••••••••••</code></div> : null}
						<label className="model-api-key-field"><span>{t("API key")}</span><input aria-describedby="model-auth-source" autoComplete="off" onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={selectedProvider?.auth.configured ? t("Enter a new key to replace the saved credential") : "sk-…"} type="password" value={draft.apiKey} /></label>
						<p className="model-auth-source" id="model-auth-source">{selectedProvider?.auth.configured
							? selectedProvider.auth.source === "environment" ? t("Configured by environment: {{source}}", { source: selectedProvider.auth.label ?? t("environment") }) : t("Credential is stored locally by Metis.")
							: t("This provider is unavailable until credentials are configured.")}</p>

						<div className="settings-form-actions">
							{selectedProvider?.auth.source === "stored" || selectedProvider?.auth.source === "oauth" ? <button className="settings-danger-button" disabled={busy} onClick={() => void saveProvider("remove")} type="button">{t("Clear credentials")}</button> : null}
							{selectedProvider?.auth.configured && selectedProvider.models.length > 0 ? <button className="settings-secondary-button" disabled={busy} onClick={() => void testConnection()} type="button">{t("Test connection")}</button> : null}
							<button className="settings-primary-button" disabled={busy || !serverReady || !draft.apiKey.trim()} type="submit">{busy ? t("Saving…") : t("Save API key")}</button>
						</div>
						{selectedProvider?.auth.configured && selectedProvider.models.length > 0 ? <div className="model-use-section">
							<div><h2>{t("Default model")}</h2><p>{t("Choose the model and reasoning effort used for new tasks.")}</p></div>
							<div className="model-use-row">
								<label><span>{t("Model")}</span><MenuSelect ariaLabel={t("Default model")} disabled={busy} onChange={(testModelId) => setDraft({ ...draft, testModelId })} options={selectedProvider.models.map((model) => ({ value: model.modelId, label: model.name }))} value={draft.testModelId} /></label>
								<label><span>{t("Default reasoning")}</span><MenuSelect ariaLabel={t("Default reasoning")} disabled={busy} onChange={setDefaultThinking} options={thinkingOptions} value={defaultThinking} /></label>
								<button className="settings-primary-button" disabled={busy || !draft.testModelId} onClick={saveDefaults} type="button">{t("Use this model")}</button>
							</div>
						</div> : null}
					</form>
					{error ? <p className="settings-action-message error" role="alert"><XCircle aria-hidden="true" size={15} />{error}</p> : null}
					{notice ? <p className="settings-action-message" role="status"><CheckCircle aria-hidden="true" size={15} />{notice}</p> : null}
				</div>
			</dialog> : null}
			{error && !draft ? <p className="settings-action-message error" role="alert"><XCircle aria-hidden="true" size={15} />{error}</p> : null}
		</section>
	);
}
