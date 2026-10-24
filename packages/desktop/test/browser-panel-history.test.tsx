// @vitest-environment jsdom

import { act, StrictMode } from "react";
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

function renderPanel(
	api: MetisDesktopApi,
	profile: { readonly profileId: string; readonly name: string } = {
		profileId: DEFAULT_BROWSER_PROFILE_ID,
		name: "Default",
	},
) {
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
					onError={vi.fn()}
					onProfileImported={vi.fn()}
					onState={vi.fn()}
					profile={profile}
					visible
				/>
			</StrictMode>,
		),
	);
	roots.push(root);
	return { container, root };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, reject, resolve };
}

function browserPanelApi(
	overrides: {
		clearBrowserHistory?: MetisDesktopApi["clearBrowserHistory"];
		history?: readonly DesktopHistoryEntry[];
		listBrowserHistory?: MetisDesktopApi["listBrowserHistory"];
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
		listBrowserDownloads: vi.fn().mockResolvedValue([]),
		controlBrowserDownload: vi.fn().mockResolvedValue(undefined),
		listBrowserHistory: overrides.listBrowserHistory ?? vi.fn().mockResolvedValue(overrides.history ?? []),
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
	it("keeps an address draft through initialization and navigates after the browser is ready", async () => {
		const { api, emitBrowserEvent } = browserPanelApi();
		const initial: DesktopBrowserState = {
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
		let ready!: (state: DesktopBrowserState) => void;
		vi.mocked(api.createBrowser).mockReturnValue(
			new Promise((resolve) => {
				ready = resolve;
			}),
		);
		const { container } = renderPanel(api);
		await flush();
		const input = container.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
				input,
				"https://example.com/typed",
			);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => emitBrowserEvent({ type: "state", state: initial }));
		expect(input.value).toBe("https://example.com/typed");
		await act(async () =>
			input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(api.controlBrowser).not.toHaveBeenCalledWith(expect.objectContaining({ type: "navigate" }));
		await act(async () => ready(initial));
		expect(api.controlBrowser).toHaveBeenCalledWith(
			expect.objectContaining({ type: "navigate", browserId: "browser-1", url: "https://example.com/typed" }),
		);
	});

	it("uses the same browser for start-page links and address navigation", async () => {
		const { api, emitBrowserEvent } = browserPanelApi({ history: [historyEntry({ entryId: "recent" })] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () =>
			root.render(
				<BrowserPanel
					api={api}
					sessionId="11111111-1111-4111-8111-111111111111"
					browserId="browser-1"
					controlState="idle"
					onError={vi.fn()}
					onProfileImported={vi.fn()}
					onState={vi.fn()}
					profile={{ profileId: DEFAULT_BROWSER_PROFILE_ID, name: "Default" }}
					visible
					startPageTools={<button type="button">Terminal</button>}
				/>,
			),
		);
		await flush();
		expect(container.querySelector(".browser-start-page")?.textContent).toContain("Terminal");
		await act(async () => container.querySelector<HTMLButtonElement>(".browser-start-recent-page")!.click());
		expect(api.controlBrowser).toHaveBeenCalledWith({
			type: "navigate",
			sessionId: "11111111-1111-4111-8111-111111111111",
			browserId: "browser-1",
			url: "https://example.com/docs",
		});
		await act(async () =>
			emitBrowserEvent({
				type: "state",
				state: {
					browserId: "browser-1",
					profileId: DEFAULT_BROWSER_PROFILE_ID,
					url: "https://example.com/docs",
					title: "Docs",
					faviconUrl: null,
					loading: false,
					canGoBack: false,
					canGoForward: false,
					zoomPercent: 100,
				},
			}),
		);
		expect(container.querySelector(".browser-start-page")).toBeNull();
		expect(api.createBrowser).toHaveBeenCalledTimes(1);
	});

	it("retains a captured page behind an external menu and restores native presentation", async () => {
		const { api } = browserPanelApi();
		vi.mocked(api.createBrowser).mockResolvedValue({
			browserId: "browser-1",
			profileId: DEFAULT_BROWSER_PROFILE_ID,
			url: "https://example.com",
			title: "Example",
			faviconUrl: null,
			loading: false,
			canGoBack: false,
			canGoForward: false,
			zoomPercent: 100,
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		const render = async (covered: boolean) =>
			act(async () =>
				root.render(
					<BrowserPanel
						api={api}
						sessionId="11111111-1111-4111-8111-111111111111"
						browserId="browser-1"
						controlState="idle"
						onError={vi.fn()}
						onProfileImported={vi.fn()}
						onState={vi.fn()}
						profile={{ profileId: DEFAULT_BROWSER_PROFILE_ID, name: "Default" }}
						visible
						covered={covered}
					/>,
				),
			);
		await render(false);
		await flush();
		const panel = container.querySelector(".browser-panel");
		await render(true);
		await flush();
		expect(container.querySelector(".browser-panel")).toBe(panel);
		expect(api.captureBrowserPreview).toHaveBeenCalledWith({
			sessionId: "11111111-1111-4111-8111-111111111111",
			browserId: "browser-1",
		});
		expect(container.querySelector(".browser-view-preview")).not.toBeNull();
		expect(api.controlBrowser).toHaveBeenLastCalledWith(expect.objectContaining({ type: "present", visible: false }));
		const callsWhileCovered = vi.mocked(api.controlBrowser).mock.calls.length;
		await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true })));
		expect(api.controlBrowser).toHaveBeenCalledTimes(callsWhileCovered);
		await render(false);
		await flush();
		expect(api.controlBrowser).toHaveBeenLastCalledWith(expect.objectContaining({ type: "present", visible: true }));
		expect(api.createBrowser).toHaveBeenCalledTimes(1);
	});

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
			emitBrowserEvent({
				type: "history",
				profileId: DEFAULT_BROWSER_PROFILE_ID,
				entries: [historyEntry({ entryId: "h-2", title: "Docs" })],
			});
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

	it("shows loading instead of an empty placeholder until the first read settles", async () => {
		const first = deferred<readonly DesktopHistoryEntry[]>();
		const listBrowserHistory = vi.fn().mockReturnValue(first.promise);
		const { api } = browserPanelApi({ listBrowserHistory });
		const { container } = renderPanel(api);
		await flush();

		await act(async () => button(container, "History")!.click());
		expect(container.textContent).toContain("Loading browsing history…");
		expect(container.textContent).not.toContain("No history yet");

		await act(async () => first.resolve([]));
		await flush();
		expect(container.textContent).toContain("No history yet");
	});

	it("shows a local alert and recovers from a failed read only once per retry", async () => {
		const listBrowserHistory = vi
			.fn()
			.mockRejectedValueOnce(new Error("first read failed"))
			.mockRejectedValueOnce(new Error("first read failed"))
			.mockResolvedValueOnce([historyEntry({ entryId: "recovered" })]);
		const { api } = browserPanelApi({ listBrowserHistory });
		const { container } = renderPanel(api);
		await flush();

		await act(async () => button(container, "History")!.click());
		await flush();
		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("History could not be loaded");
		expect(container.textContent).not.toContain("No history yet");

		const retry = button(container, "Retry")!;
		await act(async () => {
			retry.click();
			retry.click();
		});
		await flush();
		expect(document.activeElement).toBe(button(container, "History"));
		expect(listBrowserHistory).toHaveBeenCalledTimes(3);
		expect(api.createBrowser).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Example Domain");
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("keeps event data that arrived while an older read was still pending", async () => {
		const first = deferred<readonly DesktopHistoryEntry[]>();
		const listBrowserHistory = vi.fn().mockReturnValue(first.promise);
		const { api, emitBrowserEvent } = browserPanelApi({ listBrowserHistory });
		const { container } = renderPanel(api);
		await flush();

		await act(async () =>
			emitBrowserEvent({
				type: "history",
				profileId: DEFAULT_BROWSER_PROFILE_ID,
				entries: [historyEntry({ entryId: "new-event", title: "Fresh event entry" })],
			}),
		);
		await act(async () => button(container, "History")!.click());
		expect(container.textContent).toContain("Fresh event entry");

		await act(async () => first.resolve([historyEntry({ entryId: "old-read", title: "Stale read entry" })]));
		await flush();
		expect(container.textContent).toContain("Fresh event entry");
		expect(container.textContent).not.toContain("Stale read entry");
	});

	it("ignores a read that resolves after the profile changed", async () => {
		const oldProfile = deferred<readonly DesktopHistoryEntry[]>();
		const nextProfile = deferred<readonly DesktopHistoryEntry[]>();
		const listBrowserHistory = vi.fn((options: { profileId: string }) =>
			options.profileId === DEFAULT_BROWSER_PROFILE_ID ? oldProfile.promise : nextProfile.promise,
		);
		const { api } = browserPanelApi({ listBrowserHistory });
		const { container, root } = renderPanel(api);
		await flush();

		await act(async () =>
			root.render(
				<StrictMode>
					<BrowserPanel
						api={api}
						sessionId="11111111-1111-4111-8111-111111111111"
						browserId="browser-1"
						controlState="idle"
						onError={vi.fn()}
						onProfileImported={vi.fn()}
						onState={vi.fn()}
						profile={{ profileId: "profile-2", name: "Second" }}
						visible
					/>
				</StrictMode>,
			),
		);
		await act(async () =>
			nextProfile.resolve([historyEntry({ entryId: "new-profile", title: "Second profile entry" })]),
		);
		await flush();
		await act(async () => button(container, "History")!.click());
		expect(container.textContent).toContain("Second profile entry");

		await act(async () => oldProfile.resolve([historyEntry({ entryId: "old-profile", title: "Old profile entry" })]));
		await flush();
		expect(container.textContent).toContain("Second profile entry");
		expect(container.textContent).not.toContain("Old profile entry");
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("drops a read that resolves after unmount", async () => {
		const first = deferred<readonly DesktopHistoryEntry[]>();
		const listBrowserHistory = vi.fn().mockReturnValue(first.promise);
		const { api } = browserPanelApi({ listBrowserHistory });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<BrowserPanel
					api={api}
					sessionId="11111111-1111-4111-8111-111111111111"
					browserId="browser-1"
					controlState="idle"
					onError={vi.fn()}
					onProfileImported={vi.fn()}
					onState={vi.fn()}
					profile={{ profileId: DEFAULT_BROWSER_PROFILE_ID, name: "Default" }}
					visible
				/>,
			),
		);
		await flush();
		await act(async () => root.unmount());
		await act(async () => first.resolve([historyEntry({ entryId: "late" })]));
		await flush();
		expect(container.textContent).toBe("");
	});
});
