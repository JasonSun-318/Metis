import type {
	DesktopDownloadControlType,
	DesktopDownloadItem,
	DesktopDownloadState,
} from "../../shared/desktop-api.ts";
import { formatBrowserBytes } from "../browser-display.ts";

export const DOWNLOAD_ACTION_LABELS: Readonly<Record<DesktopDownloadControlType, string>> = {
	cancel: "Cancel download",
	open: "Open file",
	pause: "Pause download",
	remove: "Remove from list",
	resume: "Resume download",
	retry: "Retry download",
	reveal: "Show in folder",
};

const DOWNLOAD_ACTIONS: Readonly<Record<DesktopDownloadState, readonly DesktopDownloadControlType[]>> = {
	cancelled: ["retry", "remove"],
	completed: ["open", "reveal", "remove"],
	interrupted: ["retry", "remove"],
	paused: ["resume", "cancel", "remove"],
	progressing: ["pause", "cancel", "remove"],
};

const DOWNLOAD_STATE_LABELS: Readonly<Record<DesktopDownloadState, string>> = {
	cancelled: "Cancelled",
	completed: "Completed",
	interrupted: "Download failed",
	paused: "Paused",
	progressing: "Downloading",
};

export interface BrowserDownloadPresentation {
	readonly actions: readonly DesktopDownloadControlType[];
	readonly percent: number | null;
	readonly showProgress: boolean;
	readonly showProgressPercent: boolean;
	readonly size: string;
	readonly stateLabel: string;
}

export function browserDownloadPresentation(
	download: Pick<DesktopDownloadItem, "state" | "receivedBytes" | "totalBytes">,
	t: (key: string) => string,
): BrowserDownloadPresentation {
	const percent =
		download.totalBytes > 0 ? Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100)) : null;
	const showProgress = download.state === "progressing" || download.state === "paused";
	return {
		actions: DOWNLOAD_ACTIONS[download.state],
		percent,
		showProgress,
		showProgressPercent: download.state === "progressing" && percent !== null,
		size:
			download.totalBytes > 0
				? `${formatBrowserBytes(download.receivedBytes)} / ${formatBrowserBytes(download.totalBytes)}`
				: formatBrowserBytes(download.receivedBytes),
		stateLabel: t(DOWNLOAD_STATE_LABELS[download.state]),
	};
}
