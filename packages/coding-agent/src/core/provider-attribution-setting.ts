import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isProviderAttributionEnabled(
	settingsManager: SettingsManager,
	envValue: string | undefined = process.env.ARCMIND_PROVIDER_ATTRIBUTION,
): boolean {
	return envValue !== undefined ? isTruthyEnvFlag(envValue) : settingsManager.getEnableProviderAttribution();
}
