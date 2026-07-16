export interface AutoUpdaterAdapter {
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "update-downloaded", listener: () => void): this;
	off(event: "error", listener: (error: Error) => void): this;
	off(event: "update-downloaded", listener: () => void): this;
	setFeedURL(options: { url: string }): void;
	checkForUpdates(): void;
	quitAndInstall(): void;
}

export interface DesktopUpdaterOptions {
	readonly autoUpdater: AutoUpdaterAdapter;
	readonly feedUrl?: string | null;
	readonly isPackaged: boolean;
	readonly platform: NodeJS.Platform;
	readonly confirmInstall: () => Promise<boolean>;
	readonly prepareToInstall: () => Promise<void>;
	readonly onDiagnostic?: (message: string) => void;
}

function trustedFeedUrl(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

/** User-approved, graceful update installation for packaged macOS and Windows apps. */
export class DesktopUpdater {
	private readonly options: DesktopUpdaterOptions;
	private started = false;
	private installing = false;

	constructor(options: DesktopUpdaterOptions) {
		this.options = options;
	}

	start(): boolean {
		if (this.started) return true;
		if (!this.options.isPackaged || !["darwin", "win32"].includes(this.options.platform)) return false;
		const feedUrl = trustedFeedUrl(this.options.feedUrl);
		if (!feedUrl) return false;

		try {
			this.options.autoUpdater.setFeedURL({ url: feedUrl });
		} catch {
			this.options.onDiagnostic?.("Update feed configuration failed");
			return false;
		}
		this.options.autoUpdater.on("error", this.onError);
		this.options.autoUpdater.on("update-downloaded", this.onUpdateDownloaded);
		this.started = true;
		this.checkForUpdates();
		return true;
	}

	checkForUpdates(): void {
		if (!this.started) return;
		try {
			this.options.autoUpdater.checkForUpdates();
		} catch {
			this.options.onDiagnostic?.("Update check failed");
		}
	}

	dispose(): void {
		if (!this.started) return;
		this.options.autoUpdater.off("error", this.onError);
		this.options.autoUpdater.off("update-downloaded", this.onUpdateDownloaded);
		this.started = false;
	}

	private readonly onError = (): void => {
		// Update failures are diagnostic-only and must not interrupt agent work.
		this.options.onDiagnostic?.("Update check failed");
	};

	private readonly onUpdateDownloaded = (): void => {
		void this.installDownloadedUpdate();
	};

	private async installDownloadedUpdate(): Promise<void> {
		if (this.installing) return;
		this.installing = true;
		try {
			if (!(await this.options.confirmInstall())) return;
			await this.options.prepareToInstall();
			this.options.autoUpdater.quitAndInstall();
		} catch {
			this.options.onDiagnostic?.("Update installation preparation failed");
		} finally {
			this.installing = false;
		}
	}
}
