import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { type AutoUpdaterAdapter, DesktopUpdater } from "../src/main/updater.ts";

class FakeAutoUpdater extends EventEmitter implements AutoUpdaterAdapter {
	feedUrls: string[] = [];
	checkCount = 0;
	quitCount = 0;
	checkError?: Error;

	setFeedURL(options: { url: string }): void {
		this.feedUrls.push(options.url);
	}

	checkForUpdates(): void {
		this.checkCount += 1;
		if (this.checkError) throw this.checkError;
	}

	quitAndInstall(): void {
		this.quitCount += 1;
	}
}

function harness(overrides: Partial<ConstructorParameters<typeof DesktopUpdater>[0]> = {}) {
	const autoUpdater = new FakeAutoUpdater();
	const confirmInstall = vi.fn(async () => true);
	const prepareToInstall = vi.fn(async () => undefined);
	const onDiagnostic = vi.fn();
	const updater = new DesktopUpdater({
		autoUpdater,
		feedUrl: "https://updates.example.test/arcmind",
		isPackaged: true,
		platform: "darwin",
		confirmInstall,
		prepareToInstall,
		onDiagnostic,
		...overrides,
	});
	return { autoUpdater, confirmInstall, onDiagnostic, prepareToInstall, updater };
}

describe("DesktopUpdater", () => {
	it("stays disabled outside packaged macOS and Windows apps", () => {
		for (const options of [
			{ isPackaged: false, platform: "darwin" as const },
			{ isPackaged: true, platform: "linux" as const },
		]) {
			const { autoUpdater, updater } = harness(options);
			expect(updater.start()).toBe(false);
			expect(autoUpdater.feedUrls).toEqual([]);
			expect(autoUpdater.checkCount).toBe(0);
		}
	});

	it("rejects update feeds that are not credential-free HTTPS URLs", () => {
		for (const feedUrl of ["http://updates.example.test", "https://token@updates.example.test", "not a URL"]) {
			const { autoUpdater, updater } = harness({ feedUrl });
			expect(updater.start()).toBe(false);
			expect(autoUpdater.checkCount).toBe(0);
		}
	});

	it("checks a trusted feed without allowing failures to affect the app server", () => {
		const { autoUpdater, onDiagnostic, prepareToInstall, updater } = harness();
		autoUpdater.checkError = new Error("offline");

		expect(updater.start()).toBe(true);
		expect(autoUpdater.feedUrls).toEqual(["https://updates.example.test/arcmind"]);
		expect(autoUpdater.checkCount).toBe(1);
		expect(prepareToInstall).not.toHaveBeenCalled();
		expect(onDiagnostic).toHaveBeenCalledWith("Update check failed");
	});

	it("keeps a downloaded update inert when the user declines it", async () => {
		const confirmInstall = vi.fn(async () => false);
		const { autoUpdater, prepareToInstall, updater } = harness({ confirmInstall });
		updater.start();

		autoUpdater.emit("update-downloaded");
		await vi.waitFor(() => expect(confirmInstall).toHaveBeenCalledOnce());
		expect(prepareToInstall).not.toHaveBeenCalled();
		expect(autoUpdater.quitCount).toBe(0);
	});

	it("stops mutations and the app server before installing an approved update", async () => {
		let finishPreparation: (() => void) | undefined;
		const prepareToInstall = vi.fn(
			async () =>
				await new Promise<void>((resolve) => {
					finishPreparation = resolve;
				}),
		);
		const { autoUpdater, updater } = harness({ prepareToInstall });
		updater.start();

		autoUpdater.emit("update-downloaded");
		await vi.waitFor(() => expect(prepareToInstall).toHaveBeenCalledOnce());
		expect(autoUpdater.quitCount).toBe(0);
		finishPreparation?.();
		await vi.waitFor(() => expect(autoUpdater.quitCount).toBe(1));
	});

	it("does not install when graceful preparation fails", async () => {
		const prepareToInstall = vi.fn(async () => {
			throw new Error("could not stop app server");
		});
		const { autoUpdater, onDiagnostic, updater } = harness({ prepareToInstall });
		updater.start();

		autoUpdater.emit("update-downloaded");
		await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledWith("Update installation preparation failed"));
		expect(autoUpdater.quitCount).toBe(0);
	});
});
