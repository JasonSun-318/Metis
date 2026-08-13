import { getLowestSupportedThinkingLevel, type ModelRegistry, type SettingsManager } from "@metis/coding-agent";

const TITLE_PROMPT = `You are a conversation title generator. Generate a concise title from the user's first message in the same language. Use no more than 10 characters for Chinese, Japanese, or Korean; otherwise use no more than 6 words. Output only the title. Do not answer the user.
Examples:
First message: 你好
Title: 日常问好
First message: Please help me fix the login issue
Title: Fix Login Issue`;
const CJK_TITLE_LIMIT = 10;
const OTHER_TITLE_WORD_LIMIT = 6;
const OTHER_TITLE_CHARACTER_LIMIT = 60;
const WIDE_CHARACTER =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u;

function truncate(value: string, limit: number): string {
	const characters = [...value];
	return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

function truncateTitle(value: string, source: string): string {
	if (WIDE_CHARACTER.test(source)) return truncate(value, CJK_TITLE_LIMIT);
	const words = value.split(/\s+/);
	const title =
		words.length <= OTHER_TITLE_WORD_LIMIT ? value : `${words.slice(0, OTHER_TITLE_WORD_LIMIT).join(" ")}…`;
	return truncate(title, OTHER_TITLE_CHARACTER_LIMIT);
}

function fallbackTitle(source: string): string | undefined {
	const normalized = source.replace(/\s+/g, " ").trim();
	return normalized ? truncateTitle(normalized, source) : undefined;
}

function cleanTitle(value: string, source: string): string | undefined {
	const firstLine = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return undefined;
	const cleaned = firstLine
		.replace(/^#{1,6}\s*/, "")
		.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "")
		.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
		.replace(/[.!?。！？；;：:]+$/u, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned ? truncateTitle(cleaned, source) : undefined;
}

export interface SessionTitleGenerator {
	generate(source: string): Promise<string | undefined>;
}

export class DefaultSessionTitleGenerator implements SessionTitleGenerator {
	private readonly dependencies: {
		modelRegistry: ModelRegistry;
		settingsManager: SettingsManager;
	};

	constructor(dependencies: { modelRegistry: ModelRegistry; settingsManager: SettingsManager }) {
		this.dependencies = dependencies;
	}

	async generate(source: string): Promise<string | undefined> {
		const fallback = fallbackTitle(source);
		if (!fallback) return undefined;
		const provider = this.dependencies.settingsManager.getDefaultProvider();
		const modelId = this.dependencies.settingsManager.getDefaultModel();
		if (!provider || !modelId) return undefined;

		try {
			this.dependencies.modelRegistry.refresh();
			const model = this.dependencies.modelRegistry.find(provider, modelId);
			if (!model || !this.dependencies.modelRegistry.hasConfiguredAuth(model)) return fallback;
			const auth = await this.dependencies.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return fallback;
			const reasoning = getLowestSupportedThinkingLevel(model);
			const message = await this.dependencies.modelRegistry
				.streamSimple(
					model,
					{
						systemPrompt: TITLE_PROMPT,
						messages: [
							{
								role: "user",
								content: `First message: ${truncate(source.trim(), 4_000)}\nTitle:`,
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						env: auth.env,
						headers: auth.headers,
						reasoning: reasoning === "off" ? undefined : reasoning,
						maxTokens: 32,
						maxRetries: 0,
						timeoutMs: 10_000,
						signal: AbortSignal.timeout(10_000),
					},
				)
				.result();
			return (
				cleanTitle(
					message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
					source,
				) ?? fallback
			);
		} catch {
			return fallback;
		}
	}
}
