import type { ArcMindDesktopApi } from "../shared/desktop-api.ts";

declare global {
	interface Window {
		readonly arcMind: ArcMindDesktopApi;
	}
}
