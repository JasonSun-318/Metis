import { getProviders } from "@arcmind/ai/compat";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts";
import {
	WEB_SEARCH_PROVIDER_INFO,
	WEB_SEARCH_PROVIDERS,
	webSearchCredentialId,
	webSearchProviderFromCredentialId,
} from "../../core/web-search-config.ts";
import { type AuthSelectorProvider, formatAuthSelectorProviderType } from "./components/oauth-selector.ts";

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());
const AUTH_TYPE_ORDER = { oauth: 0, api_key: 1 } satisfies Record<AuthSelectorProvider["authType"], number>;

export interface LoginProviderCompletionOption {
	id: string;
	name: string;
	authTypes: AuthSelectorProvider["authType"][];
}

export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) return true;
	if (builtInProviderIds.has(providerId)) return false;
	return !oauthProviderIds.has(providerId);
}

export function getWebSearchLoginProviderOptions(): AuthSelectorProvider[] {
	return WEB_SEARCH_PROVIDERS.map((provider) => ({
		id: webSearchCredentialId(provider),
		name: WEB_SEARCH_PROVIDER_INFO[provider].label,
		authType: "api_key" as const,
	})).sort((left, right) => left.name.localeCompare(right.name));
}

export function listLoginProviderOptions(
	modelRegistry: ModelRegistry,
	authType?: AuthSelectorProvider["authType"],
): AuthSelectorProvider[] {
	const oauthProviders = modelRegistry.authStorage.getOAuthProviders();
	const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
	const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
		id: provider.id,
		name: provider.name,
		authType: "oauth",
	}));
	const modelProviders = new Set(modelRegistry.getAll().map((model) => model.provider));
	for (const providerId of modelProviders) {
		if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) continue;
		options.push({
			id: providerId,
			name: modelRegistry.getProviderDisplayName(providerId),
			authType: "api_key",
		});
	}
	options.push(...getWebSearchLoginProviderOptions());
	return (authType ? options.filter((option) => option.authType === authType) : options).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

export function listLogoutProviderOptions(modelRegistry: ModelRegistry): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const providerId of modelRegistry.authStorage.list()) {
		const credential = modelRegistry.authStorage.get(providerId);
		if (!credential || credential.type === "mcp_oauth" || credential.type === "mcp_secret") continue;
		const searchProvider = webSearchProviderFromCredentialId(providerId);
		options.push({
			id: providerId,
			name: searchProvider
				? WEB_SEARCH_PROVIDER_INFO[searchProvider].label
				: modelRegistry.getProviderDisplayName(providerId),
			authType: credential.type,
		});
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

export function findLoginProviderOptions(modelRegistry: ModelRegistry, providerRef: string): AuthSelectorProvider[] {
	const normalized = providerRef.trim().toLowerCase();
	if (!normalized) return [];
	return listLoginProviderOptions(modelRegistry).filter(
		(provider) => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
	);
}

export function getLoginProviderCompletionOptions(
	providerOptions: readonly AuthSelectorProvider[],
): LoginProviderCompletionOption[] {
	const byId = new Map<string, LoginProviderCompletionOption>();
	for (const provider of providerOptions) {
		const existing = byId.get(provider.id);
		if (existing) {
			if (!existing.authTypes.includes(provider.authType)) {
				existing.authTypes.push(provider.authType);
				existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
			}
			continue;
		}
		byId.set(provider.id, { id: provider.id, name: provider.name, authTypes: [provider.authType] });
	}
	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getLoginProviderSearchText(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes
		.map((authType) => `${authType} ${formatAuthSelectorProviderType(authType)}`)
		.join(" ");
	return `${provider.id} ${provider.name} ${authTypes}`;
}

export function formatLoginProviderCompletionDescription(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes.map(formatAuthSelectorProviderType).join("/");
	return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}
