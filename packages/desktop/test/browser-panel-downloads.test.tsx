// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "../src/renderer/components/BrowserPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type {
	DesktopBrowserEvent,
	DesktopBrowserState,
	DesktopDownloadItem,
	MetisDesktopApi,
} from "../src/shared/desktop-api.ts";

let roots: Root[] = [];

function download(overrides: Partial<DesktopDownloadItem> & { downloadId: string }): DesktopDownloadItem {
	return {
		url: "https://example.com/files/report.pdf",
		filename: "report.pdf",
		savePath: `/tmp/metis-downloads/${overrides.downloadId}-report.pdf`,
		state: "progressing",
		receivedBytes: 250,
		totalBytes: 1_000,
		startedAt: 1,
		...overrides,
	};
}

function button(container: ParentNode, label: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

function renderPanel(api: MetisDesktopApi) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	void act(() =>
		root.render(
			<StrictMode>
				<BrowserPanel api={api} browserId="browser-1" onError={vi.fn()} onState={vi.fn()} visible />
			</StrictMode>,
		),
	);
	roots.push(root);
	return { container };
}

function browserPanelApi(overrides: {
	controlBrowserDownload?: MetisDesktopApi["controlBrowserDownload"];
	downloads?: readonly DesktopDownloadItem[];
} = {}): { api: MetisDesktopApi; emitBrowserEvent: (event: DesktopBrowserEvent) => void } {
	let listener: ((event: DesktopBrowserEvent) => void) | undefined;
	const state: DesktopBrowserState = {
		browserId: "browser-1",
		url: "",
		title: "New tab",
		faviconUrl: null,
		loading: false,
		canGoBack: false,
		canGoForward: false,
		zoomPercent: 100,
	};
	const api = {
		createBrowser: vi.fn().mockResolvedValue(state),
		captureBrowserPreview: vi.fn().mockResolvedValue("data:image/png;base64,cHJldmlldw=="),
		controlBrowser: vi.fn().mockResolvedValue(undefined),
		closeBrowser: vi.fn().mockResolvedValue(undefined),
		listBrowserDownloads: vi.fn().mockResolvedValue(overrides.downloads ?? []),
		controlBrowserDownload: overrides.controlBrowserDownload ?? vi.fn().mockResolvedValue(undefined),
		subscribeBrowser: (incoming: (event: DesktopBrowserEvent) => void) => {
			listener = incoming;
			return () => undefined;
		},
	} as unknown as MetisDesktopApi;
	return { api, emitBrowserEvent: (event) => listener?.(event) };
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("BrowserPanel downloads", () => {
	it("lists downloads with per-state actions and forwards controls", async () => {
		const controlBrowserDownload = vi.fn().mockResolvedValue(undefined);
		const { api, emitBrowserEvent } = browserPanelApi({
			controlBrowserDownload,
			downloads: [
				download({ downloadId: "d-active" }),
				download({ downloadId: "d-done", state: "completed", receivedBytes: 1_000 }),
			],
		});
		const { container } = renderPanel(api);
		await flush();

		await act(async () => button(container, "Downloads")!.click());
		await flush();

		expect(container.textContent).toContain("report.pdf");
		expect(button(container, "Pause download")).toBeDefined();
		expect(button(container, "Cancel download")).toBeDefined();
		expect(button(container, "Open file")).toBeDefined();
		expect(button(container, "Show in folder")).toBeDefined();
		expect(button(container, "Remove from list")).toBeDefined();

		await act(async () => button(container, "Pause download")!.click());
		expect(controlBrowserDownload).toHaveBeenCalledWith({ type: "pause", downloadId: "d-active" });
		await act(async () => button(container, "Open file")!.click());
		expect(controlBrowserDownload).toHaveBeenCalledWith({ type: "open", downloadId: "d-done" });

		const completedRow = button(container, "Open file")!.closest(".browser-download-row")!;
		const completedRemove = [...completedRow.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) => candidate.getAttribute("aria-label") === "Remove from list",
		)!;
		await act(async () => completedRemove.click());
		expect(controlBrowserDownload).toHaveBeenCalledWith({ type: "remove", downloadId: "d-done" });
	});

	it("updates the list from browser events and shows paused controls", async () => {
		const { api, emitBrowserEvent } = browserPanelApi();
		const { container } = renderPanel(api);
		await flush();

		await act(async () => {
			emitBrowserEvent({
				type: "downloads",
				downloads: [download({ downloadId: "d-paused", state: "paused", receivedBytes: 400 })],
			});
		});

		await act(async () => button(container, "Downloads")!.click());
		await flush();

		expect(container.textContent).toContain("400 B / 1000 B");
		expect(container.textContent).toContain("Paused");
		expect(button(container, "Resume download")).toBeDefined();

		await act(async () => button(container, "Resume download")!.click());
		expect(api.controlBrowserDownload).toHaveBeenCalledWith({ type: "resume", downloadId: "d-paused" });
	});

	it("shows an empty list placeholder when nothing was downloaded", async () => {
		const { api } = browserPanelApi();
		const { container } = renderPanel(api);
		await flush();

		await act(async () => button(container, "Downloads")!.click());
		await flush();

		expect(container.textContent).toContain("No downloads yet");
	});
});
