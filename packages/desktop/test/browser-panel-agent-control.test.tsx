// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "../src/renderer/components/BrowserPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserHandoffReason,
	type DesktopBrowserState,
	type MetisDesktopApi,
} from "../src/shared/desktop-api.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const BROWSER_ID = "22222222-2222-4222-8222-222222222222";
let roots: Root[] = [];

function browserApi(overrides: Partial<MetisDesktopApi> = {}): MetisDesktopApi {
	const state: DesktopBrowserState = {
		browserId: BROWSER_ID,
		profileId: DEFAULT_BROWSER_PROFILE_ID,
		url: "https://example.test/account",
		title: "Account",
		faviconUrl: null,
		loading: false,
		canGoBack: false,
		canGoForward: false,
		zoomPercent: 100,
	};
	return {
		createBrowser: vi.fn().mockResolvedValue(state),
		captureBrowserPreview: vi.fn().mockResolvedValue("data:image/png;base64,cHJldmlldw=="),
		controlBrowser: vi.fn().mockResolvedValue(undefined),
		takeBrowserControl: vi.fn().mockResolvedValue(undefined),
		resolveBrowserHandoff: vi.fn().mockResolvedValue(undefined),
		listBrowserDownloads: vi.fn().mockResolvedValue([]),
		listBrowserHistory: vi.fn().mockResolvedValue([]),
		clearBrowserHistory: vi.fn().mockResolvedValue(undefined),
		subscribeBrowser: vi.fn().mockReturnValue(() => undefined),
		...overrides,
	} as unknown as MetisDesktopApi;
}

function mount(api: MetisDesktopApi) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = async (
		controlState: "idle" | "agent" | "handoff",
		handoffReason?: DesktopBrowserHandoffReason,
	) => {
		await act(async () => {
			root.render(
				<BrowserPanel
					api={api}
					browserId={BROWSER_ID}
					controlState={controlState}
					handoffReason={handoffReason}
					onError={vi.fn()}
					onProfileImported={vi.fn()}
					onState={vi.fn()}
					profile={{ profileId: DEFAULT_BROWSER_PROFILE_ID, name: "Default" }}
					sessionId={SESSION_ID}
					visible
				/>,
			);
			await Promise.resolve();
		});
	};
	return { container, render };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (!match) throw new Error(`Missing button: ${text}`);
	return match;
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

describe("BrowserPanel agent control", () => {
	it("hides the native page for every global modal and restores it afterward", async () => {
		const api = browserApi();
		const { render } = mount(api);
		await render("idle");
		await vi.waitFor(() =>
			expect(api.controlBrowser).toHaveBeenCalledWith(expect.objectContaining({
				type: "present",
				visible: true,
			})),
		);

		vi.mocked(api.controlBrowser).mockClear();
		const modal = document.createElement("dialog");
		modal.setAttribute("open", "");
		await act(async () => {
			document.body.append(modal);
			await Promise.resolve();
		});
		await vi.waitFor(() =>
			expect(api.controlBrowser).toHaveBeenCalledWith(expect.objectContaining({
				type: "present",
				visible: false,
			})),
		);

		vi.mocked(api.controlBrowser).mockClear();
		await act(async () => {
			modal.remove();
			await Promise.resolve();
		});
		await vi.waitFor(() =>
			expect(api.controlBrowser).toHaveBeenCalledWith(expect.objectContaining({
				type: "present",
				visible: true,
			})),
		);
	});

	it("shows a safe activity bar, hides native presentation, and requests takeover once", async () => {
		let resolveTakeover!: () => void;
		const takeBrowserControl = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
			resolveTakeover = resolve;
		}));
		const api = browserApi({ takeBrowserControl });
		const { container, render } = mount(api);
		await render("agent");

		expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Browser automation active");
		expect(container.querySelector('[role="status"]')?.textContent).toContain("Metis is controlling this page");
		expect(container.querySelector(".browser-toolbar")?.hasAttribute("inert")).toBe(true);
		await vi.waitFor(() =>
			expect(api.captureBrowserPreview).toHaveBeenCalledWith({ sessionId: SESSION_ID, browserId: BROWSER_ID }),
		);
		await vi.waitFor(() =>
			expect(api.controlBrowser).toHaveBeenCalledWith(expect.objectContaining({
				type: "present",
				sessionId: SESSION_ID,
				browserId: BROWSER_ID,
				visible: false,
			})),
		);

		const takeover = button(container, "Take control");
		await act(async () => {
			takeover.click();
			takeover.click();
		});
		expect(takeBrowserControl).toHaveBeenCalledTimes(1);
		expect(takeBrowserControl).toHaveBeenCalledWith({ sessionId: SESSION_ID, browserId: BROWSER_ID });
		expect(button(container, "Taking control…").disabled).toBe(true);
		await act(async () => resolveTakeover());
	});

	it("keeps handoff persistent, focuses its heading once, and forwards completion", async () => {
		const resolveBrowserHandoff = vi.fn().mockResolvedValue(undefined);
		const api = browserApi({ resolveBrowserHandoff });
		const { container, render } = mount(api);
		await render("idle");
		await render("handoff", "login");

		const alert = container.querySelector<HTMLElement>('[role="alert"]');
		expect(alert?.getAttribute("aria-label")).toBe("Your action is needed");
		expect(alert?.textContent).toContain("Sign in on this page");
		const heading = alert?.querySelector<HTMLHeadingElement>("h2");
		await vi.waitFor(() => expect(document.activeElement).toBe(heading));

		await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(container.querySelector('[role="alert"]')).toBe(alert);
		expect(resolveBrowserHandoff).not.toHaveBeenCalled();

		await act(async () => button(container, "Done, continue").click());
		expect(resolveBrowserHandoff).toHaveBeenCalledWith({
			sessionId: SESSION_ID,
			browserId: BROWSER_ID,
			decision: "complete",
		});
	});

	it("forwards explicit handoff cancellation without exposing page data", async () => {
		const resolveBrowserHandoff = vi.fn().mockResolvedValue(undefined);
		const api = browserApi({ resolveBrowserHandoff });
		const { container, render } = mount(api);
		await render("handoff", "captcha");

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("human verification");
		await act(async () => button(container, "Cancel").click());
		expect(resolveBrowserHandoff).toHaveBeenCalledWith({
			sessionId: SESSION_ID,
			browserId: BROWSER_ID,
			decision: "cancel",
		});
	});

	it("resyncs native bounds after a sidebar animation when only position changed", async () => {
		const api = browserApi();
		const { container, render } = mount(api);
		await render("idle");
		const anchor = container.querySelector(".browser-view-anchor");
		if (!(anchor instanceof HTMLElement)) throw new Error("missing browser-view-anchor");
		let x = 900;
		vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => ({
			x,
			y: 86,
			width: 393,
			height: 747,
			top: 86,
			left: x,
			right: x + 393,
			bottom: 833,
			toJSON: () => ({}),
		}));
		await act(async () => {
			window.dispatchEvent(new Event("animationend"));
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		await vi.waitFor(() =>
			expect(api.controlBrowser).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "present",
					bounds: { x: 900, y: 86, width: 393, height: 747 },
				}),
			),
		);
		vi.mocked(api.controlBrowser).mockClear();
		x = 507;
		await act(async () => {
			window.dispatchEvent(new Event("animationend"));
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		await vi.waitFor(() =>
			expect(api.controlBrowser).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "present",
					bounds: { x: 507, y: 86, width: 393, height: 747 },
				}),
			),
		);
	});
});
