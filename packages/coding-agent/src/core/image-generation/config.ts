export type ImageGenerationApi = "openai-images" | "google-interactions" | "openrouter-images";

export const IMAGE_GENERATION_AUTH_KEY = "image-generation";

/** Independent image service; its API key is stored exclusively in AuthStorage. */
export interface ImageGenerationConfig {
	readonly name: string;
	readonly api: ImageGenerationApi;
	readonly baseUrl: string;
	readonly modelId: string;
	readonly credentialProvider?: string;
}

export interface ImageGenerationConfigurationView {
	readonly config: ImageGenerationConfig | null;
	readonly status: "unconfigured" | "configured" | "invalid";
}

const KEYS = new Set(["name", "api", "baseUrl", "modelId", "credentialProvider"]);

function text(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
		throw new TypeError(`Invalid image generation ${field}`);
	}
	return value.trim();
}

/** Validate persisted settings as well as direct host updates without carrying extra fields forward. */
export function normalizeImageGenerationConfig(value: unknown): ImageGenerationConfig | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Invalid image generation configuration");
	}
	const raw = value as Record<string, unknown>;
	if (Reflect.ownKeys(raw).some((key) => typeof key !== "string" || !KEYS.has(key))) {
		throw new TypeError("Invalid image generation configuration fields");
	}
	if (raw.api !== "openai-images" && raw.api !== "google-interactions" && raw.api !== "openrouter-images") {
		throw new TypeError("Unsupported image generation API");
	}
	const name = text(raw.name, "name", 120);
	const modelId = text(raw.modelId, "model ID", 300);
	const baseUrl = text(raw.baseUrl, "base URL", 2_048);
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new TypeError("Image generation base URL must be an HTTP(S) URL");
	}
	if (
		!["http:", "https:"].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new TypeError("Image generation base URL must be HTTP(S) without credentials, query, or fragment");
	}
	return {
		name,
		api: raw.api,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		modelId,
		...(raw.credentialProvider !== undefined
			? { credentialProvider: text(raw.credentialProvider, "credential provider", 256) }
			: {}),
	};
}
