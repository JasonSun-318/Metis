import type { WebSearchProvider, WebSearchSettingsView } from "@metis/app-protocol";
import { Eye, EyeSlash, XCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import { FloatingSystemNotice } from "./SystemNotice.tsx";

const PROVIDERS: readonly { readonly value: WebSearchProvider; readonly label: string }[] = [
	{ value: "brave", label: "Brave Search" },
	{ value: "tavily", label: "Tavily" },
	{ value: "serpapi", label: "SerpApi" },
];

export function WebSearchSettingsPanel({
	api,
	serverReady,
	onDirtyChange,
}: {
	readonly api: Pick<
		MetisDesktopApi,
		"getWebSearchSettings" | "revealWebSearchCredential" | "updateWebSearchSettings"
	>;
	readonly onDirtyChange?: (dirty: boolean) => void;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [settings, setSettings] = useState<WebSearchSettingsView | null>(null);
	const [savedSettings, setSavedSettings] = useState<WebSearchSettingsView | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [revealedCredential, setRevealedCredential] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [revealBusy, setRevealBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [request, setRequest] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies(request): Retry explicitly reloads web search settings.
	useEffect(() => {
		if (!serverReady) {
			setRevealedCredential(null);
			return;
		}
		let current = true;
		setError(null);
		void api.getWebSearchSettings().then(
			(result) => {
				if (current) {
					setSettings(result);
					setSavedSettings(result);
					setApiKey("");
					setRevealedCredential(null);
				}
			},
			(cause) => {
				if (current) setError(cause instanceof Error ? cause.message : t("Couldn’t load search settings."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, request, serverReady, t]);

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), 2_500);
		return () => clearTimeout(timer);
	}, [notice]);

	const dirty = Boolean(
		savedSettings &&
			(settings?.enabled !== savedSettings.enabled ||
				settings?.provider !== savedSettings.provider ||
				apiKey.length > 0),
	);
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
	if (!settings) {
		if (!error) {
			return <output aria-label={t("Search settings")} className="status-block settings-loading" />;
		}
		return (
			<section className="settings-section personalization-section web-search-section">
				<header className="settings-section-heading">
					<h3>{t("Search engine")}</h3>
				</header>
				<div className="settings-card web-search-card">
					<div className="web-search-load-error settings-inline-error" role="alert">
						<p>{error}</p>
						<button
							className="settings-secondary-button"
							disabled={!serverReady}
							onClick={() => {
								setError(null);
								setRequest((value) => value + 1);
							}}
							type="button"
						>
							{t("Retry")}
						</button>
					</div>
				</div>
			</section>
		);
	}

	const save = async (credentialAction: "set" | "keep" | "remove") => {
		if (!settings) return;
		if (credentialAction === "set" && !apiKey.trim()) {
			setError(t("Enter an API key to save."));
			return;
		}
		setRevealedCredential(null);
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const next = await api.updateWebSearchSettings({
				enabled: settings.enabled,
				provider: settings.provider,
				credential:
					credentialAction === "set"
						? { action: "set", value: apiKey.trim() }
						: credentialAction === "remove"
							? { action: "remove" }
							: { action: "keep" },
			});
			setSettings(next);
			setSavedSettings(next);
			setApiKey("");
			setRevealedCredential(null);
			setNotice(credentialAction === "remove" ? t("Credentials cleared") : t("Saved"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t save search settings."));
		} finally {
			setBusy(false);
		}
	};

	const update = (patch: Partial<Pick<WebSearchSettingsView, "enabled" | "provider">>) => {
		const providerChanged = patch.provider !== undefined && patch.provider !== settings?.provider;
		setSettings((current) => {
			if (!current) return current;
			const provider = patch.provider ?? current.provider;
			const authConfigured = current.configuredProviders?.includes(provider) ?? false;
			return {
				...current,
				...patch,
				...(providerChanged
					? { authConfigured, authSource: authConfigured ? ("stored" as const) : undefined }
					: {}),
			};
		});
		if (providerChanged) {
			setApiKey("");
			setRevealedCredential(null);
		}
		setNotice(null);
		setError(null);
	};

	const toggleCredentialVisibility = async () => {
		if (!settings?.authConfigured || apiKey) return;
		if (revealedCredential !== null) {
			setRevealedCredential(null);
			return;
		}
		setRevealBusy(true);
		setError(null);
		try {
			const result = await api.revealWebSearchCredential({ provider: settings.provider });
			if (result.credential === null) {
				setSettings((current) =>
					current
						? {
								...current,
								authConfigured: false,
								configuredProviders: current.configuredProviders?.filter(
									(provider) => provider !== current.provider,
								),
								authSource: undefined,
							}
						: current,
				);
				setError(t("Credential is no longer available."));
				return;
			}
			setRevealedCredential(result.credential);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Couldn’t reveal the API key."));
		} finally {
			setRevealBusy(false);
		}
	};

	return (
		<section className="settings-section personalization-section web-search-section">
			<header className="settings-section-heading">
				<h3>{t("Search engine")}</h3>
			</header>
			<div className="settings-card web-search-card">
				<div className="general-setting-row">
					<div className="general-setting-copy">
						<span>{t("Enable web search")}</span>
						<p>{t("Allow Metis to search the web when a task needs current information.")}</p>
					</div>
					<div className="general-setting-control">
						<label className="web-search-toggle">
							<span className="sr-only">{t("Enable web search")}</span>
							<input
								aria-label={t("Enable web search")}
								checked={settings?.enabled ?? false}
								disabled={!serverReady || busy}
								onChange={(event) => update({ enabled: event.target.checked })}
								aria-checked={settings?.enabled ?? false}
								role="switch"
								type="checkbox"
							/>
							<span aria-hidden="true" className="web-search-toggle-track" />
						</label>
					</div>
				</div>

				<div className="general-setting-row">
					<div className="general-setting-copy">
						<span>{t("Provider")}</span>
						<p>{t("Choose the service used for web searches.")}</p>
					</div>
					<div className="general-setting-control">
						<MenuSelect
							ariaLabel={t("Search provider")}
							className="web-search-provider-select"
							disabled={!serverReady || busy}
							menuAlign="end"
							onChange={(provider) => update({ provider })}
							options={PROVIDERS.map((option) => ({ value: option.value, label: option.label }))}
							value={settings?.provider ?? "brave"}
						/>
					</div>
				</div>

				<div className="general-setting-row web-search-api-row">
					<div className="general-setting-copy">
						<span>{t("API key")}</span>
						<p>
							{settings?.authConfigured
								? t("Credential is stored locally by Metis.")
								: t("API keys are stored locally on this device.")}
						</p>
					</div>
					<div className="general-setting-control web-search-api-key">
						<label className="sr-only" htmlFor="web-search-api-key">
							{t("API key")}
						</label>
						<div className="web-search-api-key-field">
							<input
								autoComplete="off"
								disabled={!serverReady || busy || revealBusy}
								id="web-search-api-key"
								onChange={(event) => {
									setApiKey(event.target.value);
									setRevealedCredential(null);
									setNotice(null);
									setError(null);
								}}
								placeholder={settings?.authConfigured ? "••••••••••••••••••••••••••••••••" : "sk-…"}
								type={revealedCredential === null ? "password" : "text"}
								value={apiKey || revealedCredential || ""}
							/>
							{settings?.authConfigured && !apiKey ? (
								<button
									aria-label={t(revealedCredential === null ? "Show API key" : "Hide API key")}
									className="web-search-api-key-reveal"
									disabled={!serverReady || busy || revealBusy}
									onClick={() => void toggleCredentialVisibility()}
									type="button"
								>
									{revealedCredential === null ? (
										<Eye aria-hidden="true" size={16} />
									) : (
										<EyeSlash aria-hidden="true" size={16} />
									)}
								</button>
							) : null}
						</div>
					</div>
				</div>

				<div className="settings-form-actions web-search-actions">
					{dirty && <output className="settings-unsaved-label">{t("Unsaved changes")}</output>}
					{settings?.authConfigured ? (
						<button
							className="settings-danger-button"
							disabled={busy}
							onClick={() => void save("remove")}
							type="button"
						>
							{t("Clear credentials")}
						</button>
					) : null}
					<button
						className="settings-primary-button"
						disabled={!serverReady || busy}
						onClick={() => void save(apiKey.trim() ? "set" : "keep")}
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
			{notice ? <FloatingSystemNotice title={notice} tone="success" /> : null}
		</section>
	);
}
