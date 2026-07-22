import type { AuthStorage } from "./auth-storage.ts";

export const WEB_SEARCH_PROVIDERS = ["brave", "tavily", "serpapi"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export const WEB_SEARCH_PROVIDER_INFO = {
	brave: {
		label: "Brave Search",
		credentialId: "web-search:brave",
		networkTarget: { host: "api.search.brave.com", port: 443 },
	},
	tavily: {
		label: "Tavily",
		credentialId: "web-search:tavily",
		networkTarget: { host: "api.tavily.com", port: 443 },
	},
	serpapi: {
		label: "SerpApi",
		credentialId: "web-search:serpapi",
		networkTarget: { host: "serpapi.com", port: 443 },
	},
} as const;

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
	return typeof value === "string" && WEB_SEARCH_PROVIDERS.includes(value as WebSearchProvider);
}

export function webSearchCredentialId(provider: WebSearchProvider): string {
	return WEB_SEARCH_PROVIDER_INFO[provider].credentialId;
}

export function webSearchProviderFromCredentialId(value: string): WebSearchProvider | undefined {
	return WEB_SEARCH_PROVIDERS.find((provider) => webSearchCredentialId(provider) === value);
}

export function resolveWebSearchApiKey(
	authStorage: AuthStorage,
	provider: WebSearchProvider,
): Promise<string | undefined> {
	return authStorage.getApiKey(webSearchCredentialId(provider), { includeFallback: false });
}
