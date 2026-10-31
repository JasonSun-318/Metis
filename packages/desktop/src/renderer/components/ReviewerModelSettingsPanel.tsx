import type {
	ClientResult,
	ModelSettingsProviderView,
	ModelSettingsView,
	PermissionReviewerConfigView,
	PermissionReviewerDedicatedConfigView,
	PermissionReviewerView,
	ThinkingSelectionView,
} from "@metis/app-protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { CheckCircle, X, XCircle } from "../icons.tsx";
import { trapDialogTab } from "./dialog-focus.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import {
	MODEL_THINKING_LEVELS,
	ModelReasoningEditor,
	type ReasoningDraft,
	type ReasoningMap,
	type ReasoningRow,
	reasoningError,
	reasoningRows,
} from "./ModelReasoningEditor.tsx";

import { FloatingSystemNotice, type SystemNoticeProps } from "./SystemNotice.tsx";

const TIMEOUT_MIN = 1000;
const TIMEOUT_MAX = 15_000;
const DEFAULT_TIMEOUT = 8000;
const OUTPUT_MIN = 128;
const OUTPUT_MAX = 8192;
const OUTPUT_OFF = 512;
const OUTPUT_OTHER = 2048;

type DedicatedApi = PermissionReviewerDedicatedConfigView["api"];
type DedicatedReasoningMode = PermissionReviewerDedicatedConfigView["reasoningMode"];
type ReviewerConnectionKind = "dedicated" | "provider";

const API_FORMATS: readonly { readonly value: DedicatedApi; readonly label: string }[] = [
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "openai-completions", label: "OpenAI Completions" },
	{ value: "anthropic-messages", label: "Anthropic Messages" },
];

interface DedicatedReviewerDraft {
	readonly kind: "dedicated";
	readonly name: string;
	readonly api: DedicatedApi;
	readonly baseUrl: string;
	readonly modelId: string;
	readonly apiKey: string;
	readonly reasoningMode: DedicatedReasoningMode;
	readonly reasoningRows: readonly ReasoningRow[];
	readonly thinkingLevel: ThinkingSelectionView;
	readonly timeoutMs: number;
	readonly maxOutputTokens: number;
}

interface ProviderReviewerDraft {
	readonly kind: "provider";
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ThinkingSelectionView;
	readonly timeoutMs: number;
	readonly maxOutputTokens: number;
}

type ReviewerConnectionDraft = DedicatedReviewerDraft | ProviderReviewerDraft;

function thinkingLabel(level: ThinkingSelectionView): string {
	return level === "off" ? "Off" : level === "xhigh" ? "XHigh" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

/** Returns null when the model's registered limit cannot hold even the minimum reviewer budget. */
function outputCeiling(modelMaxOutputTokens: number | undefined): number | null {
	const ceiling = Math.min(OUTPUT_MAX, modelMaxOutputTokens ?? OUTPUT_MAX);
	return ceiling < OUTPUT_MIN ? null : ceiling;
}

function defaultOutputTokens(thinkingLevel: ThinkingSelectionView, modelMaxOutputTokens: number | undefined): number {
	const ceiling = outputCeiling(modelMaxOutputTokens);
	if (ceiling === null) return modelMaxOutputTokens ?? OUTPUT_MIN;
	return Math.min(thinkingLevel === "off" ? OUTPUT_OFF : OUTPUT_OTHER, ceiling);
}

function outputFits(value: number, modelMaxOutputTokens: number | undefined): boolean {
	const ceiling = outputCeiling(modelMaxOutputTokens);
	return ceiling !== null && Number.isInteger(value) && value >= OUTPUT_MIN && value <= ceiling;
}

function providerFor(settings: ModelSettingsView, providerId: string): ModelSettingsProviderView | undefined {
	return settings.providers.find((candidate) => candidate.provider === providerId);
}

function modelFor(provider: ModelSettingsProviderView | undefined, modelId: string) {
	return provider?.models.find((candidate) => candidate.modelId === modelId);
}

function defaultThinkingLevel(levels: readonly ThinkingSelectionView[]): ThinkingSelectionView {
	if (levels.includes("off")) return "off";
	if (levels.includes("medium")) return "medium";
	return levels[0] ?? "off";
}

/** The lowest supported level is the first canonical level present in the manual mapping. */
function dedicatedThinkingLevels(
	draft: Pick<DedicatedReviewerDraft, "reasoningMode" | "reasoningRows">,
): ThinkingSelectionView[] {
	if (draft.reasoningMode === "off") return ["off"];
	const mapped = new Set(draft.reasoningRows.map((row) => row.level));
	return MODEL_THINKING_LEVELS.filter((level) => mapped.has(level));
}

function providerDraft(
	providerId: string,
	modelId: string,
	thinkingLevel: ThinkingSelectionView,
	timeoutMs: number,
	maxOutputTokens: number,
): ProviderReviewerDraft {
	return { kind: "provider", provider: providerId, modelId, thinkingLevel, timeoutMs, maxOutputTokens };
}

function defaultProviderDraft(settings: ModelSettingsView): ProviderReviewerDraft {
	const provider =
		settings.providers.find((candidate) => candidate.auth.configured && candidate.models.length > 0) ??
		settings.providers.find((candidate) => candidate.models.length > 0);
	const model = provider?.models[0];
	const levels = model?.thinkingLevels ?? [];
	const thinkingLevel = defaultThinkingLevel(levels);
	return providerDraft(
		provider?.provider ?? "",
		model?.modelId ?? "",
		thinkingLevel,
		DEFAULT_TIMEOUT,
		defaultOutputTokens(thinkingLevel, model?.maxOutputTokens),
	);
}

function newDedicatedDraft(): DedicatedReviewerDraft {
	return {
		kind: "dedicated",
		name: "",
		api: "openai-completions",
		baseUrl: "",
		modelId: "",
		apiKey: "",
		reasoningMode: "off",
		reasoningRows: [],
		thinkingLevel: "off",
		timeoutMs: DEFAULT_TIMEOUT,
		maxOutputTokens: OUTPUT_OFF,
	};
}

function dedicatedDraftFromConfig(config: PermissionReviewerDedicatedConfigView): DedicatedReviewerDraft {
	return {
		kind: "dedicated",
		name: config.name,
		api: config.api,
		baseUrl: config.baseUrl,
		modelId: config.modelId,
		apiKey: "",
		reasoningMode: config.reasoningMode,
		reasoningRows: reasoningRows(config.thinkingLevelMap),
		thinkingLevel: config.thinkingLevel,
		timeoutMs: config.timeoutMs,
		maxOutputTokens: config.maxOutputTokens,
	};
}

function savedDraft(settings: ModelSettingsView): ReviewerConnectionDraft {
	const saved = settings.permissionReviewer.config;
	if (!saved) return defaultProviderDraft(settings);
	if (isDedicatedConfig(saved)) return dedicatedDraftFromConfig(saved);
	return providerDraft(saved.provider, saved.modelId, saved.thinkingLevel, saved.timeoutMs, saved.maxOutputTokens);
}

function sameDraft(left: ReviewerConnectionDraft, right: ReviewerConnectionDraft): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isDedicatedConfig(
	config: PermissionReviewerConfigView | null,
): config is PermissionReviewerDedicatedConfigView {
	return config !== null && (config as { readonly source?: unknown }).source === "dedicated";
}

function validBaseUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
	} catch {
		return false;
	}
}

/** 审批模型卡片：摘要与 Configure 按钮，表单在原生 dialog 内。 */
export function ReviewerModelSettingsPanel({
	api,
	busy,
	onDirtyChange,
	onOpenChange,
	onRequestClose,
	onSaved,
	open: openProp,
	renderCard = true,
	serverReady,
	settings,
}: {
	readonly api: Pick<MetisDesktopApi, "updateModelSettings" | "testModelConnection">;
	readonly busy: boolean;
	readonly onDirtyChange?: (dirty: boolean) => void;
	/** Controlled mode lets another settings page open the same dialog directly. */
	readonly onOpenChange?: (open: boolean) => void;
	readonly onRequestClose: () => void;
	readonly onSaved: (next: ModelSettingsView) => void;
	readonly open?: boolean;
	readonly renderCard?: boolean;
	readonly serverReady: boolean;
	readonly settings: ModelSettingsView;
}) {
	const { t } = useTranslation();
	const fieldId = useId();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [internalOpen, setInternalOpen] = useState(false);
	const controlled = openProp !== undefined;
	const open = openProp ?? internalOpen;
	const [draft, setDraft] = useState<ReviewerConnectionDraft>(() => savedDraft(settings));
	const [baseline, setBaseline] = useState<ReviewerConnectionDraft>(draft);
	const [operation, setOperation] = useState<"save" | "clear" | "test" | null>(null);
	const [confirmRemoval, setConfirmRemoval] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [testNotice, setTestNotice] = useState<SystemNoticeProps | null>(null);
	const working = operation !== null;
	const dirty = open && !sameDraft(draft, baseline);
	const requestOpenChange = (next: boolean) => {
		if (controlled) onOpenChange?.(next);
		else setInternalOpen(next);
	};
	const requestClose = () => {
		if (controlled) onOpenChange?.(false);
		onRequestClose();
	};

	const prepareEditor = useCallback(() => {
		const next = savedDraft(settings);
		setDraft(next);
		setBaseline(next);
		setConfirmRemoval(false);
		setError(null);
		setNotice(null);
		setTestNotice(null);
	}, [settings]);

	// A controlled open starts from the saved connection, matching the card button.
	const preparedRef = useRef(false);
	// Opening the dialog resets its draft from the saved connection.
	useEffect(() => {
		if (!open) {
			preparedRef.current = false;
			return;
		}
		if (preparedRef.current) return;
		preparedRef.current = true;
		prepareEditor();
	}, [open, prepareEditor]);

	useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	useEffect(() => {
		if (!open) return;
		const dialog = dialogRef.current;
		if (!dialog) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		dialog.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
		return () => {
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
			if (previous?.isConnected) previous.focus();
		};
	}, [open]);

	const saved = settings.permissionReviewer;
	const savedConfig = saved.config;
	const savedDedicated = isDedicatedConfig(savedConfig) ? savedConfig : null;
	const savedProviderConfig = savedConfig && !isDedicatedConfig(savedConfig) ? savedConfig : null;
	const savedProvider = savedProviderConfig ? providerFor(settings, savedProviderConfig.provider) : undefined;
	const savedModel = savedProviderConfig ? modelFor(savedProvider, savedProviderConfig.modelId) : undefined;

	const savedInvalid =
		(savedProviderConfig !== null &&
			(!savedProvider?.auth.configured ||
				!savedModel ||
				!savedModel.thinkingLevels.includes(savedProviderConfig.thinkingLevel) ||
				!outputFits(savedProviderConfig.maxOutputTokens, savedModel.maxOutputTokens))) ||
		(savedDedicated !== null && saved.authConfigured === false);
	const savedStatus: PermissionReviewerView["status"] =
		saved.status === "invalid" || savedInvalid ? "invalid" : saved.status;
	const hasSavedConfiguration = savedConfig !== null || saved.status === "invalid";

	const selectedProvider = draft.kind === "provider" ? providerFor(settings, draft.provider) : undefined;
	const selectedModel = draft.kind === "provider" ? modelFor(selectedProvider, draft.modelId) : undefined;
	const providerLevels = selectedModel?.thinkingLevels ?? [];
	const dedicatedLevels = draft.kind === "dedicated" ? dedicatedThinkingLevels(draft) : [];
	const thinkingLevels = draft.kind === "dedicated" ? dedicatedLevels : providerLevels;
	const thinkingOptions = thinkingLevels.map((level) => ({ value: level, label: t(thinkingLabel(level)) }));
	const providerOptions = settings.providers.map((provider) => ({
		value: provider.provider,
		label: provider.name,
		...(provider.auth.configured ? {} : { description: t("Not configured") }),
	}));
	const modelOptions = (selectedProvider?.models ?? []).map((model) => ({
		value: model.modelId,
		label: model.name,
	}));
	const outputUnavailable =
		draft.kind === "provider" && selectedModel !== undefined && outputCeiling(selectedModel.maxOutputTokens) === null;
	const outputMaximum =
		draft.kind === "dedicated" ? OUTPUT_MAX : (outputCeiling(selectedModel?.maxOutputTokens) ?? OUTPUT_MAX);
	const canTest = !working && !dirty && savedConfig !== null && savedStatus === "configured";

	const validate = (): string | null => {
		if (draft.kind === "dedicated") {
			if (!draft.name.trim()) return t("Enter a name for the approval model.");
			if (!draft.baseUrl.trim()) return t("Fill in the name, base URL, and model ID.");
			if (!validBaseUrl(draft.baseUrl.trim())) return t("Enter a valid https:// or http:// URL");
			if (!draft.modelId.trim()) return t("Fill in the name, base URL, and model ID.");
			const reasoningMessage = reasoningError(draft);
			if (reasoningMessage) return t(reasoningMessage);
			if (draft.reasoningMode === "manual" && dedicatedLevels.length === 0) {
				return t("Add at least one reasoning level or turn off reasoning.");
			}
			if (!thinkingLevels.includes(draft.thinkingLevel)) {
				return t("Choose a supported reasoning level for this model.");
			}
		} else {
			if (!draft.provider) return t("Choose a provider for the approval model.");
			if (!selectedProvider) return t("Choose an available provider for the approval model.");
			if (!selectedProvider.auth.configured) return t("Configure credentials for this provider first.");
			if (!draft.modelId) return t("Choose a model for the approval model.");
			if (!selectedModel) return t("Choose an available model for the approval model.");
			if (!selectedModel.thinkingLevels.includes(draft.thinkingLevel)) {
				return t("Choose a supported reasoning level for this model.");
			}
			if (outputCeiling(selectedModel.maxOutputTokens) === null) {
				return t("This model cannot be used for approval because its output limit is below 128 tokens.");
			}
		}
		if (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < TIMEOUT_MIN || draft.timeoutMs > TIMEOUT_MAX) {
			return t("Timeout must be between 1000 and 15000 ms.");
		}
		if (!outputFits(draft.maxOutputTokens, draft.kind === "provider" ? selectedModel?.maxOutputTokens : undefined)) {
			return t("Output token limit must be between 128 and {{max}}.", { max: outputMaximum });
		}
		return null;
	};

	const openEditor = () => {
		if (busy) return;
		prepareEditor();
		requestOpenChange(true);
	};

	const changeConnectionKind = (kind: ReviewerConnectionKind) => {
		if (draft.kind === kind) return;
		const saved = settings.permissionReviewer.config;
		if (kind === "dedicated") {
			setDraft(isDedicatedConfig(saved) ? dedicatedDraftFromConfig(saved) : newDedicatedDraft());
		} else {
			setDraft(saved && !isDedicatedConfig(saved) ? savedDraft(settings) : defaultProviderDraft(settings));
		}
		setError(null);
		setNotice(null);
	};

	const changeProvider = (providerId: string) => {
		if (draft.kind !== "provider") return;
		const provider = providerFor(settings, providerId);
		const model = provider?.models[0];
		const levels = model?.thinkingLevels ?? [];
		const thinkingLevel = levels.includes(draft.thinkingLevel) ? draft.thinkingLevel : defaultThinkingLevel(levels);
		setDraft({
			...draft,
			provider: providerId,
			modelId: model?.modelId ?? "",
			thinkingLevel,
			maxOutputTokens: defaultOutputTokens(thinkingLevel, model?.maxOutputTokens),
		});
	};

	const changeModel = (modelId: string) => {
		if (draft.kind !== "provider") return;
		const model = modelFor(selectedProvider, modelId);
		const levels = model?.thinkingLevels ?? [];
		const thinkingLevel = levels.includes(draft.thinkingLevel) ? draft.thinkingLevel : defaultThinkingLevel(levels);
		const previousDefault = defaultOutputTokens(draft.thinkingLevel, selectedModel?.maxOutputTokens);
		const nextDefault = defaultOutputTokens(thinkingLevel, model?.maxOutputTokens);
		const keepOutput =
			draft.maxOutputTokens !== previousDefault && outputFits(draft.maxOutputTokens, model?.maxOutputTokens);
		setDraft({
			...draft,
			modelId,
			thinkingLevel,
			maxOutputTokens: keepOutput ? draft.maxOutputTokens : nextDefault,
		});
	};

	const changeThinking = (thinkingLevel: ThinkingSelectionView) => {
		if (draft.kind !== "provider") {
			setDraft({ ...draft, thinkingLevel });
			return;
		}
		const previousDefault = defaultOutputTokens(draft.thinkingLevel, selectedModel?.maxOutputTokens);
		const nextDefault = defaultOutputTokens(thinkingLevel, selectedModel?.maxOutputTokens);
		const keepOutput =
			draft.maxOutputTokens !== previousDefault && outputFits(draft.maxOutputTokens, selectedModel?.maxOutputTokens);
		setDraft({
			...draft,
			thinkingLevel,
			maxOutputTokens: keepOutput ? draft.maxOutputTokens : nextDefault,
		});
	};

	const changeReasoning = (patch: ReasoningDraft) => {
		if (draft.kind !== "dedicated") return;
		const reasoningMode: DedicatedReasoningMode = patch.reasoningMode === "manual" ? "manual" : "off";
		// 复用现有映射编辑器：开启推理但还没有档位时，从最低支持档开始。
		const rows: readonly ReasoningRow[] =
			reasoningMode === "manual" && patch.reasoningRows.length === 0
				? [{ key: crypto.randomUUID(), level: "low", value: "" }]
				: patch.reasoningRows;
		const levels = dedicatedThinkingLevels({ reasoningMode, reasoningRows: rows });
		const thinkingLevel = levels.includes(draft.thinkingLevel) ? draft.thinkingLevel : (levels[0] ?? "off");
		setDraft({ ...draft, reasoningMode, reasoningRows: rows, thinkingLevel });
	};

	const configForDraft = (): PermissionReviewerConfigView => {
		if (draft.kind === "provider") {
			return {
				provider: draft.provider,
				modelId: draft.modelId,
				thinkingLevel: draft.thinkingLevel,
				timeoutMs: draft.timeoutMs,
				maxOutputTokens: draft.maxOutputTokens,
			};
		}
		return {
			source: "dedicated",
			name: draft.name.trim(),
			api: draft.api,
			baseUrl: draft.baseUrl.trim(),
			modelId: draft.modelId.trim(),
			thinkingLevel: draft.thinkingLevel,
			timeoutMs: draft.timeoutMs,
			maxOutputTokens: draft.maxOutputTokens,
			reasoningMode: draft.reasoningMode,
			...(draft.reasoningMode === "manual"
				? {
						thinkingLevelMap: Object.fromEntries(
							draft.reasoningRows.map((row) => [row.level, row.value.trim()]),
						) as ReasoningMap,
					}
				: {}),
		};
	};

	const save = async () => {
		if (working) return;
		const message = validate();
		if (message) {
			setError(message);
			setNotice(null);
			return;
		}
		let credential: { action: "set"; value: string } | { action: "keep" } | undefined;
		if (draft.kind === "dedicated") {
			const apiKey = draft.apiKey.trim();
			if (apiKey) credential = { action: "set", value: apiKey };
			else if (savedDedicated && saved.authConfigured !== false) credential = { action: "keep" };
			else {
				setError(t("Enter an API key to save the dedicated approval model."));
				setNotice(null);
				return;
			}
		}
		setOperation("save");
		setError(null);
		setNotice(null);
		try {
			const next = await api.updateModelSettings({
				requestId: crypto.randomUUID(),
				mutation: {
					type: "set_permission_reviewer",
					config: configForDraft(),
					...(credential ? { credential } : {}),
				},
			});
			onSaved(next);
			// The credential only lives in the dialog draft; drop it as soon as it is saved.
			setDraft((current) => (current.kind === "dedicated" ? { ...current, apiKey: "" } : current));
			requestOpenChange(false);
			setConfirmRemoval(false);
			setNotice(t("Approval model saved"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Approval model settings could not be saved."));
		} finally {
			setOperation(null);
		}
	};

	const clear = async () => {
		if (working || !hasSavedConfiguration) return;
		setOperation("clear");
		setError(null);
		setNotice(null);
		try {
			// 清除审批连接只移除专用密钥，不影响任何共享提供商凭据。
			const next = await api.updateModelSettings({
				requestId: crypto.randomUUID(),
				mutation: { type: "set_permission_reviewer", config: null, credential: { action: "remove" } },
			});
			onSaved(next);
			setDraft((current) => (current.kind === "dedicated" ? { ...current, apiKey: "" } : current));
			requestOpenChange(false);
			setConfirmRemoval(false);
			setNotice(t("Approval model removed"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Approval model could not be removed."));
		} finally {
			setOperation(null);
		}
	};

	const test = async () => {
		if (!canTest) return;
		setOperation("test");
		setError(null);
		setNotice(null);
		setTestNotice({ title: t("Testing…"), tone: "info" });
		try {
			// 只测试已保存的连接；kind=permission-review 不接受命令、端点或密钥。
			const result: ClientResult<"model/testConnection"> = await api.testModelConnection({
				requestId: crypto.randomUUID(),
				kind: "permission-review",
			});
			setTestNotice({
				title: t(result.ok ? "Approval model test succeeded" : "Approval model test failed"),
				message: `${result.latencyMs} ms${result.ok ? "" : ` · ${result.message}`}`,
				tone: result.ok ? "success" : "error",
			});
		} catch (cause) {
			setTestNotice({
				title: t("Approval model test failed."),
				message: cause instanceof Error ? cause.message : undefined,
				tone: "error",
			});
		} finally {
			setOperation(null);
		}
	};

	const savedLabel = (() => {
		if (savedStatus === "invalid") {
			if (savedDedicated && saved.authConfigured === false) {
				return t("The saved approval model is missing its API key.");
			}
			return t(
				"The saved approval model configuration is invalid. Choose a supported provider, model, and reasoning level.",
			);
		}
		if (!savedConfig) return t("No approval model configured");
		if (isDedicatedConfig(savedConfig)) {
			return `${t("Approval model configured")}: ${savedConfig.name} · ${savedConfig.modelId} · ${t(
				thinkingLabel(savedConfig.thinkingLevel),
			)}`;
		}
		return `${t("Approval model configured")}: ${savedProvider?.name ?? savedConfig.provider} · ${
			savedModel?.name ?? savedConfig.modelId
		} · ${t(thinkingLabel(savedConfig.thinkingLevel))}`;
	})();

	return (
		<>
			{renderCard ? (
				<div className="settings-section reviewer-model-section">
					<header className="settings-section-heading">
						<h3>{t("Approval model")}</h3>
					</header>
					<p className="model-provider-intro">
						{t(
							"Optionally review Auto-mode actions with a separate model. Your chat model and default reasoning stay unchanged.",
						)}
					</p>
					<article className="settings-card model-service-panel reviewer-model-panel">
						<div className="model-service-panel-top">
							<div className="model-service-copy">
								<span>{t("Reviewer connection")}</span>
								<p>
									{t(
										"Use an independent connection or a configured provider. The approval model never changes your chat defaults.",
									)}
								</p>
							</div>
							<button
								className="settings-secondary-button"
								disabled={!serverReady || busy}
								onClick={openEditor}
								type="button"
							>
								{hasSavedConfiguration ? t("Edit") : t("Configure")}
							</button>
						</div>
						{savedStatus !== "configured" || !savedConfig ? (
							<p className={`reviewer-model-status ${savedStatus === "invalid" ? "invalid" : "unset"}`}>
								{savedLabel}
							</p>
						) : (
							<div className="model-service-status reviewer-model-status">
								<span>{t("Approval model configured")}</span>
								{isDedicatedConfig(savedConfig) ? (
									<>
										<strong>{savedConfig.name}</strong>
										<code>{savedConfig.modelId}</code>
										<span className="model-service-badge">{savedConfig.api}</span>
										<span className="model-service-badge">{t(thinkingLabel(savedConfig.thinkingLevel))}</span>
									</>
								) : (
									<>
										<strong>{savedProvider?.name ?? savedConfig.provider}</strong>
										<code>{savedModel?.name ?? savedConfig.modelId}</code>
										<span className="model-service-badge">{t(thinkingLabel(savedConfig.thinkingLevel))}</span>
									</>
								)}
							</div>
						)}
						{error && !open ? (
							<p className="settings-action-message error" role="alert">
								<XCircle aria-hidden="true" size={15} />
								{error}
							</p>
						) : null}
						{notice && !open ? (
							<output className="status-paragraph settings-action-message">
								<CheckCircle aria-hidden="true" size={15} />
								{notice}
							</output>
						) : null}
					</article>
				</div>
			) : null}
			{open ? (
				<dialog
					aria-label={t("Approval model")}
					className="model-provider-dialog model-service-dialog reviewer-model-dialog"
					onCancel={(event) => {
						event.preventDefault();
						if (!working) requestClose();
					}}
					onClick={(event) => {
						if (event.target === event.currentTarget && !working) onRequestClose();
					}}
					onKeyDown={(event) => {
						trapDialogTab(event.nativeEvent, event.currentTarget);
						if (event.key !== "Escape" || event.defaultPrevented) return;
						event.preventDefault();
						if (!working) requestClose();
					}}
					ref={dialogRef}
				>
					<div className="model-provider-dialog-content">
						<form
							className="model-provider-editor"
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<header className="model-provider-editor-header">
								<div>
									<h2>{t("Approval model")}</h2>
									<p>
										{t(
											"Choose how Auto-mode reviews reach a model. Testing and saving never execute the review samples.",
										)}
									</p>
								</div>
								<button
									aria-label={t("Close")}
									className="model-provider-dialog-close"
									disabled={working}
									onClick={requestClose}
									type="button"
								>
									<X aria-hidden="true" size={18} />
								</button>
							</header>
							<div className="model-provider-editor-body">
								<div className="model-custom-provider-fields">
									<label htmlFor={`${fieldId}-connection`} className="model-api-key-field">
										<span>{t("Connection type")}</span>
										<MenuSelect
											ariaLabel={t("Connection type")}
											disabled={working}
											id={`${fieldId}-connection`}
											onChange={changeConnectionKind}
											options={[
												{ value: "dedicated", label: t("Dedicated connection") },
												{ value: "provider", label: t("Existing provider") },
											]}
											value={draft.kind}
										/>
									</label>
								</div>
								{draft.kind === "dedicated" ? (
									<>
										<div className="model-custom-provider-fields">
											<label className="model-api-key-field">
												<span>{t("Name")}</span>
												<input
													autoComplete="off"
													disabled={working}
													onChange={(event) => setDraft({ ...draft, name: event.target.value })}
													placeholder={t("My reviewer")}
													type="text"
													value={draft.name}
												/>
											</label>
											<label htmlFor={`${fieldId}-api`} className="model-api-key-field">
												<span>{t("API format")}</span>
												<MenuSelect
													ariaLabel={t("API format")}
													disabled={working}
													id={`${fieldId}-api`}
													onChange={(api) => setDraft({ ...draft, api })}
													options={API_FORMATS.map((format) => ({
														value: format.value,
														label: t(format.label),
													}))}
													value={draft.api}
												/>
											</label>
											<label className="model-api-key-field">
												<span>{t("Base URL")}</span>
												<input
													autoComplete="off"
													disabled={working}
													onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
													placeholder="https://api.example.com/v1"
													type="text"
													value={draft.baseUrl}
												/>
											</label>
											<label className="model-api-key-field">
												<span>{t("Model ID")}</span>
												<input
													autoComplete="off"
													disabled={working}
													onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
													placeholder="review-model"
													type="text"
													value={draft.modelId}
												/>
											</label>
											<label className="model-api-key-field">
												<span>{t("API key")}</span>
												<input
													autoComplete="off"
													disabled={working}
													onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
													placeholder={
														savedDedicated && saved.authConfigured !== false
															? t("Enter a new key to replace the saved credential")
															: "sk-…"
													}
													type="password"
													value={draft.apiKey}
												/>
											</label>
										</div>
										{savedDedicated && saved.authConfigured !== false ? (
											<div className="model-saved-credential">
												<span>{t("Saved API key")}</span>
												<code>••••••••••••</code>
											</div>
										) : null}
										<ModelReasoningEditor
											api={draft.api}
											disabled={working}
											id={`${fieldId}-reviewer-reasoning`}
											model={draft}
											onChange={changeReasoning}
										/>
										<div className="model-custom-provider-fields">
											<label htmlFor={`${fieldId}-thinking`} className="model-api-key-field">
												<span>{t("Reasoning effort")}</span>
												<MenuSelect
													ariaLabel={t("Approval reasoning")}
													disabled={working || thinkingOptions.length === 0}
													id={`${fieldId}-thinking`}
													onChange={changeThinking}
													options={thinkingOptions}
													placeholder={t("Select a reasoning level")}
													value={draft.thinkingLevel}
												/>
											</label>
										</div>
									</>
								) : (
									<div className="reviewer-model-fields">
										<label htmlFor={`${fieldId}-provider`}>
											<span>{t("Provider")}</span>
											<MenuSelect
												ariaLabel={t("Approval model provider")}
												disabled={working}
												id={`${fieldId}-provider`}
												onChange={changeProvider}
												options={providerOptions}
												placeholder={t("Select a provider")}
												value={draft.provider}
											/>
										</label>
										<label htmlFor={`${fieldId}-model`}>
											<span>{t("Model")}</span>
											<MenuSelect
												ariaLabel={t("Approval model")}
												disabled={working || modelOptions.length === 0}
												id={`${fieldId}-model`}
												onChange={changeModel}
												options={modelOptions}
												placeholder={t("Select a model")}
												value={draft.modelId}
											/>
										</label>
										<label htmlFor={`${fieldId}-thinking`}>
											<span>{t("Reasoning effort")}</span>
											<MenuSelect
												ariaLabel={t("Approval reasoning")}
												disabled={working || thinkingOptions.length === 0}
												id={`${fieldId}-thinking`}
												onChange={changeThinking}
												options={thinkingOptions}
												placeholder={t("Select a reasoning level")}
												value={draft.thinkingLevel}
											/>
										</label>
									</div>
								)}
								{outputUnavailable ? (
									<p className="settings-action-message error" role="alert">
										<XCircle aria-hidden="true" size={15} />
										{t(
											"This model cannot be used for approval because its output limit is below 128 tokens.",
										)}
									</p>
								) : null}
								<details className="model-advanced-settings reviewer-model-advanced">
									<summary>{t("Advanced approval settings")}</summary>
									<div className="reviewer-model-budgets">
										<label>
											<span>{t("Timeout (ms)")}</span>
											<input
												disabled={working}
												max={TIMEOUT_MAX}
												min={TIMEOUT_MIN}
												onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })}
												step={100}
												type="number"
												value={draft.timeoutMs}
											/>
										</label>
										<label>
											<span>{t("Max output tokens")}</span>
											<input
												disabled={working}
												max={outputMaximum}
												min={OUTPUT_MIN}
												onChange={(event) =>
													setDraft({ ...draft, maxOutputTokens: Number(event.target.value) })
												}
												step={1}
												type="number"
												value={draft.maxOutputTokens}
											/>
										</label>
									</div>
									<p>
										{t(
											"The approval request uses this saved timeout and output budget. Output is capped at {{max}}.",
											{ max: outputMaximum },
										)}
									</p>
								</details>
							</div>
							<footer className="model-provider-editor-footer">
								{!canTest && !working && open ? (
									<p>
										{dirty
											? t("Save the current approval model before testing.")
											: savedConfig
												? t("The saved approval model cannot be tested until its configuration is valid.")
												: t("Save an approval model before testing.")}
									</p>
								) : null}
								{confirmRemoval ? (
									<div className="model-removal-confirm" role="alert">
										<p>{t("Remove the approval model configuration and its dedicated API key?")}</p>
										<button
											className="settings-secondary-button"
											disabled={working}
											onClick={() => setConfirmRemoval(false)}
											type="button"
										>
											{t("Cancel")}
										</button>
										<button
											className="settings-danger-button"
											disabled={working}
											onClick={() => void clear()}
											type="button"
										>
											{t("Confirm remove approval model")}
										</button>
									</div>
								) : null}
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
								<div className="settings-form-actions">
									{hasSavedConfiguration ? (
										<button
											className="settings-danger-button"
											disabled={working}
											onClick={() => setConfirmRemoval(true)}
											type="button"
										>
											{t("Remove approval model")}
										</button>
									) : null}
									<button
										className="settings-secondary-button"
										disabled={working}
										onClick={requestClose}
										type="button"
									>
										{t("Cancel")}
									</button>
									<button
										className="settings-secondary-button"
										disabled={!canTest}
										onClick={() => void test()}
										title={t(
											"Tests the saved approval model with the real review protocol. Model calls may incur usage charges.",
										)}
										type="button"
									>
										{operation === "test" ? t("Testing…") : t("Test approval model")}
									</button>
									<button
										className="settings-primary-button"
										disabled={working || outputUnavailable || !serverReady}
										type="submit"
									>
										{operation === "save" ? t("Saving…") : t("Save approval model")}
									</button>
								</div>
							</footer>
							{testNotice ? (
								<FloatingSystemNotice {...testNotice} onDismiss={() => setTestNotice(null)} />
							) : null}
						</form>
					</div>
				</dialog>
			) : null}
		</>
	);
}
