// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { Folder, FolderOpen, type Icon } from "@phosphor-icons/react";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "../src/renderer/components/BrowserPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type {
	DesktopBrowserEvent,
	DesktopBrowserState,
	DesktopDownloadControlType,
	DesktopDownloadItem,
	DesktopDownloadState,
	MetisDesktopApi,
} from "../src/shared/desktop-api.ts";
import { DEFAULT_BROWSER_PROFILE_ID } from "../src/shared/desktop-api.ts";

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

function downloadRow(container: ParentNode, filename: string): HTMLElement {
	const match = [...container.querySelectorAll<HTMLElement>(".browser-download-row")].find(
		(candidate) => candidate.querySelector(".browser-download-name")?.textContent === filename,
	);
	if (!match) throw new Error(`Missing download row: ${filename}`);
	return match;
}

function actionLabels(row: ParentNode): string[] {
	return [...row.querySelectorAll<HTMLButtonElement>(".browser-download-actions button")].map(
		(candidate) => candidate.getAttribute("aria-label") ?? "",
	);
}

function iconPaths(svg: SVGSVGElement): string[] {
	return [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
}

function renderedIconPaths(IconComponent: Icon): string[] {
	const template = document.createElement("template");
	template.innerHTML = renderToStaticMarkup(<IconComponent aria-hidden="true" size={12} />);
	return [...template.content.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

function renderPanel(api: MetisDesktopApi, onError: (cause: unknown) => void = vi.fn()) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	void act(() =>
		root.render(
			<StrictMode>
				<BrowserPanel
					api={api}
					sessionId="11111111-1111-4111-8111-111111111111"
					browserId="browser-1"
					controlState="idle"
					onError={onError}
					onProfileImported={vi.fn()}
					onState={vi.fn()}
					profile={{ profileId: DEFAULT_BROWSER_PROFILE_ID, name: "Default" }}
					visible
				/>
			</StrictMode>,
		),
	);
	roots.push(root);
	return { container };
}

function browserPanelApi(
	overrides: {
		controlBrowserDownload?: MetisDesktopApi["controlBrowserDownload"];
		downloads?: readonly DesktopDownloadItem[];
	} = {},
): { api: MetisDesktopApi; emitBrowserEvent: (event: DesktopBrowserEvent) => void } {
	let listener: ((event: DesktopBrowserEvent) => void) | undefined;
	const state: DesktopBrowserState = {
		browserId: "browser-1",
		profileId: DEFAULT_BROWSER_PROFILE_ID,
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
		listBrowserHistory: vi.fn().mockResolvedValue([]),
		clearBrowserHistory: vi.fn().mockResolvedValue(undefined),
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
	it("uses a blue reduced-motion-aware active indicator", () => {
		const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");
		expect(css).toMatch(/\.browser-download-badge\s*\{[^}]*background:\s*var\(--link\)/u);
		expect(css).toMatch(/\.browser-download-badge\s*\{[^}]*animation:\s*session-running-pulse/u);
		expect(css).toMatch(
			/prefers-reduced-motion:\s*reduce[\s\S]*\.browser-download-badge\s*\{[^}]*animation:\s*none/u,
		);
	});

	it("lists downloads with per-state actions and forwards controls", async () => {
		const controlBrowserDownload = vi.fn().mockResolvedValue(undefined);
		const { api } = browserPanelApi({
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

	it("renders every state with fixed action order, menuitems and 12px icons", async () => {
		const cases: readonly {
			readonly actions: readonly string[];
			readonly label: string;
			readonly state: DesktopDownloadState;
		}[] = [
			{
				actions: ["Pause download", "Cancel download", "Remove from list"],
				label: "Downloading",
				state: "progressing",
			},
			{ actions: ["Resume download", "Cancel download", "Remove from list"], label: "Paused", state: "paused" },
			{ actions: ["Open file", "Show in folder", "Remove from list"], label: "Completed", state: "completed" },
			{ actions: ["Retry download", "Remove from list"], label: "Cancelled", state: "cancelled" },
			{ actions: ["Retry download", "Remove from list"], label: "Download failed", state: "interrupted" },
		];
		const actionTypes: Readonly<Record<string, DesktopDownloadControlType>> = {
			"Pause download": "pause",
			"Resume download": "resume",
			"Cancel download": "cancel",
			"Open file": "open",
			"Show in folder": "reveal",
			"Retry download": "retry",
			"Remove from list": "remove",
		};
		const controlBrowserDownload = vi.fn().mockResolvedValue(undefined);
		const { api } = browserPanelApi({
			controlBrowserDownload,
			downloads: cases.map((item) =>
				download({ downloadId: `d-${item.state}`, filename: `${item.state}.zip`, state: item.state }),
			),
		});
		const { container } = renderPanel(api);
		await flush();
		await act(async () => button(container, "Downloads")!.click());
		await flush();

		for (const expected of cases) {
			const element = downloadRow(container, `${expected.state}.zip`);
			expect(element.tagName).toBe("DIV");
			expect(element.getAttribute("data-download-state")).toBe(expected.state);
			const name = element.querySelector(".browser-download-name");
			expect(name?.textContent).toBe(`${expected.state}.zip`);
			expect(name?.getAttribute("title")).toBe(`${expected.state}.zip`);
			expect(element.querySelector(".browser-download-meta")?.textContent).toContain(expected.label);
			expect(actionLabels(element)).toEqual(expected.actions);

			const main = element.querySelector(".browser-download-main");
			expect(main?.parentElement).toBe(element);
			expect(main?.querySelector(".browser-download-info > .browser-download-name")).toBe(name);
			for (const action of element.querySelectorAll<HTMLButtonElement>(".browser-download-actions button")) {
				expect(action.getAttribute("role")).toBe("menuitem");
				expect(action.getAttribute("type")).toBe("button");
				const svg = action.querySelector("svg");
				expect(svg?.getAttribute("width")).toBe("12");
				expect(svg?.getAttribute("height")).toBe("12");
			}

			const progress = element.querySelector<HTMLElement>(".browser-download-progress");
			if (expected.state === "progressing" || expected.state === "paused") {
				expect(progress).not.toBeNull();
				expect(progress?.parentElement).toBe(element);
				expect(progress?.querySelector("i")?.style.width).toBe("25%");
			} else {
				expect(progress).toBeNull();
			}
		}

		const reveal = downloadRow(container, "completed.zip").querySelector<HTMLButtonElement>(
			'button[aria-label="Show in folder"]',
		);
		expect(iconPaths(reveal!.querySelector("svg")!)).toEqual(renderedIconPaths(Folder));
		expect(iconPaths(reveal!.querySelector("svg")!)).not.toEqual(renderedIconPaths(FolderOpen));

		let expectedCalls = 0;
		for (const expected of cases) {
			const element = downloadRow(container, `${expected.state}.zip`);
			for (const label of expected.actions) {
				const action = [...element.querySelectorAll<HTMLButtonElement>(".browser-download-actions button")].find(
					(candidate) => candidate.getAttribute("aria-label") === label,
				);
				expect(action).toBeDefined();
				await act(async () => action!.click());
				expectedCalls += 1;
				expect(controlBrowserDownload).toHaveBeenNthCalledWith(expectedCalls, {
					type: actionTypes[label],
					downloadId: `d-${expected.state}`,
				});
			}
		}
	});

	it("formats known, unknown and clamped totals", async () => {
		const { api } = browserPanelApi({
			downloads: [
				download({ downloadId: "d-known", filename: "known.zip", receivedBytes: 250, totalBytes: 1_000 }),
				download({ downloadId: "d-unknown", filename: "unknown.zip", receivedBytes: 750, totalBytes: 0 }),
				download({ downloadId: "d-over", filename: "over.zip", receivedBytes: 2_500, totalBytes: 1_000 }),
			],
		});
		const { container } = renderPanel(api);
		await flush();
		await act(async () => button(container, "Downloads")!.click());
		await flush();

		const meta = (filename: string) =>
			downloadRow(container, filename).querySelector(".browser-download-meta")?.textContent;
		const progressWidth = (filename: string) =>
			downloadRow(container, filename).querySelector<HTMLElement>(".browser-download-progress i")?.style.width;

		expect(meta("known.zip")).toBe("250 B / 1000 B · Downloading · 25%");
		expect(meta("unknown.zip")).toBe("750 B · Downloading");
		expect(meta("over.zip")).toBe("2.4 KB / 1000 B · Downloading · 100%");
		expect(progressWidth("unknown.zip")).toBe("0%");
		expect(progressWidth("over.zip")).toBe("100%");
	});

	it("translates download states and actions for the active locale", async () => {
		await setLocale("zh-CN");
		const { api } = browserPanelApi({ downloads: [download({ downloadId: "d-zh", filename: "zh.zip" })] });
		const { container } = renderPanel(api);
		await flush();
		await act(async () => button(container, "下载")!.click());
		await flush();

		const element = downloadRow(container, "zh.zip");
		expect(element.querySelector(".browser-download-meta")?.textContent).toContain("下载中");
		expect(actionLabels(element)).toEqual(["暂停下载", "取消下载", "从列表中移除"]);
	});

	it("reports control failures without closing the menu", async () => {
		const onError = vi.fn();
		const controlBrowserDownload = vi.fn().mockRejectedValueOnce(new Error("control failed"));
		const { api } = browserPanelApi({
			controlBrowserDownload,
			downloads: [download({ downloadId: "d-active" })],
		});
		const { container } = renderPanel(api, onError);
		await flush();
		await act(async () => button(container, "Downloads")!.click());
		await flush();
		await act(async () => button(container, "Pause download")!.click());
		await flush();

		expect(controlBrowserDownload).toHaveBeenCalledWith({ type: "pause", downloadId: "d-active" });
		expect(onError).toHaveBeenCalledOnce();
		expect(container.textContent).toContain("Browser action failed");
		expect(downloadRow(container, "report.pdf")).toBeDefined();
	});
});
