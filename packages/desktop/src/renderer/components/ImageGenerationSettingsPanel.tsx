import type { ModelSettingsView } from "@metis/app-protocol";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { CheckCircle, Key, X, XCircle } from "../icons.tsx";
import { trapDialogTab } from "./dialog-focus.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import { ModelSettingsCard } from "./ModelSettingsCard.tsx";
import "./image-generation-settings.css";

type ImageConfig = NonNullable<NonNullable<ModelSettingsView["imageGeneration"]>["config"]>;
type ImageApi = ImageConfig["api"];
interface ImageDraft {
	name: string;
	api: ImageApi;
	baseUrl: string;
	modelId: string;
	credentialProvider: string;
	apiKey: string;
}
const API_DEFAULTS: Record<ImageApi, { label: string; baseUrl: string; example: string }> = {
	"openai-images": { label: "OpenAI Images", baseUrl: "https://api.openai.com/v1", example: "gpt-image-2.5-flare" },
	"google-interactions": {
		label: "Google Interactions",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		example: "gemini-nano-banana-2.1",
	},
	"openrouter-images": {
		label: "OpenRouter Images",
		baseUrl: "https://openrouter.ai/api/v1",
		example: "google/gemini-3.1-flash-image",
	},
};
function savedDraft(settings: ModelSettingsView): ImageDraft {
	const config = settings.imageGeneration?.config;
	return {
		name: config?.name ?? "",
		api: config?.api ?? "openai-images",
		baseUrl: config?.baseUrl ?? API_DEFAULTS["openai-images"].baseUrl,
		modelId: config?.modelId ?? "",
		credentialProvider: config?.credentialProvider ?? "",
		apiKey: "",
	};
}

export function ImageGenerationSettingsPanel({
	api,
	busy,
	onBusyChange,
	onDirtyChange,
	onOpenChange,
	onRequestClose,
	onSaved,
	open,
	serverReady,
	settings,
}: {
	readonly api: Pick<MetisDesktopApi, "updateModelSettings">;
	readonly busy: boolean;
	readonly onBusyChange?: (busy: boolean) => void;
	readonly onDirtyChange?: (dirty: boolean) => void;
	readonly onOpenChange: (open: boolean) => void;
	readonly onRequestClose: () => void;
	readonly onSaved: (settings: ModelSettingsView) => void;
	readonly open: boolean;
	readonly serverReady: boolean;
	readonly settings: ModelSettingsView;
}) {
	const { t } = useTranslation();
	const fieldId = useId();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [draft, setDraft] = useState(() => savedDraft(settings));
	const [baseline, setBaseline] = useState(draft);
	const [operation, setOperation] = useState<"save" | "remove" | null>(null);
	const [confirmRemoval, setConfirmRemoval] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const working = operation !== null;
	const disabled = busy || working || !serverReady;
	const dirty = open && JSON.stringify(draft) !== JSON.stringify(baseline);
	const saved = settings.imageGeneration;
	const configured = saved?.status === "configured" && saved.config !== null;
	const hasSaved = Boolean(saved?.config) || saved?.status === "invalid";
	const storedKey = Boolean(saved?.config && !saved.config.credentialProvider && saved.authConfigured);
	const providers = settings.providers.filter((provider) => provider.storedApiKey === true);
	const prepared = useRef(false);

	useEffect(() => {
		if (!open) {
			prepared.current = false;
			return;
		}
		// A background settings refresh must never replace an open editor's draft.
		if (prepared.current) return;
		prepared.current = true;
		const next = savedDraft(settings);
		setDraft(next);
		setBaseline(next);
		setConfirmRemoval(false);
		setError(null);
		setNotice(null);
	}, [open, settings]);
	useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
	useEffect(() => onBusyChange?.(working), [working, onBusyChange]);
	useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
	useEffect(() => {
		if (!open) return;
		const dialog = dialogRef.current;
		if (!dialog) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const triggerContainer = previous?.matches(".image-generation-settings-card") ? previous.parentElement : null;
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		dialog.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
		return () => {
			if (dialog.open && typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
			if (previous?.isConnected) previous.focus();
			// Discarding a draft remounts this panel; return to its replacement card.
			else triggerContainer?.querySelector<HTMLButtonElement>(".image-generation-settings-card")?.focus();
		};
	}, [open]);

	const close = () => {
		if (!working && !busy) onRequestClose();
	};
	const changeApi = (api: ImageApi) => {
		const defaultAddress = draft.baseUrl === API_DEFAULTS[draft.api].baseUrl || !draft.baseUrl.trim();
		setDraft({ ...draft, api, ...(defaultAddress ? { baseUrl: API_DEFAULTS[api].baseUrl } : {}) });
	};
	const validate = (): string | null => {
		if (!draft.name.trim() || !draft.modelId.trim() || !draft.baseUrl.trim()) {
			return t("Fill in the name, base URL, and model ID.");
		}
		try {
			const url = new URL(draft.baseUrl.trim());
			if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
				return t("Enter a base URL without credentials, query parameters, or a fragment.");
			}
		} catch {
			return t("Enter a valid https:// or http:// URL");
		}
		if (draft.credentialProvider) {
			if (!providers.some((provider) => provider.provider === draft.credentialProvider)) {
				return t("Choose a provider with a saved API key.");
			}
		} else if (!draft.apiKey.trim() && !storedKey) {
			return t("Enter an API key for image generation.");
		}
		return null;
	};
	const save = async () => {
		if (disabled) return;
		const message = validate();
		if (message) {
			setError(message);
			return;
		}
		setOperation("save");
		setError(null);
		try {
			const config: ImageConfig = {
				name: draft.name.trim(),
				api: draft.api,
				baseUrl: draft.baseUrl.trim(),
				modelId: draft.modelId.trim(),
				...(draft.credentialProvider ? { credentialProvider: draft.credentialProvider } : {}),
			};
			const next = await api.updateModelSettings({
				requestId: crypto.randomUUID(),
				mutation: {
					type: "set_image_generation",
					config,
					credential: draft.credentialProvider
						? { action: "remove" }
						: draft.apiKey.trim()
							? { action: "set", value: draft.apiKey.trim() }
							: { action: "keep" },
				},
			});
			onSaved(next);
			setDraft(savedDraft(next));
			onOpenChange(false);
			setNotice(t("Image generation model saved"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Image generation settings could not be saved."));
		} finally {
			setOperation(null);
		}
	};
	const remove = async () => {
		if (disabled || !hasSaved) return;
		setOperation("remove");
		setError(null);
		try {
			const next = await api.updateModelSettings({
				requestId: crypto.randomUUID(),
				mutation: { type: "set_image_generation", config: null, credential: { action: "remove" } },
			});
			onSaved(next);
			setDraft(savedDraft(next));
			onOpenChange(false);
			setNotice(t("Image generation model removed"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Image generation model could not be removed."));
		} finally {
			setOperation(null);
		}
	};

	return (
		<>
			<ModelSettingsCard
				ariaLabel={t("Image generation model")}
				className="model-specialized-card image-generation-settings-card"
				title={t("Image generation model")}
				status={configured ? "configured" : saved?.status === "invalid" ? "invalid" : "unconfigured"}
				disabled={disabled}
				onClick={() => onOpenChange(true)}
				description={
					configured && saved?.config
						? `${saved.config.name} · ${saved.config.modelId} · ${API_DEFAULTS[saved.config.api].label}`
						: saved?.status === "invalid"
							? t("Check the image model connection and API key.")
							: t("No image generation model configured")
				}
			/>
			{notice && !open ? (
				<output className="settings-action-message">
					<CheckCircle aria-hidden="true" size={15} />
					{notice}
				</output>
			) : null}
			{open ? (
				<dialog
					aria-label={t("Image generation model")}
					className="model-provider-dialog image-generation-settings-dialog"
					ref={dialogRef}
					onCancel={(event) => {
						event.preventDefault();
						close();
					}}
					onClick={(event) => {
						if (event.target === event.currentTarget) close();
					}}
					onKeyDown={(event) => {
						trapDialogTab(event.nativeEvent, event.currentTarget);
						if (event.key === "Escape" && !event.defaultPrevented) {
							event.preventDefault();
							close();
						}
					}}
				>
					<div className="model-provider-dialog-content">
						<form
							className="model-provider-editor"
							noValidate
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<header className="model-provider-editor-header">
								<div>
									<h2>{t("Image generation model")}</h2>
									<p>{t("Connect an image model to create and edit images in chat.")}</p>
								</div>
								<button
									aria-label={t("Close")}
									className="model-provider-dialog-close"
									disabled={working || busy}
									onClick={close}
									type="button"
								>
									<X aria-hidden="true" size={18} />
								</button>
							</header>
							<div className="model-provider-editor-body">
								<div className="image-generation-settings-fields">
									<label>
										<span>{t("Name")}</span>
										<input
											autoComplete="off"
											disabled={disabled}
											maxLength={120}
											value={draft.name}
											placeholder={t("My image model")}
											onChange={(event) => setDraft({ ...draft, name: event.target.value })}
										/>
									</label>
									<label htmlFor={`${fieldId}-api`}>
										<span>{t("API format")}</span>
										<MenuSelect
											ariaLabel={t("API format")}
											id={`${fieldId}-api`}
											disabled={disabled}
											value={draft.api}
											onChange={changeApi}
											options={Object.entries(API_DEFAULTS).map(([value, format]) => ({
												value: value as ImageApi,
												label: format.label,
											}))}
										/>
									</label>
									<label className="image-generation-settings-wide">
										<span>{t("Base URL")}</span>
										<input
											autoComplete="off"
											disabled={disabled}
											type="url"
											maxLength={2048}
											value={draft.baseUrl}
											placeholder={API_DEFAULTS[draft.api].baseUrl}
											onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
										/>
									</label>
									<label className="image-generation-settings-wide">
										<span id={`${fieldId}-model-label`}>{t("Model ID")}</span>
										<input
											autoComplete="off"
											disabled={disabled}
											maxLength={300}
											aria-labelledby={`${fieldId}-model-label`}
											aria-describedby={`${fieldId}-model-hint`}
											value={draft.modelId}
											placeholder={API_DEFAULTS[draft.api].example}
											onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
										/>
										<small id={`${fieldId}-model-hint`}>
											{t("Use the image model ID provided by your service.")}
										</small>
									</label>
								</div>
								<div className="image-generation-settings-credentials">
									<label htmlFor={`${fieldId}-credential`}>
										<span>{t("API key source")}</span>
										<MenuSelect
											ariaLabel={t("API key source")}
											id={`${fieldId}-credential`}
											disabled={disabled}
											value={draft.credentialProvider}
											onChange={(credentialProvider) =>
												setDraft({ ...draft, credentialProvider, apiKey: "" })
											}
											options={[
												{ value: "", label: t("Dedicated API key") },
												...providers.map((provider) => ({
													value: provider.provider,
													label: provider.name,
												})),
												...(draft.credentialProvider &&
												!providers.some((provider) => provider.provider === draft.credentialProvider)
													? [
															{
																value: draft.credentialProvider,
																label: `${draft.credentialProvider} · ${t("Not configured")}`,
																disabled: true,
															},
														]
													: []),
											]}
										/>
									</label>
									{draft.credentialProvider ? (
										<p className="image-generation-settings-key-hint">
											<Key aria-hidden="true" size={14} />
											{t("Uses this provider's saved API key with the base URL above.")}
										</p>
									) : (
										<label>
											<span id={`${fieldId}-key-label`}>{t("API key")}</span>
											<input
												autoComplete="new-password"
												disabled={disabled}
												type="password"
												maxLength={32768}
												aria-labelledby={`${fieldId}-key-label`}
												aria-describedby={storedKey ? `${fieldId}-key-hint` : undefined}
												value={draft.apiKey}
												placeholder={
													storedKey ? t("Leave blank to keep the saved key") : t("Enter API key")
												}
												onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
											/>
											{storedKey ? (
												<small id={`${fieldId}-key-hint`}>
													{t("An API key is saved. Leave this field blank to keep it.")}
												</small>
											) : null}
										</label>
									)}
								</div>
							</div>
							<footer className="model-provider-editor-footer">
								{error ? (
									<p className="settings-action-message error" role="alert">
										<XCircle aria-hidden="true" size={15} />
										{error}
									</p>
								) : null}
								{confirmRemoval ? (
									<div className="model-removal-confirm" role="alert">
										<p>
											{t("Remove this image model and its dedicated API key? Existing images will be kept.")}
										</p>
										<button
											className="settings-secondary-button"
											disabled={disabled}
											onClick={() => setConfirmRemoval(false)}
											type="button"
										>
											{t("Cancel")}
										</button>
										<button
											className="settings-danger-button"
											disabled={disabled}
											onClick={() => void remove()}
											type="button"
										>
											{operation === "remove" ? t("Removing…") : t("Confirm removal")}
										</button>
									</div>
								) : (
									<div className="settings-form-actions">
										{hasSaved ? (
											<button
												className="settings-danger-button image-generation-settings-remove"
												disabled={disabled}
												onClick={() => setConfirmRemoval(true)}
												type="button"
											>
												{t("Remove")}
											</button>
										) : null}
										<button
											className="settings-secondary-button"
											disabled={working || busy}
											onClick={close}
											type="button"
										>
											{t("Cancel")}
										</button>
										<button className="settings-primary-button" disabled={disabled} type="submit">
											{operation === "save" ? t("Saving…") : t("Save image model")}
										</button>
									</div>
								)}
							</footer>
						</form>
					</div>
				</dialog>
			) : null}
		</>
	);
}
