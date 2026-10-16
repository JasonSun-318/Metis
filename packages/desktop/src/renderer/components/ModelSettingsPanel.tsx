import type {
	ModelSettingsProviderView,
	ModelSettingsView,
	ThinkingSelectionView,
	VisionApiView,
} from "@metis/app-protocol";
import { CheckCircle, Key, Plus, Trash, X, XCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { MenuSelect } from "./MenuSelect.tsx";

interface ProviderDraft {
	readonly provider: string;
	readonly name: string;
	readonly apiKey: string;
	readonly testModelId: string;
}

type CustomProviderApi = "openai-responses" | "openai-completions" | "anthropic-messages";
type VisionApiFormat = VisionApiView;

interface VisionDraft {
	name: string;
	baseUrl: string;
	api: VisionApiFormat;
	modelId: string;
	apiKey: string;
}

interface CustomModelDraft {
	readonly key: string;
	readonly modelId: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	/** 推理能力来源：自动匹配内置目录、关闭，或按通用 low/medium/high 处理。 */
	readonly reasoningMode: "auto" | "off" | "generic";
	/** 服务端解析结果；未保存的新模型为 null。 */
	readonly reasoningSource: "catalog" | "generic" | "off" | "unrecognized" | null;
	/** 当前模型可用的思考等级；未保存的草稿按所选模式预览。 */
	readonly thinkingLevels: readonly ThinkingSelectionView[];
	/** 模型是否支持图片输入；保存时映射为 input: ["text", "image"]。 */
	readonly imageInput: boolean;
}

interface CustomProviderDraft {
	readonly provider: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: CustomProviderApi;
	readonly apiKey: string;
	readonly testModelId: string;
	readonly models: CustomModelDraft[];
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const API_FORMATS: readonly { readonly value: CustomProviderApi; readonly label: string }[] = [
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "openai-completions", label: "OpenAI Completions" },
	{ value: "anthropic-messages", label: "Anthropic Messages" },
];

function customProviderDraft(
	provider: ModelSettingsProviderView | undefined,
	defaultModel: ModelSettingsView["defaultModel"],
): CustomProviderDraft {
	if (provider) {
		return {
			provider: provider.provider,
			name: provider.name,
			baseUrl: provider.baseUrl ?? "",
			api:
				provider.api === "anthropic-messages" || provider.api === "openai-completions"
					? provider.api
					: "openai-responses",
			apiKey: "",
			testModelId:
				defaultModel?.provider === provider.provider ? defaultModel.modelId : (provider.models[0]?.modelId ?? ""),
			models: provider.models.map((model) => ({
				key: crypto.randomUUID(),
				modelId: model.modelId,
				name: model.name,
				contextWindow: model.contextWindow,
				maxOutputTokens: model.maxOutputTokens,
				reasoningMode: model.reasoningMode ?? "auto",
				reasoningSource: model.reasoningSource,
				thinkingLevels: model.thinkingLevels,
				imageInput: model.imageInput,
			})),
		};
	}
	return {
		provider: "",
		name: "",
		baseUrl: "",
		api: "openai-responses",
		apiKey: "",
		testModelId: "",
		models: [newCustomModelDraft()],
	};
}

function newCustomModelDraft(): CustomModelDraft {
	return {
		key: crypto.randomUUID(),
		modelId: "",
		name: "",
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		reasoningMode: "auto",
		reasoningSource: null,
		thinkingLevels: ["off"],
		imageInput: false,
	};
}

const GENERIC_REASONING_LEVELS: readonly ThinkingSelectionView[] = ["off", "low", "medium", "high"];

/** Draft-time preview of the levels a reasoning mode offers; the server is authoritative after save. */
function previewThinkingLevels(mode: CustomModelDraft["reasoningMode"]): readonly ThinkingSelectionView[] {
	return mode === "generic" ? GENERIC_REASONING_LEVELS : ["off"];
}

function clampTokenCount(value: number, fallback: number): number {
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(10_000_000, Math.max(1, Math.trunc(value)));
}

function providerDraft(
	provider: ModelSettingsProviderView,
	defaultModel: ModelSettingsView["defaultModel"],
): ProviderDraft {
	return {
		provider: provider.provider,
		name: provider.name,
		apiKey: "",
		testModelId:
			defaultModel?.provider === provider.provider ? defaultModel.modelId : (provider.models[0]?.modelId ?? ""),
	};
}

const THINKING_LEVELS: readonly ThinkingSelectionView[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const CUSTOM_REASONING_OPTIONS = [
	{ value: "auto", labelKey: "Automatic detection (recommended)" },
	{ value: "off", labelKey: "No reasoning" },
	{ value: "generic", labelKey: "Generic reasoning: Low, medium, high" },
] as const;

function thinkingLevelLabel(level: ThinkingSelectionView): string {
	return level === "off" ? "Off" : level === "xhigh" ? "XHigh" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

export function ModelSettingsPanel({
	api,
	serverReady,
}: {
	readonly api: Pick<MetisDesktopApi, "getModelSettings" | "updateModelSettings" | "testModelConnection">;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const fieldId = useId();
	const [catalogOpen, setCatalogOpen] = useState(false);
	const [providerQuery, setProviderQuery] = useState("");
	const [settings, setSettings] = useState<ModelSettingsView | null>(null);
	const [draft, setDraft] = useState<ProviderDraft | null>(null);
	const [customDraft, setCustomDraft] = useState<CustomProviderDraft | null>(null);
	const [visionDraft, setVisionDraft] = useState<VisionDraft | null>(null);
	const [defaultThinking, setDefaultThinking] = useState<ThinkingSelectionView>("medium");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const providerDialogRef = useRef<HTMLDialogElement>(null);
	const customDialogRef = useRef<HTMLDialogElement>(null);
	const visionDialogRef = useRef<HTMLDialogElement>(null);

	const applySettings = useCallback((next: ModelSettingsView) => {
		setSettings(next);
		setDefaultThinking(next.defaultThinkingSelection);
	}, []);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.getModelSettings().then(
			(result) => {
				if (current) applySettings(result);
			},
			(cause) => {
				if (current) setError(cause instanceof Error ? cause.message : t("Model settings could not be loaded."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, applySettings, serverReady, t]);

	const selectedProvider = draft
		? settings?.providers.find((provider) => provider.provider === draft.provider)
		: undefined;
	const selectedCustomModel = customDraft?.models.find((model) => model.modelId === customDraft.testModelId);
	const selectedDefaultModel = draft
		? (selectedProvider?.models.find((model) => model.modelId === draft.testModelId) ?? selectedProvider?.models[0])
		: undefined;
	const defaultModelLevels: readonly ThinkingSelectionView[] = selectedDefaultModel?.thinkingLevels ?? THINKING_LEVELS;
	const providerDefaultThinking: ThinkingSelectionView = defaultModelLevels.includes(defaultThinking)
		? defaultThinking
		: (defaultModelLevels.at(-1) ?? "off");
	const customModelLevels = selectedCustomModel?.thinkingLevels ?? ["off"];
	const customDefaultThinking: ThinkingSelectionView = customModelLevels.includes(defaultThinking)
		? defaultThinking
		: (customModelLevels.at(-1) ?? "off");
	const providers = useMemo(
		() =>
			[...(settings?.providers ?? [])].sort(
				(left, right) =>
					Number(right.auth.configured) - Number(left.auth.configured) || left.name.localeCompare(right.name),
			),
		[settings],
	);
	const closeProvider = useCallback(() => {
		setDraft(null);
		setCustomDraft(null);
		setError(null);
		setNotice(null);
	}, []);

	const closeCustomEditor = useCallback(() => {
		setCustomDraft(null);
		setDraft(null);
		setError(null);
		setNotice(null);
	}, []);

	const openCustomEditor = useCallback(
		(provider?: ModelSettingsProviderView) => {
			setError(null);
			setNotice(null);
			setDraft(null);
			setCustomDraft(customProviderDraft(provider, settings?.defaultModel ?? null));
		},
		[settings?.defaultModel],
	);

	const customProvider = customDraft?.provider;
	useEffect(() => {
		if (customProvider === undefined) return;
		const dialog = customDialogRef.current;
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
			closeCustomEditor();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
		};
	}, [closeCustomEditor, customProvider]);

	const provider = draft?.provider;
	useEffect(() => {
		if (provider === undefined) return;
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
	}, [closeProvider, provider]);

	const closeVisionEditor = useCallback(() => {
		setVisionDraft(null);
		setError(null);
		setNotice(null);
	}, []);

	const visionOpen = visionDraft !== null;
	useEffect(() => {
		if (!visionOpen) return;
		const dialog = visionDialogRef.current;
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
			closeVisionEditor();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
		};
	}, [closeVisionEditor, visionOpen]);

	const runUpdate = async (
		mutation: Parameters<MetisDesktopApi["updateModelSettings"]>[0]["mutation"],
		success: string,
	) => {
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
		void runUpdate(
			{
				type: "set_defaults",
				model: { provider: draft.provider, modelId: draft.testModelId },
				thinkingSelection: providerDefaultThinking,
			},
			t("Defaults saved"),
		);
	};

	const openVisionEditor = () => {
		const current = settings?.vision;
		setError(null);
		setNotice(null);
		setVisionDraft({
			name: current?.name ?? "",
			baseUrl: current?.baseUrl ?? "",
			api: current?.api ?? "openai-responses",
			modelId: current?.modelId ?? "",
			apiKey: "",
		});
	};

	const saveVision = async () => {
		if (!visionDraft) return;
		const name = visionDraft.name.trim();
		const baseUrl = visionDraft.baseUrl.trim();
		const modelId = visionDraft.modelId.trim();
		if (!name || !baseUrl || !modelId) {
			setError(t("Fill in the name, base URL, and model ID."));
			return;
		}
		if (!/^https?:\/\//iu.test(baseUrl)) {
			setError(t("Enter a valid https:// or http:// URL"));
			return;
		}
		const apiKey = visionDraft.apiKey.trim();
		const credential = apiKey
			? { action: "set" as const, value: apiKey }
			: settings?.vision?.authConfigured
				? { action: "keep" as const }
				: undefined;
		if (!credential) {
			setError(t("Enter an API key to save."));
			return;
		}
		const next = await runUpdate(
			{
				type: "set_vision",
				settings: { name, baseUrl, api: visionDraft.api, modelId },
				credential,
			},
			t("Vision model saved"),
		);
		if (!next) return;
		setVisionDraft(null);
	};

	const clearVision = async () => {
		if (!settings?.vision) return;
		const next = await runUpdate(
			{ type: "set_vision", settings: null, credential: { action: "remove" } },
			t("Vision model removed"),
		);
		if (!next) return;
		setVisionDraft(null);
	};

	const saveProvider = async (credentialAction: "set" | "remove" = "set") => {
		if (!draft) return;
		if (credentialAction === "set" && !draft.apiKey.trim()) {
			setError(t("Enter an API key to save."));
			return;
		}
		const next = await runUpdate(
			{
				type: "save_provider",
				provider: draft.provider,
				name: draft.name,
				baseUrl: null,
				api: null,
				models: [],
				credential:
					credentialAction === "remove" ? { action: "remove" } : { action: "set", value: draft.apiKey.trim() },
			},
			credentialAction === "remove" ? t("Credentials cleared") : t("Provider saved"),
		);
		if (!next) return;
		const saved = next.providers.find((item) => item.provider === draft.provider);
		setDraft(saved ? providerDraft(saved, next.defaultModel) : null);
	};

	const testConnection = async () => {
		const testModelId = draft?.testModelId;
		if (!selectedProvider || !testModelId) return;
		const model =
			selectedProvider.models.find((candidate) => candidate.modelId === testModelId) ?? selectedProvider.models[0];
		if (!model) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.testModelConnection({
				requestId: crypto.randomUUID(),
				kind: "chat",
				provider: selectedProvider.provider,
				modelId: model.modelId,
			});
			setNotice(
				`${t(result.ok ? "Connection succeeded" : "Connection failed")} · ${result.latencyMs} ms${result.ok ? "" : ` · ${result.message}`}`,
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Connection test failed."));
		} finally {
			setBusy(false);
		}
	};

	const testCustomConnection = async () => {
		if (!customDraft || !customDraft.testModelId) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.testModelConnection({
				requestId: crypto.randomUUID(),
				kind: "chat",
				provider: customDraft.provider,
				modelId: customDraft.testModelId,
			});
			setNotice(
				`${t(result.ok ? "Connection succeeded" : "Connection failed")} · ${result.latencyMs} ms${result.ok ? "" : ` · ${result.message}`}`,
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Connection test failed."));
		} finally {
			setBusy(false);
		}
	};

	const saveCustomProvider = async () => {
		if (!customDraft) return;
		const name = customDraft.name.trim();
		const baseUrl = customDraft.baseUrl.trim();
		// 编辑已有供应商时保留原 provider id，只更新显示名；新建时由名称派生 id。
		const provider = customDraft.provider.trim() || name;
		if (!name) {
			setError(t("Enter a provider name"));
			return;
		}
		const conflict = settings?.providers.some(
			(candidate) => candidate.provider === provider && candidate.provider !== customDraft.provider,
		);
		if (conflict) {
			setError(t("A provider with this name already exists"));
			return;
		}
		if (!/^https?:\/\//iu.test(baseUrl)) {
			setError(t("Enter a valid https:// or http:// URL"));
			return;
		}
		// 编辑已有供应商时，key 留空表示保留已保存的凭据；新建则必须有 key。
		const existingProvider = settings?.providers.find((candidate) => candidate.provider === provider);
		const apiKey = customDraft.apiKey.trim();
		const credential = apiKey
			? { action: "set" as const, value: apiKey }
			: existingProvider?.auth.configured
				? { action: "keep" as const }
				: undefined;
		if (!credential) {
			setError(t("Enter an API key to save."));
			return;
		}
		const models = customDraft.models
			.map((model) => ({ ...model, modelId: model.modelId.trim(), name: model.name.trim() || model.modelId.trim() }))
			.filter((model) => model.modelId !== "");
		if (models.length === 0) {
			setError(t("Add at least one model"));
			return;
		}
		const modelIds = new Set<string>();
		if (
			models.some((model) => {
				if (modelIds.has(model.modelId)) return true;
				modelIds.add(model.modelId);
				return false;
			})
		) {
			setError(t("Model IDs must be unique"));
			return;
		}
		const next = await runUpdate(
			{
				type: "save_provider",
				provider,
				name,
				baseUrl,
				api: customDraft.api,
				models: models.map((model) => ({
					modelId: model.modelId,
					name: model.name,
					contextWindow: clampTokenCount(model.contextWindow, DEFAULT_CONTEXT_WINDOW),
					maxOutputTokens: clampTokenCount(model.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
					reasoningMode: model.reasoningMode,
					imageInput: model.imageInput,
				})),
				credential,
			},
			t("Provider saved"),
		);
		if (!next) return;
		setCustomDraft(null);
	};

	const removeCustomProvider = async () => {
		if (!customDraft) return;
		const provider = customDraft.provider;
		const next = await runUpdate({ type: "remove_provider", provider }, t("Provider removed"));
		if (!next) return;
		setCustomDraft(null);
	};

	const saveCustomDefaults = () => {
		if (!customDraft?.testModelId) return;
		void runUpdate(
			{
				type: "set_defaults",
				model: { provider: customDraft.provider, modelId: customDraft.testModelId },
				thinkingSelection: customDefaultThinking,
			},
			t("Defaults saved"),
		);
	};

	const updateCustomModel = (index: number, model: CustomModelDraft) => {
		if (!customDraft) return;
		const models = customDraft.models.map((candidate, candidateIndex) =>
			candidateIndex === index ? model : candidate,
		);
		const testModelId = models.some((candidate) => candidate.modelId === customDraft.testModelId)
			? customDraft.testModelId
			: (models[0]?.modelId ?? "");
		setCustomDraft({ ...customDraft, models, testModelId });
	};

	const removeCustomModel = (index: number) => {
		if (!customDraft) return;
		const models = customDraft.models.filter((_, candidateIndex) => candidateIndex !== index);
		const testModelId = models.some((candidate) => candidate.modelId === customDraft.testModelId)
			? customDraft.testModelId
			: (models[0]?.modelId ?? "");
		setCustomDraft({ ...customDraft, models, testModelId });
	};

	const openProvider = (provider: ModelSettingsProviderView) => {
		setError(null);
		setNotice(null);
		if (provider.builtin) {
			setCustomDraft(null);
			setDraft(providerDraft(provider, settings?.defaultModel ?? null));
		} else {
			openCustomEditor(provider);
		}
	};

	const renderProvider = (provider: ModelSettingsProviderView) => (
		<button
			aria-haspopup="dialog"
			className="model-provider-card"
			key={provider.provider}
			onClick={() => openProvider(provider)}
			type="button"
		>
			<span className="model-provider-card-heading">
				<span className="model-provider-card-title">
					<span className={`model-provider-dot ${provider.auth.configured ? "configured" : ""}`} />
					<strong title={provider.name}>{provider.name}</strong>
				</span>
				<span className={`model-provider-badge ${provider.auth.configured ? "configured" : ""}`}>
					{provider.auth.configured ? t("Configured") : t("Set up")}
				</span>
			</span>
			<small>{t("{{count}} models", { count: provider.models.length })}</small>
		</button>
	);
	const availableProviders = providers.filter(
		(provider) =>
			!provider.auth.configured &&
			`${provider.name} ${provider.provider}`.toLocaleLowerCase().includes(providerQuery.trim().toLocaleLowerCase()),
	);

	if (!settings && !error)
		return <output aria-label={t("Loading model settings")} className="status-block settings-loading" />;
	const thinkingOptions = THINKING_LEVELS.map((level) => ({
		value: level,
		label: t(thinkingLevelLabel(level)),
	}));
	const customThinkingOptions = thinkingOptions.filter(({ value }) => customModelLevels.includes(value));
	const defaultThinkingOptions = thinkingOptions.filter(({ value }) => defaultModelLevels.includes(value));
	return (
		<section className="settings-page model-settings-page">
			<div className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Configured providers")}</h3>
				</header>
				<p className="model-provider-intro">
					{t("Manage your connected providers and add more when you need them.")}
				</p>
				{settings?.loadError ? (
					<p className="settings-inline-error" role="alert">
						{settings.loadError}
					</p>
				) : null}
				<div className="model-provider-grid">
					{providers.filter((provider) => provider.auth.configured).map(renderProvider)}
				</div>
				{!providers.some((provider) => provider.auth.configured) && (
					<p className="model-provider-intro">
						{t("No providers configured. Browse the catalog to connect one.")}
					</p>
				)}
				<div className="model-provider-catalog-actions">
					<button
						aria-expanded={catalogOpen}
						className="settings-secondary-button"
						onClick={() => setCatalogOpen(!catalogOpen)}
						type="button"
					>
						{t("Browse providers")}
					</button>

					<button
						className="settings-secondary-button model-add-provider"
						disabled={!serverReady || busy}
						onClick={() => openCustomEditor()}
						type="button"
					>
						<Plus aria-hidden="true" size={15} />
						{t("Add provider")}
					</button>
				</div>
				{catalogOpen && (
					<div className="model-provider-catalog">
						<input
							aria-label={t("Search providers")}
							onChange={(event) => setProviderQuery(event.target.value)}
							placeholder={t("Search providers…")}
							type="search"
							value={providerQuery}
						/>
						<div className="model-provider-grid">{availableProviders.map(renderProvider)}</div>
						{availableProviders.length === 0 && <p>{t("No providers match your search.")}</p>}
					</div>
				)}
			</div>

			<div className="settings-section model-service-section">
				<header className="settings-section-heading">
					<h3>{t("Specialized models")}</h3>
				</header>
				<p className="model-provider-intro">
					{t("Optional services for images. Your chat model works independently.")}
				</p>

				<article className="settings-card model-service-panel">
					<div className="model-service-panel-top">
						<div className="model-service-copy">
							<span>{t("Vision model")}</span>
							<p>
								{t("Configure a dedicated vision API with your own base URL, API format, model ID, and key.")}
							</p>
						</div>
						<button
							className="settings-secondary-button"
							disabled={!serverReady || busy}
							onClick={openVisionEditor}
							type="button"
						>
							{settings?.vision ? t("Edit") : t("Configure")}
						</button>
					</div>
					{settings?.vision ? (
						<div className="model-service-status">
							<strong>{settings.vision.name}</strong>
							<code>{settings.vision.modelId}</code>
							<span className="model-service-badge">{settings.vision.api}</span>
						</div>
					) : (
						<div className="model-service-status unset">
							<span>{t("Not configured")}</span>
						</div>
					)}
				</article>
			</div>
			{draft ? (
				/* biome-ignore lint/a11y/useKeyWithClickEvents: Only a native dialog backdrop click dismisses here; Escape is handled by onCancel. */
				<dialog
					aria-label={t("Configure {{provider}}", { provider: draft.name })}
					className="model-provider-dialog"
					onCancel={(event) => {
						event.preventDefault();
						closeProvider();
					}}
					onClick={(event) => {
						if (event.target === event.currentTarget) closeProvider();
					}}
					ref={providerDialogRef}
				>
					<div className="model-provider-dialog-content">
						<form
							className="model-provider-editor"
							onSubmit={(event) => {
								event.preventDefault();
								void saveProvider();
							}}
						>
							<header className="model-provider-editor-header">
								<div>
									<h2>{draft.name}</h2>
									<p>
										{t(
											"Add the provider API key. Endpoint, protocol, and model catalog are already configured.",
										)}
									</p>
								</div>
								<div className="model-provider-dialog-heading-actions">
									{selectedProvider ? (
										<span className={selectedProvider.auth.configured ? "configured" : ""}>
											{selectedProvider.auth.configured ? (
												<CheckCircle aria-hidden="true" size={14} />
											) : (
												<Key aria-hidden="true" size={14} />
											)}
											{selectedProvider.auth.configured ? t("Configured") : t("Not configured")}
										</span>
									) : null}
									<button
										aria-label={t("Close provider settings")}
										className="model-provider-dialog-close"
										onClick={closeProvider}
										type="button"
									>
										<X aria-hidden="true" size={18} />
									</button>
								</div>
							</header>

							{selectedProvider?.auth.configured ? (
								<div className="model-saved-credential">
									<span>{t("Saved API key")}</span>
									<code>••••••••••••</code>
								</div>
							) : null}
							<label className="model-api-key-field">
								<span>{t("API key")}</span>
								<input
									aria-describedby="model-auth-source"
									autoComplete="off"
									onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
									placeholder={
										selectedProvider?.auth.configured
											? t("Enter a new key to replace the saved credential")
											: "sk-…"
									}
									type="password"
									value={draft.apiKey}
								/>
							</label>
							<p className="model-auth-source" id="model-auth-source">
								{selectedProvider?.auth.configured
									? selectedProvider.auth.source === "environment"
										? t("Configured by environment: {{source}}", {
												source: selectedProvider.auth.label ?? t("environment"),
											})
										: t("Credential is stored locally by Metis.")
									: t("This provider is unavailable until credentials are configured.")}
							</p>

							<div className="settings-form-actions">
								{selectedProvider?.auth.source === "stored" || selectedProvider?.auth.source === "oauth" ? (
									<button
										className="settings-danger-button"
										disabled={busy}
										onClick={() => void saveProvider("remove")}
										type="button"
									>
										{t("Clear credentials")}
									</button>
								) : null}
								{selectedProvider?.auth.configured && selectedProvider.models.length > 0 ? (
									<button
										className="settings-secondary-button"
										disabled={busy}
										onClick={() => void testConnection()}
										type="button"
									>
										{t("Test connection")}
									</button>
								) : null}
								<button
									className="settings-primary-button"
									disabled={busy || !serverReady || !draft.apiKey.trim()}
									type="submit"
								>
									{busy ? t("Saving…") : t("Save API key")}
								</button>
							</div>
							{selectedProvider?.auth.configured && selectedProvider.models.length > 0 ? (
								<div className="model-use-section">
									<div>
										<h2>{t("Default model")}</h2>
										<p>{t("Choose the model and reasoning effort used for new tasks.")}</p>
									</div>
									<div className="model-use-row">
										<label htmlFor={`${fieldId}-select-0`}>
											<span>{t("Model")}</span>
											<MenuSelect
												id={`${fieldId}-select-0`}
												ariaLabel={t("Default model")}
												disabled={busy}
												onChange={(testModelId) => setDraft({ ...draft, testModelId })}
												options={selectedProvider.models.map((model) => ({
													value: model.modelId,
													label: model.name,
												}))}
												value={draft.testModelId}
											/>
										</label>
										<label htmlFor={`${fieldId}-select-1`}>
											<span>{t("Default reasoning")}</span>
											<MenuSelect
												id={`${fieldId}-select-1`}
												ariaLabel={t("Default reasoning")}
												disabled={busy}
												onChange={setDefaultThinking}
												options={defaultThinkingOptions}
												value={providerDefaultThinking}
											/>
										</label>
										<button
											className="settings-primary-button"
											disabled={busy || !draft.testModelId}
											onClick={saveDefaults}
											type="button"
										>
											{t("Use this model")}
										</button>
									</div>
								</div>
							) : null}
						</form>
						{error ? (
							<p className="settings-action-message error" role="alert">
								<XCircle aria-hidden="true" size={15} />
								{error}
							</p>
						) : null}
						{notice ? (
							<output className="status-paragraph settings-action-message">
								<CheckCircle aria-hidden="true" size={15} />
								{notice}
							</output>
						) : null}
					</div>
				</dialog>
			) : null}
			{customDraft ? (
				/* biome-ignore lint/a11y/useKeyWithClickEvents: Only a native dialog backdrop click dismisses here; Escape is handled by onCancel. */
				<dialog
					aria-label={t("Custom provider")}
					className="model-provider-dialog model-custom-provider-dialog"
					onCancel={(event) => {
						event.preventDefault();
						closeCustomEditor();
					}}
					onClick={(event) => {
						if (event.target === event.currentTarget) closeCustomEditor();
					}}
					ref={customDialogRef}
				>
					<div className="model-provider-dialog-content">
						<form
							className="model-provider-editor"
							onSubmit={(event) => {
								event.preventDefault();
								void saveCustomProvider();
							}}
						>
							<header className="model-provider-editor-header">
								<div>
									<h2>{customDraft.provider ? customDraft.name : t("Custom provider")}</h2>
									<p>{t("Add a custom provider with your own endpoint, API format, and models.")}</p>
								</div>
								<div className="model-provider-dialog-heading-actions">
									<button
										aria-label={t("Close provider settings")}
										className="model-provider-dialog-close"
										onClick={closeCustomEditor}
										type="button"
									>
										<X aria-hidden="true" size={18} />
									</button>
								</div>
							</header>

							<div className="model-custom-provider-fields">
								<label className="model-api-key-field">
									<span>{t("Provider name")}</span>
									<input
										autoComplete="off"
										disabled={busy}
										onChange={(event) => setCustomDraft({ ...customDraft, name: event.target.value })}
										placeholder="my-provider"
										type="text"
										value={customDraft.name}
									/>
								</label>
								<label className="model-api-key-field">
									<span>{t("Base URL")}</span>
									<input
										autoComplete="off"
										disabled={busy}
										onChange={(event) => setCustomDraft({ ...customDraft, baseUrl: event.target.value })}
										placeholder="https://api.example.com/v1"
										type="text"
										value={customDraft.baseUrl}
									/>
								</label>
								<label htmlFor={`${fieldId}-select-2`} className="model-api-key-field">
									<span>{t("API format")}</span>
									<MenuSelect
										id={`${fieldId}-select-2`}
										ariaLabel={t("API format")}
										disabled={busy}
										onChange={(api) => setCustomDraft({ ...customDraft, api })}
										options={API_FORMATS.map((format) => ({ value: format.value, label: t(format.label) }))}
										value={customDraft.api}
									/>
								</label>
								<label className="model-api-key-field">
									<span>{t("API key")}</span>
									<input
										autoComplete="off"
										disabled={busy}
										onChange={(event) => setCustomDraft({ ...customDraft, apiKey: event.target.value })}
										placeholder="sk-…"
										type="password"
										value={customDraft.apiKey}
									/>
								</label>
							</div>

							<div className="model-custom-models">
								<div className="model-custom-models-heading">
									<span>{t("Models")}</span>
									<button
										className="settings-secondary-button"
										disabled={busy}
										onClick={() =>
											setCustomDraft({
												...customDraft,
												models: [...customDraft.models, newCustomModelDraft()],
											})
										}
										type="button"
									>
										<Plus aria-hidden="true" size={14} />
										{t("Add model")}
									</button>
								</div>
								{customDraft.models.map((model, index) => (
									<div className="model-custom-model-row" key={model.key}>
										<button
											aria-label={t("Remove model")}
											className="model-custom-model-remove"
											disabled={busy || customDraft.models.length === 1}
											onClick={() => removeCustomModel(index)}
											type="button"
										>
											<Trash aria-hidden="true" size={15} />
										</button>
										<div className="model-custom-model-fields model-custom-model-identity">
											<label>
												<span>{t("Model ID")}</span>
												<input
													autoComplete="off"
													disabled={busy}
													onChange={(event) =>
														updateCustomModel(index, { ...model, modelId: event.target.value })
													}
													placeholder="gpt-5"
													type="text"
													value={model.modelId}
												/>
											</label>
											<label>
												<span>{t("Display name")}</span>
												<input
													autoComplete="off"
													disabled={busy}
													onChange={(event) =>
														updateCustomModel(index, { ...model, name: event.target.value })
													}
													placeholder={model.modelId || t("Model name")}
													type="text"
													value={model.name}
												/>
											</label>
										</div>
										<div className="model-custom-model-fields model-custom-model-limits">
											<label>
												<span>{t("Context window")}</span>
												<input
													disabled={busy}
													min={1}
													onChange={(event) =>
														updateCustomModel(index, {
															...model,
															contextWindow: Number(event.target.value),
														})
													}
													type="number"
													value={Number.isFinite(model.contextWindow) ? model.contextWindow : ""}
												/>
											</label>
											<label>
												<span>{t("Max output tokens")}</span>
												<input
													disabled={busy}
													min={1}
													onChange={(event) =>
														updateCustomModel(index, {
															...model,
															maxOutputTokens: Number(event.target.value),
														})
													}
													type="number"
													value={Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : ""}
												/>
											</label>
										</div>
										<div className="model-custom-model-options">
											<label className="model-custom-model-capability">
												<input
													aria-label={t("Image input")}
													checked={model.imageInput}
													disabled={busy}
													onChange={(event) =>
														updateCustomModel(index, { ...model, imageInput: event.target.checked })
													}
													type="checkbox"
												/>
												<span>{t("Image input")}</span>
											</label>
											<label
												htmlFor={`${fieldId}-select-3-${index}`}
												className="model-custom-model-reasoning"
											>
												<span>{t("Reasoning support")}</span>
												<MenuSelect
													id={`${fieldId}-select-3-${index}`}
													ariaLabel={t("Reasoning support")}
													disabled={busy}
													onChange={(reasoningMode) =>
														updateCustomModel(index, {
															...model,
															reasoningMode,
															reasoningSource: null,
															thinkingLevels: previewThinkingLevels(reasoningMode),
														})
													}
													options={CUSTOM_REASONING_OPTIONS.map((option) => ({
														value: option.value,
														label: t(option.labelKey),
													}))}
													value={model.reasoningMode}
												/>
											</label>
										</div>
										{model.reasoningMode === "auto" && model.reasoningSource === "unrecognized" ? (
											<p className="model-custom-model-hint">
												{t(
													"This model was not found for the selected API format. Reasoning stays off unless you choose Generic reasoning: Low, medium, high.",
												)}
											</p>
										) : model.reasoningSource === "catalog" ? (
											<p className="model-custom-model-hint">
												{t("Supported reasoning levels: {{levels}}", {
													levels: model.thinkingLevels
														.map((level) => t(thinkingLevelLabel(level)))
														.join(", "),
												})}
											</p>
										) : null}
									</div>
								))}
							</div>

							<div className="settings-form-actions">
								{customDraft.provider ? (
									<button
										className="settings-danger-button"
										disabled={busy}
										onClick={() => void removeCustomProvider()}
										type="button"
									>
										{t("Remove provider")}
									</button>
								) : null}
								{customDraft.provider && customDraft.testModelId ? (
									<button
										className="settings-secondary-button"
										disabled={busy}
										onClick={() => void testCustomConnection()}
										type="button"
									>
										{t("Test connection")}
									</button>
								) : null}
								<button className="settings-primary-button" disabled={busy || !serverReady} type="submit">
									{busy ? t("Saving…") : t("Save provider")}
								</button>
							</div>
							{customDraft.provider && customDraft.models.length > 0 ? (
								<div className="model-use-section">
									<div>
										<h2>{t("Default model")}</h2>
										<p>{t("Choose the model and reasoning effort used for new tasks.")}</p>
									</div>
									<div className="model-use-row">
										<label htmlFor={`${fieldId}-select-4`}>
											<span>{t("Model")}</span>
											<MenuSelect
												id={`${fieldId}-select-4`}
												ariaLabel={t("Default model")}
												disabled={busy}
												onChange={(testModelId) => setCustomDraft({ ...customDraft, testModelId })}
												options={customDraft.models
													.filter((model) => model.modelId.trim() !== "")
													.map((model) => ({ value: model.modelId, label: model.name || model.modelId }))}
												value={customDraft.testModelId || customDraft.models[0]?.modelId}
											/>
										</label>
										<label htmlFor={`${fieldId}-select-5`}>
											<span>{t("Default reasoning")}</span>
											<MenuSelect
												id={`${fieldId}-select-5`}
												ariaLabel={t("Default reasoning")}
												disabled={busy}
												onChange={setDefaultThinking}
												options={customThinkingOptions}
												value={customDefaultThinking}
											/>
										</label>
										<button
											className="settings-primary-button"
											disabled={busy || !customDraft.testModelId}
											onClick={saveCustomDefaults}
											type="button"
										>
											{t("Use this model")}
										</button>
									</div>
								</div>
							) : null}
						</form>
						{error ? (
							<p className="settings-action-message error" role="alert">
								<XCircle aria-hidden="true" size={15} />
								{error}
							</p>
						) : null}
						{notice ? (
							<output className="status-paragraph settings-action-message">
								<CheckCircle aria-hidden="true" size={15} />
								{notice}
							</output>
						) : null}
					</div>
				</dialog>
			) : null}
			{error && !draft && !customDraft && !visionDraft ? (
				<p className="settings-action-message error" role="alert">
					<XCircle aria-hidden="true" size={15} />
					{error}
				</p>
			) : null}

			{visionDraft ? (
				/* biome-ignore lint/a11y/useKeyWithClickEvents: Only a native dialog backdrop click dismisses here; Escape is handled by onCancel. */
				<dialog
					aria-label={t("Vision model")}
					className="model-provider-dialog model-service-dialog"
					onCancel={(event) => {
						event.preventDefault();
						closeVisionEditor();
					}}
					onClick={(event) => {
						if (event.target === event.currentTarget) closeVisionEditor();
					}}
					ref={visionDialogRef}
				>
					<div className="model-provider-dialog-content">
						<form
							className="model-provider-editor"
							onSubmit={(event) => {
								event.preventDefault();
								void saveVision();
							}}
						>
							<header className="model-provider-editor-header">
								<div>
									<h2>{t("Vision model")}</h2>
									<p>{t("Pick the chat API format and endpoint describe_image talks to.")}</p>
								</div>
								<button
									aria-label={t("Close")}
									className="model-provider-dialog-close"
									onClick={closeVisionEditor}
									type="button"
								>
									<X aria-hidden="true" size={18} />
								</button>
							</header>
							<div className="model-custom-provider-fields">
								<label className="model-api-key-field">
									<span>{t("Name")}</span>
									<input
										autoComplete="off"
										disabled={busy}
										onChange={(event) => setVisionDraft({ ...visionDraft, name: event.target.value })}
										placeholder={t("My vision")}
										type="text"
										value={visionDraft.name}
									/>
								</label>
								<label htmlFor={`${fieldId}-select-6`} className="model-api-key-field">
									<span>{t("API format")}</span>
									<MenuSelect
										id={`${fieldId}-select-6`}
										ariaLabel={t("API format")}
										disabled={busy}
										onChange={(api) => setVisionDraft({ ...visionDraft, api })}
										options={API_FORMATS.map((format) => ({ value: format.value, label: t(format.label) }))}
										value={visionDraft.api}
									/>
								</label>
								<label className="model-api-key-field">
									<span>{t("Base URL")}</span>
									<input
										autoComplete="off"
										disabled={busy}
										onChange={(event) => setVisionDraft({ ...visionDraft, baseUrl: event.target.value })}
										placeholder="https://api.openai.com/v1"
										type="text"
										value={visionDraft.baseUrl}
									/>
								</label>
								<label className="model-api-key-field">
									<span>{t("Model ID")}</span>
									<input
										autoComplete="off"
										disabled={busy}
										onChange={(event) => setVisionDraft({ ...visionDraft, modelId: event.target.value })}
										placeholder="gpt-4o"
										type="text"
										value={visionDraft.modelId}
									/>
								</label>
								<label className="model-api-key-field">
									<span>{t("API key")}</span>
									<input
										autoComplete="off"
										disabled={busy}
										onChange={(event) => setVisionDraft({ ...visionDraft, apiKey: event.target.value })}
										placeholder={
											settings?.vision?.authConfigured
												? t("Enter a new key to replace the saved credential")
												: "sk-…"
										}
										type="password"
										value={visionDraft.apiKey}
									/>
								</label>
							</div>
							{settings?.vision?.authConfigured ? (
								<div className="model-saved-credential">
									<span>{t("Saved API key")}</span>
									<code>••••••••••••</code>
								</div>
							) : null}
							<div className="settings-form-actions">
								{settings?.vision ? (
									<button
										className="settings-danger-button"
										disabled={busy}
										onClick={() => void clearVision()}
										type="button"
									>
										{t("Remove")}
									</button>
								) : null}
								<button
									className="settings-secondary-button"
									disabled={busy}
									onClick={closeVisionEditor}
									type="button"
								>
									{t("Cancel")}
								</button>
								<button className="settings-primary-button" disabled={busy || !serverReady} type="submit">
									{busy ? t("Saving…") : t("Save")}
								</button>
							</div>
							{error ? (
								<p className="settings-action-message error" role="alert">
									<XCircle aria-hidden="true" size={15} />
									{error}
								</p>
							) : null}
							{notice ? (
								<output className="status-paragraph settings-action-message">
									<CheckCircle aria-hidden="true" size={15} />
									{notice}
								</output>
							) : null}
						</form>
					</div>
				</dialog>
			) : null}
		</section>
	);
}
