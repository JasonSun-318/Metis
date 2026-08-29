// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "../src/renderer/components/BrowserPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type {
	DesktopBrowserEvent,
	DesktopBrowserState,
	DesktopHistoryEntry,
	MetisDesktopApi,
} from "../src/shared/desktop-api.ts";
import { DEFAULT_BROWSER_PROFILE_ID } from "../src/shared/desktop-api.ts";

let roots: Root[] = [];

function historyEntry(overrides: Partial<DesktopHistoryEntry> & { entryId: string }): DesktopHistoryEntry {
	return {
		url: "https://example.com/docs",
		title: "Example Domain",
		faviconUrl: null,
		visitedAt: 1_756_400_000_000,
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
				<BrowserPanel api={api} sessionId="11111111-1111-4111-8111-111111111111" browserId="browser-1" controlState="idle" onError={vi.fn()} onProfileImported={vi.fn()} onState={vi.fn()} profile={{ profileId: DEFAULT_BROWSER_PROFILE_ID, name: "Default" }} visible />
			</StrictMode>,
		),
	);
	roots.push(root);
	return { container };
}

function browserPanelApi(overrides: {
	clearBrowserHistory?: MetisDesktopApi["clearBrowserHistory"];
	history?: readonly DesktopHistoryEntry[];
} = {}): { api: MetisDesktopApi; emitBrowserEvent: (event: DesktopBrowserEvent) => void } {
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
		listBrowserDownloads: vi.fn().mockResolvedValue([]),
		controlBrowserDownload: vi.fn().mockResolvedValue(undefined),
		listBrowserHistory: vi.fn().mockResolvedValue(overrides.history ?? []),
		clearBrowserHistory: overrides.clearBrowserHistory ?? vi.fn().mockResolvedValue(undefined),
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

describe("BrowserPanel history", () => {
	it("lists history entries and navigates back to one on click", async () => {
		const { api } = browserPanelApi({ history: [historyEntry({ entryId: "h-1" })] });
		const { container } = renderPanel(api);
		await flush();

		await act(async () => button(container, "History")!.click());
		await flush();

		expect(container.textContent).toContain("Example Domain");
		expect(container.textContent).toContain("https://example.com/docs");
		expect(container.textContent).toContain("Clear history");

		await act(async () => container.querySelector<HTMLButtonElement>(".browser-history-row")!.click());

		expect(api.controlBrowser).toHaveBeenCalledWith({
			type: "navigate",
			sessionId: "11111111-1111-4111-8111-111111111111",
			browserId: "browser-1",
			url: "https://example.com/docs",
		});
	});

	it("updates from browser events and clears history", async () => {
		const clearBrowserHistory = vi.fn().mockResolvedValue(undefined);
		const { api, emitBrowserEvent } = browserPanelApi({ clearBrowserHistory });
		const { container } = renderPanel(api);
		await flush();

		await act(async () => {
			emitBrowserEvent({ type: "history", profileId: DEFAULT_BROWSER_PROFILE_ID, entries: [historyEntry({ entryId: "h-2", title: "Docs" })] });
		});
		await act(async () => button(container, "History")!.click());
		await flush();

		expect(container.textContent).toContain("Docs");

		await act(async () => button(container, "Clear history")!.click());
		expect(clearBrowserHistory).toHaveBeenCalledWith({ profileId: DEFAULT_BROWSER_PROFILE_ID });
	});

	it("shows an empty placeholder without entries", async () => {
		const { api } = browserPanelApi();
		const { container } = renderPanel(api);
		await flush();

		await act(async () => button(container, "History")!.click());
		await flush();

		expect(container.textContent).toContain("No history yet");
		expect(button(container, "Clear history")!.disabled).toBe(true);
	});
});
