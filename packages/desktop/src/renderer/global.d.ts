import type { MetisDesktopApi } from "../shared/desktop-api.ts";

declare global {
	interface Window {
		readonly metis: MetisDesktopApi;
	}
}
