import type {
	ModelSettingsProviderView,
	ModelSettingsView,
	ThinkingSelectionView,
	VisionApiView,
} from "@metis/app-protocol";
import { CheckCircle, Key, Plus, Trash, X, XCircle } from "@phosphor-icons/react";
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

type CustomProviderApi = "openai-responses" | "openai-completions" | "anthropic-messages";
type VisionApiFormat = VisionApiView;

interface VisionDraft {
	name: string;
	baseUrl: string;
	api: VisionApiFormat;
	modelId: string;
	apiKey: string;
}

interface MemoryServiceDraftBase {
	name: string;
	provider: string;
	modelId: string;
	apiKey: string;
}

interface EmbeddingServiceDraft extends MemoryServiceDraftBase {
	kind: "embedding";
	baseUrl: string;
	dimensions: string;
}

interface RerankServiceDraft extends MemoryServiceDraftBase {
	kind: "rerank";
	endpointUrl: string;
}

type MemoryServiceDraft = EmbeddingServiceDraft | RerankServiceDraft;

interface CustomModelDraft {
	readonly modelId: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
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
			api: provider.api === "anthropic-messages" || provider.api === "openai-completions"
				? provider.api
				: "openai-responses",
			apiKey: "",
			testModelId: defaultModel?.provider === provider.provider
				? defaultModel.modelId
				: provider.models[0]?.modelId ?? "",
			models: provider.models.map((model) => ({
				modelId: model.modelId,
				name: model.name,
				contextWindow: model.contextWindow,
				maxOutputTokens: model.maxOutputTokens,
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
		models: [{ modelId: "", name: "", contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, imageInput: false }],
	};
}

function clampTokenCount(value: number, fallback: number): number {
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(10_000_000, Math.max(1, Math.trunc(value)));
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

function embeddingServiceDraft(current: ModelSettingsView["embedding"] | undefined): EmbeddingServiceDraft {
	return {
		kind: "embedding",
		name: current?.name ?? "",
		provider: current?.provider ?? "",
		baseUrl: current?.baseUrl ?? "",
		modelId: current?.modelId ?? "",
		dimensions: current?.dimensions?.toString() ?? "",
		apiKey: "",
	};
}

function rerankServiceDraft(current: ModelSettingsView["rerank"] | undefined): RerankServiceDraft {
	return {
		kind: "rerank",
		name: current?.name ?? "",
		provider: current?.provider ?? "",
		endpointUrl: current?.endpointUrl ?? "",
		modelId: current?.modelId ?? "",
		apiKey: "",
	};
}

function memoryServiceInput(draft: MemoryServiceDraft) {
	const name = draft.name.trim();
	const provider = draft.provider.trim();
	const modelId = draft.modelId.trim();
	if (!name || !provider || !modelId) return null;
	if (draft.kind === "embedding") {
		const baseUrl = draft.baseUrl.trim();
		const dimensions = draft.dimensions.trim();
		if (!/^https?:\/\//iu.test(baseUrl) || (dimensions && !/^\d+$/u.test(dimensions))) return null;
		return {
			kind: "embedding" as const,
			settings: {
				name,
				provider,
				baseUrl,
				api: "openai-compatible" as const,
				modelId,
				...(dimensions ? { dimensions: Number(dimensions) } : {}),
			},
		};
	}
	const endpointUrl = draft.endpointUrl.trim();
	if (!/^https?:\/\//iu.test(endpointUrl)) return null;
	return { kind: "rerank" as const, settings: { name, provider, endpointUrl, modelId } };
}

function EmbeddingServiceFields({ draft, busy, onChange }: {
	readonly draft: EmbeddingServiceDraft;
	readonly busy: boolean;
	readonly onChange: (next: EmbeddingServiceDraft) => void;
}) {
	const { t } = useTranslation();
	return <>
		<label className="model-api-key-field"><span>{t("API format")}</span><input disabled readOnly type="text" value="OpenAI compatible" /></label>
		<label className="model-api-key-field"><span>{t("Base URL")}</span><input autoComplete="off" disabled={busy} maxLength={2048} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" type="text" value={draft.baseUrl} /></label>
		<label className="model-api-key-field"><span>{t("Dimensions")}</span><input disabled={busy} max={8192} min={1} onChange={(event) => onChange({ ...draft, dimensions: event.target.value })} placeholder={t("Optional")} type="number" value={draft.dimensions} /></label>
	</>;
}

function RerankServiceFields({ draft, busy, onChange }: {
	readonly draft: RerankServiceDraft;
	readonly busy: boolean;
	readonly onChange: (next: RerankServiceDraft) => void;
}) {
	const { t } = useTranslation();
	return <label className="model-api-key-field"><span>{t("Endpoint URL")}</span><input autoComplete="off" disabled={busy} maxLength={2048} onChange={(event) => onChange({ ...draft, endpointUrl: event.target.value })} placeholder="https://api.cohere.com/v2/rerank" type="text" value={draft.endpointUrl} /></label>;
}

const THINKING_LEVELS: readonly ThinkingSelectionView[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function ModelSettingsPanel({ api, serverReady }: {
	readonly api: Pick<MetisDesktopApi, "getModelSettings" | "updateModelSettings" | "testModelConnection">;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [settings, setSettings] = useState<ModelSettingsView | null>(null);
	const [draft, setDraft] = useState<ProviderDraft | null>(null);
	const [customDraft, setCustomDraft] = useState<CustomProviderDraft | null>(null);
	const [visionDraft, setVisionDraft] = useState<VisionDraft | null>(null);
	const [memoryServiceDraft, setMemoryServiceDraft] = useState<MemoryServiceDraft | null>(null);
	const [defaultThinking, setDefaultThinking] = useState<ThinkingSelectionView>("medium");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const providerDialogRef = useRef<HTMLDialogElement>(null);
	const customDialogRef = useRef<HTMLDialogElement>(null);
	const visionDialogRef = useRef<HTMLDialogElement>(null);
	const memoryServiceDialogRef = useRef<HTMLDialogElement>(null);

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
	const memoryServiceEditor =
		memoryServiceDraft?.kind === "embedding"
			? {
					title: t("Embedding model"),
					description: t("OpenAI-compatible embeddings endpoint."),
					supplierPlaceholder: "Qwen",
					configured: settings?.embedding !== null && settings?.embedding !== undefined,
					authConfigured: settings?.embedding?.authConfigured ?? false,
				}
			: memoryServiceDraft
				? {
						title: t("Rerank model"),
						description: t(
							"Cohere-compatible and Qwen-compatible services use different paths, so enter the complete endpoint URL.",
						),
						supplierPlaceholder: "Cohere",
						configured: settings?.rerank !== null && settings?.rerank !== undefined,
						authConfigured: settings?.rerank?.authConfigured ?? false,
					}
				: null;

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

	const openCustomEditor = useCallback((provider?: ModelSettingsProviderView) => {
		setError(null);
		setNotice(null);
		setDraft(null);
		setCustomDraft(customProviderDraft(provider, settings?.defaultModel ?? null));
	}, [settings?.defaultModel]);

	useEffect(() => {
		if (!customDraft) return;
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
	}, [closeCustomEditor, customDraft?.provider]);

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

	const closeVisionEditor = useCallback(() => {
		setVisionDraft(null);
		setError(null);
		setNotice(null);
	}, []);

	useEffect(() => {
		if (!visionDraft) return;
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
	}, [closeVisionEditor, Boolean(visionDraft)]);

	const closeMemoryServiceEditor = useCallback(() => {
		setMemoryServiceDraft(null);
		setError(null);
		setNotice(null);
	}, []);

	useEffect(() => {
		if (!memoryServiceDraft) return;
		const dialog = memoryServiceDialogRef.current;
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
			closeMemoryServiceEditor();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			if (dialog.open && typeof dialog.close === "function") {
				try {
					dialog.close();
				} catch {
					dialog.removeAttribute("open");
				}
			} else {
				dialog.removeAttribute("open");
			}
		};
	}, [closeMemoryServiceEditor, Boolean(memoryServiceDraft)]);

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
		const next = await runUpdate({
			type: "set_vision",
			settings: { name, baseUrl, api: visionDraft.api, modelId },
			credential,
		}, t("Vision model saved"));
		if (!next) return;
		setVisionDraft(null);
	};

	const clearVision = async () => {
		if (!settings?.vision) return;
		const next = await runUpdate({ type: "set_vision", settings: null, credential: { action: "remove" } }, t("Vision model removed"));
		if (!next) return;
		setVisionDraft(null);
	};

	const openMemoryServiceEditor = (kind: MemoryServiceDraft["kind"]) => {
		setError(null);
		setNotice(null);
		setMemoryServiceDraft(
			kind === "embedding" ? embeddingServiceDraft(settings?.embedding) : rerankServiceDraft(settings?.rerank),
		);
	};

	const memoryServiceCredential = () => {
		if (!memoryServiceDraft) return null;
		const value = memoryServiceDraft.apiKey;
		if (value) return { action: "set" as const, value };
		return memoryServiceEditor?.authConfigured ? { action: "keep" as const } : null;
	};

	const testMemoryService = async () => {
		const input = memoryServiceDraft ? memoryServiceInput(memoryServiceDraft) : null;
		const credential = memoryServiceCredential();
		if (!input || !credential) {
			setError(t("Fill in all required fields and an API key."));
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.testModelConnection(
				input.kind === "embedding"
					? { requestId: crypto.randomUUID(), kind: "embedding", settings: input.settings, credential }
					: { requestId: crypto.randomUUID(), kind: "rerank", settings: input.settings, credential },
			);
			setNotice(`${t(result.ok ? "Connection succeeded" : "Connection failed")} · ${result.latencyMs} ms${result.ok ? "" : ` · ${result.message}`}`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Connection test failed."));
		} finally {
			setBusy(false);
		}
	};

	const saveMemoryService = async () => {
		const input = memoryServiceDraft ? memoryServiceInput(memoryServiceDraft) : null;
		const credential = memoryServiceCredential();
		if (!input || !credential) {
			setError(t("Fill in all required fields and an API key."));
			return;
		}
		const next = await runUpdate(
			input.kind === "embedding"
				? { type: "set_embedding", settings: input.settings, credential }
				: { type: "set_rerank", settings: input.settings, credential },
			t(input.kind === "embedding" ? "Embedding model saved" : "Rerank model saved"),
		);
		if (next) setMemoryServiceDraft(null);
	};

	const removeMemoryService = async () => {
		if (!memoryServiceDraft) return;
		const next = await runUpdate(
			memoryServiceDraft.kind === "embedding"
				? { type: "set_embedding", settings: null, credential: { action: "remove" } }
				: { type: "set_rerank", settings: null, credential: { action: "remove" } },
			t("Model removed"),
		);
		if (next) setMemoryServiceDraft(null);
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
			const result = await api.testModelConnection({ requestId: crypto.randomUUID(), kind: "chat", provider: selectedProvider.provider, modelId: model.modelId });
			setNotice(`${t(result.ok ? "Connection succeeded" : "Connection failed")} · ${result.latencyMs} ms${result.ok ? "" : ` · ${result.message}`}`);
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
			const result = await api.testModelConnection({ requestId: crypto.randomUUID(), kind: "chat", provider: customDraft.provider, modelId: customDraft.testModelId });
			setNotice(`${t(result.ok ? "Connection succeeded" : "Connection failed")} · ${result.latencyMs} ms${result.ok ? "" : ` · ${result.message}`}`);
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
		if (models.some((model) => {
			if (modelIds.has(model.modelId)) return true;
			modelIds.add(model.modelId);
			return false;
		})) {
			setError(t("Model IDs must be unique"));
			return;
		}
		const next = await runUpdate({
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
				reasoning: false,
				imageInput: model.imageInput,
			})),
			credential,
		}, t("Provider saved"));
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
		void runUpdate({
			type: "set_defaults",
			model: { provider: customDraft.provider, modelId: customDraft.testModelId },
			thinkingSelection: defaultThinking,
		}, t("Defaults saved"));
	};

	const updateCustomModel = (index: number, model: CustomModelDraft) => {
		if (!customDraft) return;
		const models = customDraft.models.map((candidate, candidateIndex) => candidateIndex === index ? model : candidate);
		const testModelId = models.some((candidate) => candidate.modelId === customDraft.testModelId)
			? customDraft.testModelId
			: models[0]?.modelId ?? "";
		setCustomDraft({ ...customDraft, models, testModelId });
	};

	const removeCustomModel = (index: number) => {
		if (!customDraft) return;
		const models = customDraft.models.filter((_, candidateIndex) => candidateIndex !== index);
		const testModelId = models.some((candidate) => candidate.modelId === customDraft.testModelId)
			? customDraft.testModelId
			: models[0]?.modelId ?? "";
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

	if (!settings && !error) return <div aria-label={t("Loading model settings")} className="settings-loading" role="status" />;
	const thinkingOptions = THINKING_LEVELS.map((level) => ({
		value: level,
		label: t(level === "off" ? "Off" : level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1)),
	}));
	return (
		<section className="settings-page model-settings-page">
			<div className="settings-section">
				<header className="settings-section-heading">
					<h3>{t("Providers")}</h3>
				</header>
				<p className="model-provider-intro">{t("Select a provider to configure its credentials. Built-in model details stay managed by Metis.")}</p>
				{settings?.loadError ? <p className="settings-inline-error" role="alert">{settings.loadError}</p> : null}
				<div className="model-provider-grid">
					{providers.map((provider) => (
						<button aria-haspopup="dialog" className="model-provider-card" key={provider.provider} onClick={() => openProvider(provider)} type="button">
							<span className="model-provider-card-heading">
								<span className="model-provider-card-title">
									<span className={`model-provider-dot ${provider.auth.configured ? "configured" : ""}`} />
									<strong title={provider.name}>{provider.name}</strong>
								</span>
								<span className={`model-provider-badge ${provider.auth.configured ? "configured" : ""}`}>{provider.auth.configured ? t("Configured") : t("Set up")}</span>
							</span>
							<small>{t("{{count}} models", { count: provider.models.length })}</small>
						</button>
					))}
				</div>
				<button className="settings-secondary-button model-add-provider" disabled={!serverReady || busy} onClick={() => openCustomEditor()} type="button">
					<Plus aria-hidden="true" size={15} />
					{t("Add provider")}
				</button>
			</div>

			<div className="settings-section model-service-section">
				<header className="settings-section-heading">
					<h3>{t("Specialized models")}</h3>
				</header>
				<p className="model-provider-intro">
					{t("Extract sends bounded text to your Embedding service and up to 50 candidate facts to optional Rerank.")}
				</p>

				<article className="settings-card model-service-panel">
					<div className="model-service-panel-top">
						<div className="model-service-copy">
							<span>{t("Vision model")}</span>
							<p>{t("Configure a dedicated vision API with your own base URL, API format, model ID, and key.")}</p>
						</div>
						<button className="settings-secondary-button" disabled={!serverReady || busy} onClick={openVisionEditor} type="button">
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

				{(["embedding", "rerank"] as const).map((kind) => {
					const current = kind === "embedding" ? settings?.embedding : settings?.rerank;
					return (
						<article className="settings-card model-service-panel" key={kind}>
							<div className="model-service-panel-top">
								<div className="model-service-copy">
									<span>{t(kind === "embedding" ? "Embedding model" : "Rerank model")}</span>
									<p>
										{t(
											kind === "embedding"
												? "Required for Extract; supports OpenAI-compatible providers such as OpenAI and Qwen."
												: "Optional; enter the provider's complete rerank endpoint URL.",
										)}
									</p>
								</div>
								<button
									className="settings-secondary-button"
									disabled={!serverReady || busy}
									onClick={() => openMemoryServiceEditor(kind)}
									type="button"
								>
									{current ? t("Edit") : t("Configure")}
								</button>
							</div>
							{current ? (
								<div className="model-service-status">
									<strong>{current.name}</strong>
									<code>{current.modelId}</code>
									<span className="model-service-badge">{current.provider}</span>
								</div>
							) : (
								<div className="model-service-status unset"><span>{t("Not configured")}</span></div>
							)}
						</article>
					);
				})}
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
			{customDraft ? <dialog
				aria-label={t("Custom provider")}
				className="model-provider-dialog model-custom-provider-dialog"
				onCancel={(event) => { event.preventDefault(); closeCustomEditor(); }}
				onClick={(event) => { if (event.target === event.currentTarget) closeCustomEditor(); }}
				ref={customDialogRef}
			>
				<div className="model-provider-dialog-content">
					<form className="model-provider-editor" onSubmit={(event) => { event.preventDefault(); void saveCustomProvider(); }}>
						<header className="model-provider-editor-header">
							<div><h2>{customDraft.provider ? customDraft.name : t("Custom provider")}</h2><p>{t("Add a custom provider with your own endpoint, API format, and models.")}</p></div>
							<div className="model-provider-dialog-heading-actions">
								<button aria-label={t("Close provider settings")} className="model-provider-dialog-close" onClick={closeCustomEditor} type="button"><X aria-hidden="true" size={18} /></button>
							</div>
						</header>

							<div className="model-custom-provider-fields">
								<label className="model-api-key-field"><span>{t("Provider name")}</span><input autoComplete="off" disabled={busy} onChange={(event) => setCustomDraft({ ...customDraft, name: event.target.value })} placeholder="my-provider" type="text" value={customDraft.name} /></label>
							<label className="model-api-key-field"><span>{t("Base URL")}</span><input autoComplete="off" disabled={busy} onChange={(event) => setCustomDraft({ ...customDraft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" type="text" value={customDraft.baseUrl} /></label>
							<label className="model-api-key-field"><span>{t("API format")}</span><MenuSelect ariaLabel={t("API format")} disabled={busy} onChange={(api) => setCustomDraft({ ...customDraft, api })} options={API_FORMATS.map((format) => ({ value: format.value, label: t(format.label) }))} value={customDraft.api} /></label>
							<label className="model-api-key-field"><span>{t("API key")}</span><input autoComplete="off" disabled={busy} onChange={(event) => setCustomDraft({ ...customDraft, apiKey: event.target.value })} placeholder="sk-…" type="password" value={customDraft.apiKey} /></label>
						</div>

						<div className="model-custom-models">
							<div className="model-custom-models-heading"><span>{t("Models")}</span><button className="settings-secondary-button" disabled={busy} onClick={() => setCustomDraft({ ...customDraft, models: [...customDraft.models, { modelId: "", name: "", contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, imageInput: false }] })} type="button"><Plus aria-hidden="true" size={14} />{t("Add model")}</button></div>
							{customDraft.models.map((model, index) => (
								<div className="model-custom-model-row" key={index}>
									<label><span>{t("Model ID")}</span><input autoComplete="off" disabled={busy} onChange={(event) => updateCustomModel(index, { ...model, modelId: event.target.value })} placeholder="gpt-5" type="text" value={model.modelId} /></label>
									<label><span>{t("Name")}</span><input autoComplete="off" disabled={busy} onChange={(event) => updateCustomModel(index, { ...model, name: event.target.value })} placeholder={model.modelId || t("Model name")} type="text" value={model.name} /></label>
									<label><span>{t("Context window")}</span><input disabled={busy} min={1} onChange={(event) => updateCustomModel(index, { ...model, contextWindow: Number(event.target.value) })} type="number" value={Number.isFinite(model.contextWindow) ? model.contextWindow : ""} /></label>
									<label><span>{t("Max output tokens")}</span><input disabled={busy} min={1} onChange={(event) => updateCustomModel(index, { ...model, maxOutputTokens: Number(event.target.value) })} type="number" value={Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : ""} /></label>
									<label className="model-custom-model-image"><input aria-label={t("Image input")} checked={model.imageInput} disabled={busy} onChange={(event) => updateCustomModel(index, { ...model, imageInput: event.target.checked })} type="checkbox" /><span>{t("Image input")}</span></label>
									<button aria-label={t("Remove model")} className="model-custom-model-remove" disabled={busy || customDraft.models.length === 1} onClick={() => removeCustomModel(index)} type="button"><Trash aria-hidden="true" size={15} /></button>
								</div>
							))}
						</div>

						<div className="settings-form-actions">
							{customDraft.provider ? <button className="settings-danger-button" disabled={busy} onClick={() => void removeCustomProvider()} type="button">{t("Remove provider")}</button> : null}
							{customDraft.provider && customDraft.testModelId ? <button className="settings-secondary-button" disabled={busy} onClick={() => void testCustomConnection()} type="button">{t("Test connection")}</button> : null}
							<button className="settings-primary-button" disabled={busy || !serverReady} type="submit">{busy ? t("Saving…") : t("Save provider")}</button>
						</div>
						{customDraft.provider && customDraft.models.length > 0 ? <div className="model-use-section">
							<div><h2>{t("Default model")}</h2><p>{t("Choose the model and reasoning effort used for new tasks.")}</p></div>
							<div className="model-use-row">
								<label><span>{t("Model")}</span><MenuSelect ariaLabel={t("Default model")} disabled={busy} onChange={(testModelId) => setCustomDraft({ ...customDraft, testModelId })} options={customDraft.models.filter((model) => model.modelId.trim() !== "").map((model) => ({ value: model.modelId, label: model.name || model.modelId }))} value={customDraft.testModelId || customDraft.models[0]?.modelId} /></label>
								<label><span>{t("Default reasoning")}</span><MenuSelect ariaLabel={t("Default reasoning")} disabled={busy} onChange={setDefaultThinking} options={thinkingOptions} value={defaultThinking} /></label>
								<button className="settings-primary-button" disabled={busy || !customDraft.testModelId} onClick={saveCustomDefaults} type="button">{t("Use this model")}</button>
							</div>
						</div> : null}
					</form>
					{error ? <p className="settings-action-message error" role="alert"><XCircle aria-hidden="true" size={15} />{error}</p> : null}
					{notice ? <p className="settings-action-message" role="status"><CheckCircle aria-hidden="true" size={15} />{notice}</p> : null}
				</div>
			</dialog> : null}
			{error && !draft && !customDraft && !visionDraft && !memoryServiceDraft ? <p className="settings-action-message error" role="alert"><XCircle aria-hidden="true" size={15} />{error}</p> : null}

			{visionDraft ? <dialog
				aria-label={t("Vision model")}
				className="model-provider-dialog model-service-dialog"
				onCancel={(event) => { event.preventDefault(); closeVisionEditor(); }}
				onClick={(event) => { if (event.target === event.currentTarget) closeVisionEditor(); }}
				ref={visionDialogRef}
			>
				<div className="model-provider-dialog-content">
					<form className="model-provider-editor" onSubmit={(event) => { event.preventDefault(); void saveVision(); }}>
						<header className="model-provider-editor-header">
							<div>
								<h2>{t("Vision model")}</h2>
								<p>{t("Pick the chat API format and endpoint describe_image talks to.")}</p>
							</div>
							<button aria-label={t("Close")} className="model-provider-dialog-close" onClick={closeVisionEditor} type="button"><X aria-hidden="true" size={18} /></button>
						</header>
						<div className="model-custom-provider-fields">
							<label className="model-api-key-field"><span>{t("Name")}</span><input autoComplete="off" disabled={busy} onChange={(event) => setVisionDraft({ ...visionDraft, name: event.target.value })} placeholder={t("My vision")} type="text" value={visionDraft.name} /></label>
							<label className="model-api-key-field"><span>{t("API format")}</span><MenuSelect ariaLabel={t("API format")} disabled={busy} onChange={(api) => setVisionDraft({ ...visionDraft, api })} options={API_FORMATS.map((format) => ({ value: format.value, label: t(format.label) }))} value={visionDraft.api} /></label>
							<label className="model-api-key-field"><span>{t("Base URL")}</span><input autoComplete="off" disabled={busy} onChange={(event) => setVisionDraft({ ...visionDraft, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" type="text" value={visionDraft.baseUrl} /></label>
							<label className="model-api-key-field"><span>{t("Model ID")}</span><input autoComplete="off" disabled={busy} onChange={(event) => setVisionDraft({ ...visionDraft, modelId: event.target.value })} placeholder="gpt-4o" type="text" value={visionDraft.modelId} /></label>
							<label className="model-api-key-field"><span>{t("API key")}</span><input autoComplete="off" disabled={busy} onChange={(event) => setVisionDraft({ ...visionDraft, apiKey: event.target.value })} placeholder={settings?.vision?.authConfigured ? t("Enter a new key to replace the saved credential") : "sk-…"} type="password" value={visionDraft.apiKey} /></label>
						</div>
						{settings?.vision?.authConfigured ? <div className="model-saved-credential"><span>{t("Saved API key")}</span><code>••••••••••••</code></div> : null}
						<div className="settings-form-actions">
							{settings?.vision ? <button className="settings-danger-button" disabled={busy} onClick={() => void clearVision()} type="button">{t("Remove")}</button> : null}
							<button className="settings-secondary-button" disabled={busy} onClick={closeVisionEditor} type="button">{t("Cancel")}</button>
							<button className="settings-primary-button" disabled={busy || !serverReady} type="submit">{busy ? t("Saving…") : t("Save")}</button>
						</div>
						{error ? <p className="settings-action-message error" role="alert"><XCircle aria-hidden="true" size={15} />{error}</p> : null}
						{notice ? <p className="settings-action-message" role="status"><CheckCircle aria-hidden="true" size={15} />{notice}</p> : null}
					</form>
				</div>
			</dialog> : null}

			{memoryServiceDraft && memoryServiceEditor ? <dialog
				aria-label={memoryServiceEditor.title}
				className="model-provider-dialog model-service-dialog"
				onCancel={(event) => { event.preventDefault(); closeMemoryServiceEditor(); }}
				onClick={(event) => { if (event.target === event.currentTarget) closeMemoryServiceEditor(); }}
				ref={memoryServiceDialogRef}
			>
				<div className="model-provider-dialog-content">
					<form className="model-provider-editor" onSubmit={(event) => { event.preventDefault(); void saveMemoryService(); }}>
						<header className="model-provider-editor-header">
							<div>
								<h2>{memoryServiceEditor.title}</h2>
								<p>{memoryServiceEditor.description}</p>
							</div>
							<button aria-label={t("Close")} className="model-provider-dialog-close" onClick={closeMemoryServiceEditor} type="button"><X aria-hidden="true" size={18} /></button>
						</header>
						<div className="model-custom-provider-fields">
							<label className="model-api-key-field"><span>{t("Name")}</span><input autoComplete="off" disabled={busy} maxLength={120} onChange={(event) => setMemoryServiceDraft({ ...memoryServiceDraft, name: event.target.value })} type="text" value={memoryServiceDraft.name} /></label>
							<label className="model-api-key-field"><span>{t("Supplier")}</span><input autoComplete="off" disabled={busy} maxLength={120} onChange={(event) => setMemoryServiceDraft({ ...memoryServiceDraft, provider: event.target.value })} placeholder={memoryServiceEditor.supplierPlaceholder} type="text" value={memoryServiceDraft.provider} /></label>
							{memoryServiceDraft.kind === "embedding"
								? <EmbeddingServiceFields busy={busy} draft={memoryServiceDraft} onChange={setMemoryServiceDraft} />
								: <RerankServiceFields busy={busy} draft={memoryServiceDraft} onChange={setMemoryServiceDraft} />}
							<label className="model-api-key-field"><span>{t("Model ID")}</span><input autoComplete="off" disabled={busy} maxLength={200} onChange={(event) => setMemoryServiceDraft({ ...memoryServiceDraft, modelId: event.target.value })} type="text" value={memoryServiceDraft.modelId} /></label>
							<label className="model-api-key-field"><span>{t("API key")}</span><input autoComplete="off" disabled={busy} maxLength={16384} onChange={(event) => setMemoryServiceDraft({ ...memoryServiceDraft, apiKey: event.target.value })} placeholder={memoryServiceCredential()?.action === "keep" ? t("Enter a new key to replace the saved credential") : "sk-…"} type="password" value={memoryServiceDraft.apiKey} /></label>
						</div>
						<div className="settings-form-actions">
							{memoryServiceEditor.configured ? <button className="settings-danger-button" disabled={busy} onClick={() => void removeMemoryService()} type="button">{t("Remove")}</button> : null}
							<button className="settings-secondary-button" disabled={busy || !serverReady} onClick={() => void testMemoryService()} type="button">{t("Test connection")}</button>
							<button className="settings-secondary-button" disabled={busy} onClick={closeMemoryServiceEditor} type="button">{t("Cancel")}</button>
							<button className="settings-primary-button" disabled={busy || !serverReady} type="submit">{busy ? t("Saving…") : t("Save")}</button>
						</div>
						{error ? <p className="settings-action-message error" role="alert"><XCircle aria-hidden="true" size={15} />{error}</p> : null}
						{notice ? <p className="settings-action-message" role="status"><CheckCircle aria-hidden="true" size={15} />{notice}</p> : null}
					</form>
				</div>
			</dialog> : null}

		</section>
	);
}
