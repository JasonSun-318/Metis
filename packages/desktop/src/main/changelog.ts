import { type DesktopChangelog, validateDesktopChangelog } from "../shared/desktop-api.ts";
import { trustedBaseUrl } from "./trusted-base-url.ts";

export interface DesktopChangelogLoaderOptions {
	readonly baseUrl?: string | null;
	readonly platform: NodeJS.Platform;
	readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Loads the public release history without invoking or depending on the updater. */
export async function loadDesktopChangelog(options: DesktopChangelogLoaderOptions): Promise<DesktopChangelog> {
	const baseUrl = trustedBaseUrl(options.baseUrl);
	if (!baseUrl || (options.platform !== "darwin" && options.platform !== "win32")) {
		throw new Error("Release notes are unavailable in this build");
	}
	const response = await options.fetch(new URL(`${options.platform}/changelog.json`, baseUrl).href, {
		cache: "no-store",
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 404) return { schemaVersion: 1, releases: [] };
	if (!response.ok) throw new Error(`Changelog request failed with ${response.status}`);
	return validateDesktopChangelog(await response.json());
}
