import type { DesktopBrowserProfile, DesktopBrowserSourceId } from "../shared/desktop-api.ts";

const BROWSER_SOURCE_NAMES: Record<DesktopBrowserSourceId, string> = {
	chrome: "Google Chrome",
	edge: "Microsoft Edge",
	brave: "Brave",
	chromium: "Chromium",
};

export function browserProfileLabel(
	profile: Pick<DesktopBrowserProfile, "name" | "sourceId">,
	defaultProfile: string,
): string {
	return profile.sourceId
		? `${BROWSER_SOURCE_NAMES[profile.sourceId]} — ${profile.name}`
		: `Metis — ${defaultProfile}`;
}

export function formatBrowserBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"] as const;
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	const rounded = index === 0 ? value : value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${units[index]}`;
}
