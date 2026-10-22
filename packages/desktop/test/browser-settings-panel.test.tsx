// @vitest-environment jsdom

import { Folder, FolderOpen, type Icon } from "@phosphor-icons/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSettingsPanel } from "../src/renderer/components/BrowserSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserEvent,
	type DesktopDownloadControlType,
	type DesktopDownloadItem,
	type DesktopDownloadState,
	type DesktopHistoryEntry,
	type MetisDesktopApi,
} from "../src/shared/desktop-api.ts";

let roots: Root[] = [];

const chromeProfileId = "20000000-0000-4000-8000-000000000001";
const profiles = [
	{ profileId: DEFAULT_BROWSER_PROFILE_ID, name: "Default", sourceId: null, sourceProfileId: null },
	{ profileId: chromeProfileId, name: "Personal", sourceId: "chrome" as const, sourceProfileId: "Default" },
];

function historyEntry(overrides: Partial<DesktopHistoryEntry> & { entryId: string }): DesktopHistoryEntry {
	return {
		url: "https://example.com/docs",
		title: "Example docs",
		faviconUrl: null,
		visitedAt: new Date(2026, 7, 30, 9, 30).getTime(),
		...overrides,
	};
}

function download(overrides: Partial<DesktopDownloadItem> & { downloadId: string }): DesktopDownloadItem {
	return {
		url: "https://example.com/report.pdf",
		filename: "report.pdf",
		savePath: "/Users/test/Downloads/report.pdf",
		state: "completed",
		receivedBytes: 1_000,
		totalBytes: 1_000,
		startedAt: new Date(2026, 7, 30, 9, 0).getTime(),
		...overrides,
	};
}

function fixture(
	overrides: {
		history?: Readonly<Record<string, readonly DesktopHistoryEntry[]>>;
		downloads?: readonly DesktopDownloadItem[];
		platform?: "darwin" | "win32";
	} = {},
) {
	let listener: ((event: DesktopBrowserEvent) => void) | undefined;
	const history = overrides.history ?? {
		[DEFAULT_BROWSER_PROFILE_ID]: [
			historyEntry({ entryId: "metis-history", title: "Metis docs" }),
			historyEntry({
				entryId: "older-history",
				title: "Yesterday archive",
				visitedAt: new Date(2026, 7, 29, 8, 0).getTime(),
			}),
		],
		[chromeProfileId]: [historyEntry({ entryId: "chrome-history", title: "Chrome profile docs" })],
	};
	const api = {
		platform: overrides.platform ?? "darwin",
		getBrowserDownloadDirectory: vi.fn().mockResolvedValue("/Users/test/Downloads"),
		openBrowserDownloadDirectory: vi.fn().mockResolvedValue(undefined),
		listBrowserProfiles: vi.fn().mockResolvedValue(profiles),
		listBrowserHistory: vi.fn(({ profileId }: { profileId: string }) => Promise.resolve(history[profileId] ?? [])),
		clearBrowserHistory: vi.fn().mockResolvedValue(undefined),
		listBrowserDownloads: vi.fn().mockResolvedValue(overrides.downloads ?? [download({ downloadId: "done" })]),
		controlBrowserDownload: vi.fn().mockResolvedValue(undefined),
		listBrowserImportSources: vi.fn().mockResolvedValue([]),
		importBrowserData: vi.fn(),
		subscribeBrowser: (next: (event: DesktopBrowserEvent) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as MetisDesktopApi;
	return { api, emit: (event: DesktopBrowserEvent) => listener?.(event) };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function downloadRow(container: ParentNode, filename: string): HTMLElement {
	const match = [...container.querySelectorAll<HTMLElement>(".browser-settings-download")].find(
		(candidate) => candidate.querySelector("strong")?.textContent === filename,
	);
	if (!match) throw new Error(`Missing download row: ${filename}`);
	return match;
}

function actionLabels(row: ParentNode): string[] {
	return [...row.querySelectorAll<HTMLButtonElement>(".browser-settings-download-actions button")].map(
		(candidate) => candidate.getAttribute("aria-label") ?? "",
	);
}

function iconPaths(svg: SVGSVGElement): string[] {
	return [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
}

function renderedIconPaths(IconComponent: Icon): string[] {
	const template = document.createElement("template");
	template.innerHTML = renderToStaticMarkup(<IconComponent aria-hidden="true" size={14} />);
	return [...template.content.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
}

function setValue(input: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function renderPanel(api: MetisDesktopApi) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(<BrowserSettingsPanel api={api} />));
	roots.push(root);
	return container;
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	if (!HTMLDialogElement.prototype.showModal) {
		HTMLDialogElement.prototype.showModal = function showModal() {
			this.setAttribute("open", "");
		};
	}
	if (!HTMLDialogElement.prototype.close) {
		HTMLDialogElement.prototype.close = function close() {
			this.removeAttribute("open");
		};
	}
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("BrowserSettingsPanel", () => {
	it("loads the truthful overview and opens existing capabilities", async () => {
		const { api } = fixture();
		const container = renderPanel(api);
		await flush();

		expect(container.textContent).toContain("Browser data");
		expect(container.textContent).toContain("System Downloads folder");
		expect(container.textContent).toContain("/Users/test/Downloads");
		expect(container.textContent).toContain("Current-run downloads");
		expect(container.textContent).not.toMatch(/password|autofill|CDP/iu);
		expect(api.listBrowserProfiles).toHaveBeenCalledOnce();
		expect(api.listBrowserHistory).toHaveBeenCalledWith({ profileId: DEFAULT_BROWSER_PROFILE_ID });

		await act(async () => button(container, "Open Downloads folder").click());
		expect(api.openBrowserDownloadDirectory).toHaveBeenCalledOnce();
		await act(async () => button(container, "Import browser data").click());
		expect(document.body.textContent).toContain("Import from browser");
	});

	it("describes Windows import as history-only", async () => {
		const { api } = fixture({ platform: "win32" });
		const container = renderPanel(api);
		await flush();
		expect(container.textContent).toContain("Import browsing history from a supported Chromium profile.");
		expect(container.textContent).not.toContain("Import Cookies and browsing history");
	});

	it("refreshes profiles and selects the imported profile after a successful import", async () => {
		const importedProfileId = "20000000-0000-4000-8000-000000000099";
		const importedProfile = {
			profileId: importedProfileId,
			name: "Work",
			sourceId: "chrome" as const,
			sourceProfileId: "Profile 2",
		};
		const { api } = fixture({ history: { [DEFAULT_BROWSER_PROFILE_ID]: [], [importedProfileId]: [] } });
		vi.mocked(api.listBrowserProfiles)
			.mockResolvedValueOnce(profiles)
			.mockResolvedValueOnce([...profiles, importedProfile]);
		vi.mocked(api.listBrowserImportSources).mockResolvedValueOnce([
			{
				sourceId: "chrome",
				name: "Google Chrome",
				running: false,
				profiles: [{ sourceProfileId: "Profile 2", name: "Work", email: "work@example.com" }],
			},
		]);
		vi.mocked(api.importBrowserData).mockResolvedValueOnce({
			profile: importedProfile,
			cookies: { imported: 12, skipped: 0 },
			history: { accepted: 4, retained: 4 },
		});
		const container = renderPanel(api);
		await flush();

		await act(async () => button(container, "Import browser data").click());
		await flush();
		await act(async () => button(document.body, "Import").click());
		await flush();
		await flush();

		expect(api.importBrowserData).toHaveBeenCalledWith({
			sourceId: "chrome",
			sourceProfileId: "Profile 2",
			dataTypes: { cookies: true, history: true },
		});
		expect(api.listBrowserProfiles).toHaveBeenCalledTimes(2);
		expect(api.listBrowserHistory).toHaveBeenLastCalledWith({ profileId: importedProfileId });
		expect(container.textContent).toContain("12 Cookies imported · 4 history entries retained");
	});

	it("searches profile-scoped history and confirms before clearing", async () => {
		const { api } = fixture();
		const container = renderPanel(api);
		await flush();
		await act(async () => button(container, "Manage browsing history").click());
		await flush();

		expect(container.textContent).toContain("Metis docs");
		expect(container.textContent).not.toContain("Yesterday archive");
		await act(async () =>
			container.querySelectorAll<HTMLButtonElement>(".browser-settings-history-group h3 button")[1]!.click(),
		);
		expect(container.textContent).toContain("Yesterday archive");
		await act(async () => button(container, "Browser profile").click());
		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((candidate) => candidate.textContent?.includes("Google Chrome — Personal"))!
				.click();
		});
		await flush();
		expect(api.listBrowserHistory).toHaveBeenLastCalledWith({ profileId: chromeProfileId });
		expect(container.textContent).toContain("Chrome profile docs");

		await act(async () =>
			setValue(container.querySelector<HTMLInputElement>('input[aria-label="Search browsing history"]')!, "missing"),
		);
		expect(container.textContent).toContain("No matching history");
		await act(async () =>
			setValue(container.querySelector<HTMLInputElement>('input[aria-label="Search browsing history"]')!, "Chrome"),
		);
		expect(container.textContent).toContain("Chrome profile docs");

		await act(async () => button(container, "Clear browsing history").click());
		expect(api.clearBrowserHistory).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Clear browsing history?");
		await act(async () => button(document.body, "Confirm clear browsing history").click());
		await flush();
		expect(api.clearBrowserHistory).toHaveBeenCalledWith({ profileId: chromeProfileId });
	});

	it("manages current-run downloads and follows live events", async () => {
		const { api, emit } = fixture();
		const container = renderPanel(api);
		await flush();
		await act(async () => button(container, "Manage downloads").click());
		expect(container.textContent).toContain("report.pdf");
		await act(async () => button(container, "Open file").click());
		expect(api.controlBrowserDownload).toHaveBeenCalledWith({ type: "open", downloadId: "done" });

		await act(async () =>
			emit({
				type: "downloads",
				downloads: [
					download({ downloadId: "paused", filename: "archive.zip", state: "paused", receivedBytes: 500 }),
				],
			}),
		);
		expect(container.textContent).toContain("archive.zip");
		await act(async () => button(container, "Resume download").click());
		expect(api.controlBrowserDownload).toHaveBeenCalledWith({ type: "resume", downloadId: "paused" });

		await act(async () =>
			emit({
				type: "downloads",
				downloads: [
					download({ downloadId: "active", filename: "active.zip", state: "progressing", receivedBytes: 250 }),
				],
			}),
		);
		expect(button(container, "Pause download")).toBeDefined();
		await act(async () => button(container, "Cancel download").click());
		expect(api.controlBrowserDownload).toHaveBeenCalledWith({ type: "cancel", downloadId: "active" });

		await act(async () =>
			emit({
				type: "downloads",
				downloads: [
					download({ downloadId: "failed", filename: "failed.zip", state: "interrupted", receivedBytes: 250 }),
				],
			}),
		);
		await act(async () => button(container, "Retry download").click());
		expect(api.controlBrowserDownload).toHaveBeenCalledWith({ type: "retry", downloadId: "failed" });
	});

	it("keeps errors and empty states usable", async () => {
		const { api } = fixture({ history: {}, downloads: [] });
		vi.mocked(api.getBrowserDownloadDirectory).mockRejectedValueOnce(new Error("directory unavailable"));
		const container = renderPanel(api);
		await flush();
		expect(container.textContent).toContain("Browser settings could not be loaded");
		await act(async () => button(container, "Manage downloads").click());
		expect(container.textContent).toContain("No downloads in this run");
	});

	it("renders every state without menuitem, with 14px icons and FolderOpen reveal", async () => {
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
		const { api } = fixture({
			downloads: cases.map((item) =>
				download({
					downloadId: `d-${item.state}`,
					filename: `${item.state}.zip`,
					receivedBytes: 250,
					state: item.state,
				}),
			),
		});
		const container = renderPanel(api);
		await flush();
		await act(async () => button(container, "Manage downloads").click());
		await flush();

		for (const expected of cases) {
			const element = downloadRow(container, `${expected.state}.zip`);
			expect(element.tagName).toBe("LI");
			expect(element.getAttribute("data-download-state")).toBe(expected.state);
			const name = element.querySelector(".browser-settings-download-copy strong");
			expect(name?.textContent).toBe(`${expected.state}.zip`);
			expect(name?.getAttribute("title")).toBe(`${expected.state}.zip`);
			const copy = element.querySelector(".browser-settings-download-copy");
			expect(copy?.parentElement).toBe(element);
			expect(copy?.querySelector("span")?.textContent).toContain(expected.label);
			expect(actionLabels(element)).toEqual(expected.actions);

			for (const action of element.querySelectorAll<HTMLButtonElement>(
				".browser-settings-download-actions button",
			)) {
				expect(action.getAttribute("role")).toBeNull();
				expect(action.getAttribute("type")).toBe("button");
				const svg = action.querySelector("svg");
				expect(svg?.getAttribute("width")).toBe("14");
				expect(svg?.getAttribute("height")).toBe("14");
			}

			const progress = element.querySelector<HTMLElement>(".browser-settings-download-progress");
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
		expect(iconPaths(reveal!.querySelector("svg")!)).toEqual(renderedIconPaths(FolderOpen));
		expect(iconPaths(reveal!.querySelector("svg")!)).not.toEqual(renderedIconPaths(Folder));

		for (const expected of cases) {
			const element = downloadRow(container, `${expected.state}.zip`);
			for (const label of expected.actions) {
				const action = [
					...element.querySelectorAll<HTMLButtonElement>(".browser-settings-download-actions button"),
				].find((candidate) => candidate.getAttribute("aria-label") === label);
				expect(action).toBeDefined();
				await act(async () => action!.click());
				await flush();
				expect(api.controlBrowserDownload).toHaveBeenLastCalledWith({
					type: actionTypes[label],
					downloadId: `d-${expected.state}`,
				});
			}
		}
	});

	it("formats known, unknown and clamped totals", async () => {
		const { api } = fixture({
			downloads: [
				download({ downloadId: "known", filename: "known.zip", receivedBytes: 250, state: "progressing" }),
				download({
					downloadId: "unknown",
					filename: "unknown.zip",
					receivedBytes: 750,
					state: "progressing",
					totalBytes: 0,
				}),
				download({
					downloadId: "over",
					filename: "over.zip",
					receivedBytes: 2_500,
					state: "progressing",
				}),
			],
		});
		const container = renderPanel(api);
		await flush();
		await act(async () => button(container, "Manage downloads").click());
		await flush();

		const meta = (filename: string) =>
			downloadRow(container, filename).querySelector(".browser-settings-download-copy span")?.textContent;
		const progressWidth = (filename: string) =>
			downloadRow(container, filename).querySelector<HTMLElement>(".browser-settings-download-progress i")?.style
				.width;

		expect(meta("known.zip")).toBe("250 B / 1000 B · Downloading · 25%");
		expect(meta("unknown.zip")).toBe("750 B · Downloading");
		expect(meta("over.zip")).toBe("2.4 KB / 1000 B · Downloading · 100%");
		expect(progressWidth("unknown.zip")).toBe("0%");
		expect(progressWidth("over.zip")).toBe("100%");
	});

	it("translates download states and actions for the active locale", async () => {
		await setLocale("zh-CN");
		const { api } = fixture({
			downloads: [download({ downloadId: "zh", filename: "zh.zip", state: "progressing", receivedBytes: 250 })],
		});
		const container = renderPanel(api);
		await flush();
		await act(async () => button(container, "管理下载").click());
		await flush();

		const element = downloadRow(container, "zh.zip");
		expect(element.querySelector(".browser-settings-download-copy span")?.textContent).toContain("下载中");
		expect(actionLabels(element)).toEqual(["暂停下载", "取消下载", "从列表中移除"]);
	});

	it("refreshes after a successful control and reports failures without refreshing", async () => {
		const { api } = fixture({
			downloads: [
				download({ downloadId: "active", filename: "active.zip", state: "progressing", receivedBytes: 250 }),
			],
		});
		const container = renderPanel(api);
		await flush();
		await act(async () => button(container, "Manage downloads").click());
		await flush();

		const listCalls = vi.mocked(api.listBrowserDownloads).mock.calls.length;
		let resolveControl = () => {};
		vi.mocked(api.controlBrowserDownload).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveControl = resolve;
				}),
		);
		await act(async () => button(container, "Pause download").click());
		expect(api.controlBrowserDownload).toHaveBeenCalledWith({ type: "pause", downloadId: "active" });
		expect(api.listBrowserDownloads).toHaveBeenCalledTimes(listCalls);
		await act(async () => {
			resolveControl();
			await Promise.resolve();
		});
		await flush();
		expect(api.listBrowserDownloads).toHaveBeenCalledTimes(listCalls + 1);

		vi.mocked(api.controlBrowserDownload).mockRejectedValueOnce(new Error("control failed"));
		const callsBeforeFailure = vi.mocked(api.listBrowserDownloads).mock.calls.length;
		await act(async () => button(container, "Pause download").click());
		await flush();
		expect(container.textContent).toContain("Browser action failed");
		expect(api.listBrowserDownloads).toHaveBeenCalledTimes(callsBeforeFailure);
	});

	it("shows a clear failure inside the confirmation dialog and recovers on retry", async () => {
		const { api } = fixture();
		vi.mocked(api.clearBrowserHistory).mockRejectedValueOnce(new Error("clear failed"));
		const container = renderPanel(api);
		await flush();
		await act(async () => button(container, "Manage browsing history").click());
		await flush();
		await act(async () => button(container, "Clear browsing history").click());
		const dialog = document.querySelector("dialog")!;
		await act(async () => button(dialog, "Confirm clear browsing history").click());
		await flush();

		expect(dialog.textContent).toContain("Browser action failed");
		expect(dialog.textContent).toContain("Clear history");
		expect(button(dialog, "Cancel").disabled).toBe(false);
		expect(container.textContent).toContain("Metis docs");
		expect(api.clearBrowserHistory).toHaveBeenCalledTimes(1);
		expect(container.textContent).not.toContain("Browsing history cleared");

		await act(async () => button(dialog, "Confirm clear browsing history").click());
		await flush();

		expect(api.clearBrowserHistory).toHaveBeenCalledTimes(2);
		expect(document.querySelector("dialog")).toBeNull();
		expect(container.textContent).toContain("Browsing history cleared");
		expect(container.textContent).toContain("No history yet");
	});

	it("retries a failed initial read without discarding fulfilled partial data", async () => {
		const { api } = fixture();
		vi.mocked(api.listBrowserProfiles).mockRejectedValueOnce(new Error("profiles unavailable"));
		const container = renderPanel(api);
		await flush();

		expect(container.textContent).toContain("Browser settings could not be loaded");
		expect(container.textContent).toContain("1 downloads");
		expect(api.listBrowserProfiles).toHaveBeenCalledOnce();

		await act(async () => button(container, "Retry").click());
		await flush();

		expect(container.textContent).not.toContain("Browser settings could not be loaded");
		expect(container.textContent).toContain("2 profiles");
		expect(container.textContent).toContain("1 downloads");
		expect(api.listBrowserProfiles).toHaveBeenCalledTimes(2);
		expect(api.clearBrowserHistory).not.toHaveBeenCalled();
	});

	it("retries a failed history read without showing a confirmed empty history", async () => {
		const { api } = fixture();
		vi.mocked(api.listBrowserHistory).mockRejectedValueOnce(new Error("history unavailable"));
		const container = renderPanel(api);
		await flush();
		await act(async () => button(container, "Manage browsing history").click());
		await flush();

		expect(container.textContent).toContain("Browser settings could not be loaded");
		expect(container.textContent).not.toContain("No history yet");
		expect(api.listBrowserHistory).toHaveBeenCalledOnce();

		await act(async () => button(container, "Retry").click());
		await flush();

		expect(container.textContent).not.toContain("Browser settings could not be loaded");
		expect(container.textContent).toContain("Metis docs");
		expect(api.listBrowserHistory).toHaveBeenCalledTimes(2);
	});
});
