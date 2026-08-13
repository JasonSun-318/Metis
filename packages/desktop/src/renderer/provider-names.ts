/**
 * Display-only provider names for the renderer. The model option wire type
 * carries only the provider key (e.g. "azure-openai-responses"), so map the
 * built-in provider set to a readable label and fall back to a title-cased
 * form for custom providers.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	"amazon-bedrock": "Amazon Bedrock",
	"ant-ling": "Ant Ling",
	"azure-openai-responses": "Azure OpenAI Responses",
	cerebras: "Cerebras",
	"cloudflare-ai-gateway": "Cloudflare AI Gateway",
	"cloudflare-workers-ai": "Cloudflare Workers AI",
	deepseek: "DeepSeek",
	fireworks: "Fireworks",
	google: "Google Gemini",
	"google-vertex": "Google Vertex AI",
	groq: "Groq",
	huggingface: "Hugging Face",
	"kimi-coding": "Kimi For Coding",
	mistral: "Mistral",
	minimax: "MiniMax",
	"minimax-cn": "MiniMax (China)",
	moonshotai: "Moonshot AI",
	"moonshotai-cn": "Moonshot AI (China)",
	nvidia: "NVIDIA NIM",
	opencode: "OpenCode Zen",
	"opencode-go": "OpenCode Go",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	together: "Together AI",
	"vercel-ai-gateway": "Vercel AI Gateway",
	xai: "xAI",
	zai: "ZAI Coding Plan (Global)",
	"zai-coding-cn": "ZAI Coding Plan (China)",
	xiaomi: "Xiaomi MiMo",
	"xiaomi-token-plan-cn": "Xiaomi MiMo Token Plan (China)",
	"xiaomi-token-plan-ams": "Xiaomi MiMo Token Plan (Amsterdam)",
	"xiaomi-token-plan-sgp": "Xiaomi MiMo Token Plan (Singapore)",
};

export function providerDisplayName(provider: string): string {
	const known = PROVIDER_DISPLAY_NAMES[provider];
	if (known) return known;
	return provider
		.split(/[-_]+/g)
		.filter(Boolean)
		.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
		.join(" ");
}
