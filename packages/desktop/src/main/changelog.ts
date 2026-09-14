import { type DesktopChangelog, validateDesktopChangelog } from "../shared/desktop-api.ts";

export interface DesktopChangelogLoaderOptions {
	readonly baseUrl?: string | null;
	readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

function trustedBaseUrl(value: string | null | undefined): URL | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
		url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
		return url;
	} catch {
		return undefined;
	}
}

/** Loads the public release history without invoking or depending on the updater. */
export async function loadDesktopChangelog(options: DesktopChangelogLoaderOptions): Promise<DesktopChangelog> {
	const baseUrl = trustedBaseUrl(options.baseUrl);
	if (!baseUrl) throw new Error("Release notes are unavailable in this build");
	const response = await options.fetch(new URL("changelog.json", baseUrl).href, {
		cache: "no-store",
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 404) return { schemaVersion: 1, releases: [] };
	if (!response.ok) throw new Error(`Changelog request failed with ${response.status}`);
	return validateDesktopChangelog(await response.json());
}
