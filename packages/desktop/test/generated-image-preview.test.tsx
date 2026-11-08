// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../src/renderer/components/AppErrorBoundary.tsx";
import { ConversationScopeContext } from "../src/renderer/components/ConversationScope.tsx";
import { GeneratedImageResult } from "../src/renderer/components/GeneratedImageResult.tsx";
import { ImageGenerationContext } from "../src/renderer/components/ImageGenerationContext.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { DESKTOP_IPC_CHANNELS, type MetisDesktopApi } from "../src/shared/desktop-api.ts";

const electron = vi.hoisted(() => ({
	contextBridge: { exposeInMainWorld: vi.fn() },
	ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
	webUtils: { getPathForFile: vi.fn() },
}));
vi.mock("electron", () => electron);

const sessionId = "11111111-1111-4111-8111-111111111111";
const rootSessionId = "22222222-2222-4222-8222-222222222222";
const fileId = "0384e5f3b2f94174";
let intersections = [true];
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
	intersections = [true];
	vi.resetModules();
	vi.clearAllMocks();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			private readonly callback: IntersectionObserverCallback;
			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback;
			}
			observe(target: Element) {
				this.callback(
					intersections.map((isIntersecting) => ({ target, isIntersecting }) as IntersectionObserverEntry),
					this as unknown as IntersectionObserver,
				);
			}
			disconnect() {}
		},
	);
	await setLocale("en");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	electron.ipcRenderer.invoke.mockResolvedValue({ ok: false, reason: "unavailable" });
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function mount(scope: { rootSessionId?: string } = {}) {
	await import("../src/preload.ts");
	const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as MetisDesktopApi;
	await act(async () =>
		root.render(
			<AppErrorBoundary>
				<ConversationScopeContext.Provider value={scope}>
					<ImageGenerationContext.Provider value={{ api }}>
						<GeneratedImageResult
							sessionId={sessionId}
							running={false}
							result={{
								type: "tool_result",
								toolCallId: "image-call",
								name: "image_generate",
								isError: false,
								output: "",
								imageGeneration: {
									status: "completed",
									requestedCount: 1,
									images: [
										{
											fileId,
											name: "generated.png",
											byteLength: 3918175,
											mediaType: "image/png",
											width: 1152,
											height: 2048,
											deliveredAt: "2026-11-06T02:56:42.912Z",
											availability: "available",
										},
									],
								},
							}}
						/>
					</ImageGenerationContext.Provider>
				</ConversationScopeContext.Provider>
			</AppErrorBoundary>,
		),
	);
}

describe("generated image preview through the desktop preload", () => {
	it("uses the latest visibility when hidden and visible notifications arrive together", async () => {
		intersections = [false, true];
		await mount();
		expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.readPreviewFile, {
			source: "delivered",
			sessionId,
			fileId,
		});
	});
	it("times out an unsettled preview and allows a fresh attempt without accepting late results", async () => {
		vi.useFakeTimers();
		try {
			let settle: (value: unknown) => void = () => {};
			electron.ipcRenderer.invoke.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						settle = resolve;
					}),
			);
			await mount();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(30_000);
			});
			expect(container.textContent).toContain("Image loading timed out");
			await act(async () => (container.querySelector(".generated-image-retry") as HTMLButtonElement).click());
			expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(2);
			expect(container.textContent).toContain("Generated image unavailable");
			await act(async () => settle({ ok: false, reason: "too-large" }));
			expect(container.textContent).not.toContain("Image is too large to preview");
		} finally {
			vi.useRealTimers();
		}
	});
	it.each([false, true])(
		"validates the preview request without crashing the conversation (subagent: %s)",
		async (subagent) => {
			await mount(subagent ? { rootSessionId } : {});
			expect(container.querySelector(".app-error-boundary")).toBeNull();
			expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.readPreviewFile, {
				source: "delivered",
				sessionId,
				fileId,
				...(subagent ? { rootSessionId } : {}),
			});
			expect(container.querySelector(".generated-image-preview-state")?.textContent).toContain(
				"Generated image unavailable",
			);
		},
	);

	it("shows a synchronous preview failure inside the image tile", async () => {
		electron.ipcRenderer.invoke.mockImplementation(() => {
			throw new Error("Preview transport failed");
		});
		await mount({ rootSessionId });
		expect(container.querySelector(".app-error-boundary")).toBeNull();
		expect(container.querySelector(".generated-image-preview-state")?.textContent).toContain(
			"Preview transport failed",
		);
	});
});
