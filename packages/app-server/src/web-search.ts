import type { ClientParams, ClientResult, WebSearchProvider } from "@metis/app-protocol";
import type { AuthStorage, SettingsManager } from "@metis/coding-agent/host";

const WEB_SEARCH_PROVIDERS = ["brave", "tavily", "serpapi"] as const;

function isWebSearchProvider(value: string): value is WebSearchProvider {
	return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

function credentialId(provider: WebSearchProvider): string {
	return `web-search:${provider}`;
}

/** Exposes the global web-search toggle, provider, and API-key credential to the desktop. */
export class WebSearchService {
	private readonly settingsManager: SettingsManager;
	private readonly authStorage: AuthStorage;

	constructor(options: { readonly settingsManager: SettingsManager; readonly authStorage: AuthStorage }) {
		this.settingsManager = options.settingsManager;
		this.authStorage = options.authStorage;
	}

	view(): ClientResult<"webSearch/get"> {
		const settings = this.settingsManager.getWebSearchSettings();
		const provider = isWebSearchProvider(settings.provider) ? settings.provider : "brave";
		const credential = this.authStorage.get(credentialId(provider));
		const configuredProviders = WEB_SEARCH_PROVIDERS.filter(
			(candidate) => this.authStorage.get(credentialId(candidate))?.type === "api_key",
		);
		const authConfigured = credential !== undefined;
		return {
			enabled: settings.enabled,
			provider,
			authConfigured,
			configuredProviders,
			...(credential?.type === "api_key" ? { authSource: "stored" as const } : {}),
		};
	}

	reveal(params: ClientParams<"webSearch/credential/reveal">): ClientResult<"webSearch/credential/reveal"> {
		const credential = this.authStorage.get(credentialId(params.provider));
		return { credential: credential?.type === "api_key" ? credential.key : null };
	}

	async update(params: ClientParams<"webSearch/update">): Promise<ClientResult<"webSearch/get">> {
		this.settingsManager.setWebSearchEnabled(params.enabled);
		this.settingsManager.setWebSearchProvider(params.provider);
		await this.settingsManager.flush();
		const id = credentialId(params.provider);
		if (params.credential.action === "set") {
			this.authStorage.set(id, { type: "api_key", key: params.credential.value });
		} else if (params.credential.action === "remove") {
			this.authStorage.remove(id);
		}
		return this.view();
	}
}
