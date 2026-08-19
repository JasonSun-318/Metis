import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionSummary } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { resolveRendererAsset } from "../src/main/app-protocol-scheme.ts";
import { ClientBroker, isTrustedRendererUrl } from "../src/main/client-broker.ts";
import { isSafeExternalUrl } from "../src/main/external-url.ts";
import {
	DESKTOP_BROWSER_EVENT_CHANNEL,
	DESKTOP_IPC_CHANNELS,
	DESKTOP_TERMINAL_EVENT_CHANNEL,
	type DesktopBrowserEvent,
	type DesktopTerminalEvent,
	type SupervisorView,
	validateBrowserControlInput,
	validateCreateBrowserInput,
	validateDesktopApiEvent,
	validateDesktopBrowserEvent,
	validateListWorkspaceDirectoryInput,
	validateOpenWorkspaceFileInput,
	validateReadWorkspaceFileInput,
	validateSearchWorkspaceFilesInput,
	validateWorkspaceEditState,
	validateWorkspaceMutationInput,
	validateWorkspaceReviewFileInput,
	validateWorkspaceReviewInput,
	validateWriteClipboardTextInput,
	validateWriteWorkspaceFileInput,
} from "../src/shared/desktop-api.ts";

const desktopRoot = join(import.meta.dirname, "..");

function source(path: string): string {
	return readFileSync(join(desktopRoot, path), "utf8");
}

function rendererSources(directory = join(desktopRoot, "src", "renderer")): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return rendererSources(path);
		return /\.(?:ts|tsx)$/u.test(entry.name) ? [readFileSync(path, "utf8")] : [];
	});
}

it("uses only the Metis Desktop profile", () => {
	const main = source("src/main/main.ts");
	expect(main).toContain('const explicitUserData = app.commandLine.hasSwitch("user-data-dir")');
	expect(main).not.toContain("migrateDesktopUserData");
	expect(main).toContain('app.setPath("userData", join(app.getPath("appData"), "Metis"))');
});

class FakeIpcMain {
	readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();

	handle(channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>): void {
		this.handlers.set(channel, handler);
	}

	removeHandler(channel: string): void {
		this.handlers.delete(channel);
	}
}

class FakeWebContents {
	readonly mainFrame = { url: "app://renderer/index.html" };
	readonly sent: unknown[][] = [];
	private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	send(...args: unknown[]): void {
		this.sent.push(args);
	}

	isDestroyed(): boolean {
		return false;
	}

	on(event: string, listener: (...args: unknown[]) => void): this {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return this;
	}

	off(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}
}

function supervisorHarness() {
	let view: SupervisorView = {
		state: "ready",
		serverEpoch: "11111111-1111-4111-8111-111111111111",
		restartAttempt: 0,
		failure: null,
	};
	let stateListener: ((view: SupervisorView) => void) | undefined;
	let messageListener: ((message: unknown) => void) | undefined;
	const supervisor = {
		view: () => view,
		onState: (listener: typeof stateListener) => {
			stateListener = listener;
			return () => {
				stateListener = undefined;
			};
		},
		onMessage: (listener: typeof messageListener) => {
			messageListener = listener;
			return () => {
				messageListener = undefined;
			};
		},
		request: vi.fn(),
		retry: vi.fn(),
		respondToServerRequest: vi.fn(),
	};
	return {
		supervisor,
		emitMessage: (message: unknown) => messageListener?.(message),
		setView: (next: Partial<SupervisorView>) => {
			view = { ...view, ...next };
			stateListener?.(view);
		},
	};
}

describe("desktop trust boundaries", () => {
	it("accepts exact workspace file commands and rejects unsafe relative paths", () => {
		const sessionId = "10000000-0000-4000-8000-000000000099";
		const revision = "a".repeat(64);
		expect(validateListWorkspaceDirectoryInput({ sessionId, relativePath: "" })).toEqual({
			sessionId,
			relativePath: "",
		});
		expect(validateSearchWorkspaceFilesInput({ sessionId, query: "profile" })).toEqual({
			sessionId,
			query: "profile",
		});
		expect(validateReadWorkspaceFileInput({ sessionId, relativePath: "src/App.tsx" })).toEqual({
			sessionId,
			relativePath: "src/App.tsx",
		});
		expect(validateWorkspaceReviewInput({ sessionId, revision: "working-tree" })).toEqual({
			sessionId,
			revision: "working-tree",
		});
		expect(
			validateWorkspaceReviewFileInput({
				sessionId,
				revision: "b".repeat(40),
				relativePath: "src/App.tsx",
			}),
		).toEqual({ sessionId, revision: "b".repeat(40), relativePath: "src/App.tsx" });
		expect(() => validateWorkspaceReviewInput({ sessionId, revision: "HEAD" })).toThrow(
			"Invalid workspace review revision",
		);
		expect(() =>
			validateWorkspaceReviewFileInput({
				sessionId,
				revision: "working-tree",
				relativePath: "../outside",
			}),
		).toThrow("Invalid workspace relative path");
		expect(() =>
			validateWorkspaceReviewFileInput({
				sessionId,
				revision: "working-tree",
				relativePath: "README.md",
				extra: true,
			}),
		).toThrow("Invalid workspace review file input");
		expect(() => validateWorkspaceReviewInput({ sessionId, revision: "working-tree", extra: true })).toThrow(
			"Invalid workspace review input",
		);
		expect(validateOpenWorkspaceFileInput({ sessionId, relativePath: "README.md", action: "reveal" })).toEqual({
			sessionId,
			relativePath: "README.md",
			action: "reveal",
		});
		expect(
			validateWriteWorkspaceFileInput({
				sessionId,
				relativePath: "src/App.tsx",
				text: "export const App = 2;",
				expectedRevision: revision,
			}),
		).toEqual({
			sessionId,
			relativePath: "src/App.tsx",
			text: "export const App = 2;",
			expectedRevision: revision,
		});
		expect(
			validateWorkspaceMutationInput({
				action: "create",
				sessionId,
				parentRelativePath: "src",
				name: "new.ts",
				kind: "file",
			}),
		).toEqual({ action: "create", sessionId, parentRelativePath: "src", name: "new.ts", kind: "file" });
		expect(
			validateWorkspaceMutationInput({
				action: "rename",
				sessionId,
				relativePath: "src/old.ts",
				name: "new.ts",
			}),
		).toEqual({ action: "rename", sessionId, relativePath: "src/old.ts", name: "new.ts" });
		expect(
			validateWorkspaceMutationInput({
				action: "move",
				sessionId,
				relativePath: "src/new.ts",
				destinationDirectoryRelativePath: "archive",
			}),
		).toEqual({ action: "move", sessionId, relativePath: "src/new.ts", destinationDirectoryRelativePath: "archive" });
		expect(validateWorkspaceMutationInput({ action: "trash", sessionId, relativePath: "archive/new.ts" })).toEqual({
			action: "trash",
			sessionId,
			relativePath: "archive/new.ts",
		});

		for (const value of [
			{ sessionId: "not-a-uuid", relativePath: "" },
			{ sessionId, relativePath: "../secret" },
			{ sessionId, relativePath: "/etc/passwd" },
			{ sessionId, relativePath: "C:/Windows/System32" },
			{ sessionId, relativePath: "src\\secret" },
			{ sessionId, relativePath: "src//secret" },
			{ sessionId, relativePath: "a\0b" },
			{ sessionId, relativePath: "a".repeat(4_097) },
		]) {
			expect(() => validateListWorkspaceDirectoryInput(value)).toThrow();
		}
		expect(() => validateSearchWorkspaceFilesInput({ sessionId, query: "" })).toThrow();
		expect(() => validateSearchWorkspaceFilesInput({ sessionId, query: "x".repeat(257) })).toThrow();
		expect(() =>
			validateOpenWorkspaceFileInput({ sessionId, relativePath: "README.md", action: "delete" }),
		).toThrow();
		expect(() => validateReadWorkspaceFileInput({ sessionId, relativePath: "README.md", extra: true })).toThrow();
		expect(() =>
			validateWriteWorkspaceFileInput({
				sessionId,
				relativePath: "../outside.ts",
				text: "x",
				expectedRevision: revision,
			}),
		).toThrow();
		expect(() =>
			validateWriteWorkspaceFileInput({
				sessionId,
				relativePath: "src/App.tsx",
				text: "x",
				expectedRevision: "invalid",
			}),
		).toThrow();
		expect(() =>
			validateWriteWorkspaceFileInput({
				sessionId,
				relativePath: "src/App.tsx",
				text: "x",
				expectedRevision: revision,
				extra: true,
			}),
		).toThrow();
		expect(() =>
			validateWriteWorkspaceFileInput({
				sessionId,
				relativePath: "src/App.tsx",
				text: "x".repeat(2 * 1024 * 1024 + 1),
				expectedRevision: revision,
			}),
		).toThrow();
		for (const value of [
			{ action: "create", sessionId, parentRelativePath: "../outside", name: "x", kind: "file" },
			{ action: "create", sessionId, parentRelativePath: "", name: "a/b", kind: "file" },
			{ action: "rename", sessionId, relativePath: "", name: "root" },
			{ action: "move", sessionId, relativePath: "src/a", destinationDirectoryRelativePath: "../../outside" },
			{ action: "trash", sessionId, relativePath: "", extra: true },
			{ action: "copy", sessionId, relativePath: "src/a" },
		])
			expect(() => validateWorkspaceMutationInput(value)).toThrow();
	});

	it("accepts only exact clipboard write commands", () => {
		expect(validateWriteClipboardTextInput({ text: "README.md" })).toEqual({ text: "README.md" });
		expect(() => validateWriteClipboardTextInput({ text: "README.md", extra: true })).toThrow();
		expect(() => validateWriteClipboardTextInput({ text: 42 })).toThrow();
	});

	it("accepts only exact workspace edit state reports", () => {
		expect(validateWorkspaceEditState({ dirty: true, language: "zh", visibleSessionId: "session-1" })).toEqual({
			dirty: true,
			language: "zh",
			visibleSessionId: "session-1",
		});
		expect(validateWorkspaceEditState({ dirty: false, language: "en", visibleSessionId: null })).toEqual({
			dirty: false,
			language: "en",
			visibleSessionId: null,
		});
		expect(() => validateWorkspaceEditState({ dirty: true, language: "zh-CN", visibleSessionId: null })).toThrow();
		expect(() => validateWorkspaceEditState({ dirty: true, language: "en" })).toThrow();
		expect(() =>
			validateWorkspaceEditState({ dirty: true, language: "en", visibleSessionId: "", extra: true }),
		).toThrow();
	});

	it("accepts exact browser commands and rejects unsafe renderer payloads", () => {
		const browserId = "10000000-0000-4000-8000-000000000077";
		expect(validateCreateBrowserInput({ browserId })).toEqual({ browserId });
		expect(
			validateBrowserControlInput({
				type: "present",
				browserId,
				visible: true,
				bounds: { x: 800, y: 86, width: 393, height: 747 },
			}),
		).toEqual({
			type: "present",
			browserId,
			visible: true,
			bounds: { x: 800, y: 86, width: 393, height: 747 },
		});
		expect(validateBrowserControlInput({ type: "navigate", browserId, url: "https://example.com" })).toEqual({
			type: "navigate",
			browserId,
			url: "https://example.com",
		});
		expect(
			validateBrowserControlInput({
				type: "find",
				browserId,
				text: "openai",
				forward: true,
				findNext: false,
			}),
		).toEqual({ type: "find", browserId, text: "openai", forward: true, findNext: false });
		expect(validateBrowserControlInput({ type: "set-zoom", browserId, zoomPercent: 137 })).toEqual({
			type: "set-zoom",
			browserId,
			zoomPercent: 137,
		});
		for (const type of [
			"stop-find",
			"print",
			"zoom-in",
			"zoom-out",
			"zoom-reset",
			"capture-page",
			"clear-data",
		] as const) {
			expect(validateBrowserControlInput({ type, browserId })).toEqual({ type, browserId });
		}
		for (const value of [
			{ browserId: "not-a-uuid" },
			{ type: "navigate", browserId, url: "x".repeat(8_193) },
			{ type: "find", browserId, text: "x".repeat(2_049), forward: true, findNext: false },
			{ type: "find", browserId, text: "x", forward: "yes", findNext: false },
			{ type: "set-zoom", browserId, zoomPercent: 24 },
			{ type: "set-zoom", browserId, zoomPercent: 501 },
			{ type: "set-zoom", browserId, zoomPercent: 100.5 },
			{ type: "present", browserId, visible: true, bounds: { x: -1, y: 0, width: 300, height: 300 } },
		]) {
			expect(() =>
				Object.hasOwn(value, "type") ? validateBrowserControlInput(value) : validateCreateBrowserInput(value),
			).toThrow();
		}
		expect(
			validateDesktopBrowserEvent({
				type: "state",
				state: {
					browserId,
					url: "https://example.com/",
					title: "Example",
					faviconUrl: null,
					loading: false,
					canGoBack: false,
					canGoForward: false,
					zoomPercent: 100,
				},
			}),
		).toMatchObject({ type: "state", state: { browserId, title: "Example" } });
		expect(
			validateDesktopBrowserEvent({
				type: "find-result",
				browserId,
				activeMatchOrdinal: 2,
				matches: 52,
			}),
		).toEqual({ type: "find-result", browserId, activeMatchOrdinal: 2, matches: 52 });
		expect(validateDesktopBrowserEvent({ type: "command", browserId, command: "find" })).toEqual({
			type: "command",
			browserId,
			command: "find",
		});
		for (const zoomPercent of [24, 501, 100.5]) {
			expect(() =>
				validateDesktopBrowserEvent({
					type: "state",
					state: {
						browserId,
						url: "https://example.com/",
						title: "Example",
						faviconUrl: null,
						loading: false,
						canGoBack: false,
						canGoForward: false,
						zoomPercent,
					},
				}),
			).toThrow("Invalid browser zoom percent");
		}
		expect(() => validateDesktopBrowserEvent({ type: "command", browserId, command: "developer-tools" })).toThrow(
			"Invalid browser command",
		);
		expect(DESKTOP_BROWSER_EVENT_CHANNEL).toBe("metis:browser-event");
	});

	it("keeps the BrowserWindow sandboxed and denies ambient browser capabilities", () => {
		const windowSource = source("src/main/window.ts");
		expect(windowSource).toContain("contextIsolation: true");
		expect(windowSource).toContain("sandbox: true");
		expect(windowSource).toContain("nodeIntegration: false");
		expect(windowSource).toContain("webviewTag: false");
		expect(windowSource).toContain('process.platform === "darwin"');
		expect(windowSource).toContain('titleBarStyle: "hiddenInset"');
		expect(windowSource).not.toMatch(/enableRemoteModule|@electron\/remote/u);
		expect(windowSource).toContain("setWindowOpenHandler");
		expect(windowSource).toContain("isSafeExternalUrl");
		expect(windowSource).toContain("shell.openExternal");
		expect(windowSource).toContain("will-navigate");
		expect(windowSource).toContain("will-redirect");
		expect(windowSource).toContain("will-redirect");
		expect(windowSource).toContain("will-attach-webview");
		expect(windowSource).toContain("setPermissionRequestHandler");
		expect(windowSource).toContain("setPermissionCheckHandler");
	});

	it("opens only ordinary web and mail links outside the renderer", () => {
		for (const url of ["https://example.com/path", "http://localhost:3000", "mailto:user@example.com"]) {
			expect(isSafeExternalUrl(url)).toBe(true);
		}
		for (const url of [
			"javascript:alert(1)",
			"file:///etc/passwd",
			"app://renderer/index.html",
			"//example.com",
			"not a URL",
		]) {
			expect(isSafeExternalUrl(url)).toBe(false);
		}
	});

	it("ships a strict production CSP and no renderer runtime imports", () => {
		const html = source("src/renderer/index.html");
		expect(html).toContain("default-src 'self'");
		expect(html).toContain("script-src 'self'");
		expect(html).toContain("style-src 'self' 'unsafe-inline'");
		expect(html).toContain("img-src 'self' data: blob:");
		expect(html).toContain("worker-src 'self' blob:");
		expect(html).not.toContain("'unsafe-eval'");
		expect(html).not.toContain("script-src 'self' 'unsafe-inline'");

		for (const rendererSource of rendererSources()) {
			expect(rendererSource).not.toMatch(
				/from\s+["'](?:node:|electron|@(?:metis|arcmind)\/(?:agent|coding-agent|app-server))/u,
			);
			expect(rendererSource).not.toMatch(/ipcRenderer|\.invoke\(|shell\.open|moveToTrash/u);
		}
		const preload = source("src/preload.ts");
		expect(preload).toContain('"project/deletePreview"');
		expect(preload).toContain('"project/delete"');
		expect(preload).toContain('"session/rename"');
		expect(preload).toContain('"session/delete"');
		expect(preload).toContain("const frozenApi = Object.freeze(api)");
		expect(preload).toContain('exposeInMainWorld("metis", frozenApi)');
		for (const method of [
			'"skill/get"',
			'"skill/upsert"',
			'"skill/remove"',
			'"skill/import/inspect"',
			'"skill/import"',
			'"mcp/list"',
			'"mcp/get"',
			'"mcp/catalog/get"',
			'"mcp/upsert"',
			'"mcp/remove"',
			'"mcp/restart"',
			'"mcp/credential/set"',
			'"mcp/credential/clear"',
		]) {
			expect(preload).toContain(method);
		}
		expect(preload).not.toContain('exposeInMainWorld("arcMind"');
		expect(preload).not.toContain('exposeInMainWorld("metis", ipcRenderer');
	});

	it("accepts only the exact privileged renderer document", () => {
		expect(isTrustedRendererUrl("app://renderer/index.html")).toBe(true);
		for (const url of [
			"app://renderer/",
			"app://renderer/index.html?debug=1",
			"app://renderer/index.html#fragment",
			"app://user@renderer/index.html",
			"app://renderer:42/index.html",
			"https://renderer/index.html",
		]) {
			expect(isTrustedRendererUrl(url)).toBe(false);
		}
	});

	it("maps generated renderer URLs from the renderer output root", () => {
		const entry = pathToFileURL("/bundle/renderer/main_window/index.html").toString();
		expect(resolveRendererAsset(entry, "app://renderer/index.html")?.toString()).toBe(entry);
		expect(resolveRendererAsset(entry, "app://renderer/main_window/index.js")?.toString()).toBe(
			pathToFileURL("/bundle/renderer/main_window/index.js").toString(),
		);
		expect(resolveRendererAsset(entry, "app://renderer/main_window.css")?.toString()).toBe(
			pathToFileURL("/bundle/renderer/main_window.css").toString(),
		);
	});

	it("rejects an untrusted sender before every invoke handler", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });

		expect([...ipcMain.handlers.keys()].sort()).toEqual(Object.values(DESKTOP_IPC_CHANNELS).sort());
		for (const handler of ipcMain.handlers.values()) {
			await expect(
				handler({ sender: webContents, senderFrame: { url: "https://attacker.invalid/" } }, {}),
			).rejects.toThrow("Untrusted desktop IPC sender");
		}
		broker.dispose();
	});

	it("does not load preview office files over base64 JSON or a CMap CDN", () => {
		const previewDir = join(desktopRoot, "src", "renderer", "components", "preview");
		const sources = rendererSources(previewDir).join("\n");
		expect(sources).not.toContain("cdn.jsdelivr.net");
		expect(sources).not.toContain("readDeliveredFile");
		expect(sources).not.toContain("readWorkspaceFile");
		expect(sources).toContain("readPreviewFile");
	});

	it("keeps PTY creation behind validated IPC and closes terminals with their renderer owner", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		let terminalListener: ((event: DesktopTerminalEvent) => void) | undefined;
		const terminalManager = {
			create: vi.fn(async (input) => ({ ...input, pid: 1234, shell: "/bin/zsh" })),
			write: vi.fn(),
			resize: vi.fn(),
			close: vi.fn(),
			closeAll: vi.fn(),
			onEvent: vi.fn((listener) => {
				terminalListener = listener;
				return () => {
					terminalListener = undefined;
				};
			}),
		};
		const broker = new ClientBroker({
			ipcMain: ipcMain as never,
			supervisor,
			terminalManager: terminalManager as never,
		});
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		terminalManager.closeAll.mockClear();
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const terminalId = "10000000-0000-4000-8000-000000000088";
		const create = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.createTerminal)!;

		await expect(create(event, { terminalId: "not-a-uuid", cwd: "/tmp", cols: 80, rows: 24 })).rejects.toThrow();
		expect(terminalManager.create).not.toHaveBeenCalled();
		await expect(create(event, { terminalId, cwd: "/tmp", cols: 80, rows: 24 })).resolves.toMatchObject({
			terminalId,
			pid: 1234,
		});
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.writeTerminal)!(event, { terminalId, data: "x".repeat(65_537) }),
		).rejects.toThrow("Invalid terminal input");

		terminalListener?.({ type: "data", terminalId, data: "ready" });
		expect(webContents.sent.at(-1)).toEqual([
			DESKTOP_TERMINAL_EVENT_CHANNEL,
			{ type: "data", terminalId, data: "ready" },
		]);
		webContents.emit("did-start-navigation", {}, "app://renderer/index.html", false, true);
		expect(terminalManager.closeAll).toHaveBeenCalledTimes(1);
		broker.dispose();
	});

	it("keeps browser views behind validated IPC and closes them with their renderer owner", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		let browserListener: ((event: DesktopBrowserEvent) => void) | undefined;
		const browserManager = {
			attach: vi.fn(),
			create: vi.fn((input) => ({
				browserId: input.browserId,
				url: "",
				title: "New tab",
				faviconUrl: null,
				loading: false,
				canGoBack: false,
				canGoForward: false,
			})),
			control: vi.fn(),
			capturePreview: vi.fn().mockResolvedValue("data:image/png;base64,cHJldmlldw=="),
			close: vi.fn(),
			closeAll: vi.fn(),
			onEvent: vi.fn((listener) => {
				browserListener = listener;
				return () => {
					browserListener = undefined;
				};
			}),
		};
		const broker = new ClientBroker({
			ipcMain: ipcMain as never,
			supervisor,
			browserManager: browserManager as never,
		});
		const webContents = new FakeWebContents();
		const contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
		broker.attach({ webContents: webContents as never, contentView } as never);
		browserManager.closeAll.mockClear();
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const browserId = "10000000-0000-4000-8000-000000000089";

		expect(browserManager.attach).toHaveBeenCalledTimes(1);
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.createBrowser)!(event, { browserId }),
		).resolves.toMatchObject({
			browserId,
			title: "New tab",
		});
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.controlBrowser)!(event, {
				type: "navigate",
				browserId,
				url: "https://example.com",
			}),
		).resolves.toBeUndefined();
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.captureBrowserPreview)!(event, { browserId }),
		).resolves.toBe("data:image/png;base64,cHJldmlldw==");
		expect(browserManager.capturePreview).toHaveBeenCalledWith(browserId);
		browserListener?.({ type: "error", browserId, message: "fixture error" });
		expect(webContents.sent.at(-1)).toEqual([
			DESKTOP_BROWSER_EVENT_CHANNEL,
			{ type: "error", browserId, message: "fixture error" },
		]);
		webContents.emit("did-start-navigation", {}, "app://renderer/index.html", false, true);
		expect(browserManager.closeAll).toHaveBeenCalledTimes(1);
		broker.dispose();
	});

	it("authorizes workspace files only from the subscribed Code session", async () => {
		const ipcMain = new FakeIpcMain();
		const { setView, supervisor } = supervisorHarness();
		const codeSessionId = "10000000-0000-4000-8000-000000000091";
		const chatSessionId = "10000000-0000-4000-8000-000000000092";
		supervisor.request.mockImplementation(async (request) => ({
			jsonrpc: "2.0",
			id: request.id,
			result:
				request.method === "session/subscribe"
					? {
							snapshot: {
								session:
									request.params.sessionId === codeSessionId
										? { sessionId: codeSessionId, mode: "code", cwd: "/work/project" }
										: { sessionId: chatSessionId, mode: "chat", cwd: "/work/chat" },
							},
						}
					: {},
		}));
		const workspaceFiles = {
			authorize: vi.fn(),
			revoke: vi.fn(),
			clear: vi.fn(),
			listDirectory: vi.fn(async () => [{ name: "src", relativePath: "src", kind: "directory" as const }]),
			search: vi.fn(async () => ["src/App.tsx"]),
			readFile: vi.fn(async () => ({
				kind: "text" as const,
				relativePath: "README.md",
				absolutePath: "/work/project/README.md",
				byteLength: 4,
				text: "read",
				revision: "a".repeat(64),
			})),
			readPreviewBytes: vi.fn(async () => ({ ok: false as const, reason: "not-found" as const })),
			writeFile: vi.fn(async () => ({ revision: "b".repeat(64), byteLength: 7 })),
			openFile: vi.fn(async () => undefined),
			mutateEntry: vi.fn(async () => ({
				action: "create" as const,
				kind: "file" as const,
				relativePath: "new.ts",
				absolutePath: "/work/project/new.ts",
			})),
			getReview: vi.fn(async () => ({
				kind: "review" as const,
				repositoryRoot: "/work/project",
				branch: "main",
				head: "a".repeat(40),
				revision: "working-tree",
				files: [],
				commits: [],
			})),
			getReviewFileDiff: vi.fn(async () => ({ kind: "text" as const, patch: "@@ -1 +1 @@" })),
			getReviewFileContext: vi.fn(async () => ({
				kind: "text" as const,
				oldFile: { name: "README.md", contents: "old", cacheKey: "old" },
				newFile: { name: "README.md", contents: "new", cacheKey: "new" },
			})),
		};
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor, workspaceFiles });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		workspaceFiles.clear.mockClear();
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const openSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.openSession)!;

		await openSession(event, { sessionId: codeSessionId });
		expect(workspaceFiles.authorize).toHaveBeenCalledWith(codeSessionId, "/work/project");
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.listWorkspaceDirectory)!(event, {
				sessionId: codeSessionId,
				relativePath: "",
			}),
		).resolves.toEqual([{ name: "src", relativePath: "src", kind: "directory" }]);
		expect(workspaceFiles.listDirectory).toHaveBeenCalledWith({ sessionId: codeSessionId, relativePath: "" });
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.readWorkspaceFile)!(event, {
				sessionId: codeSessionId,
				relativePath: "../outside",
			}),
		).rejects.toThrow("Invalid workspace relative path");
		expect(workspaceFiles.readFile).not.toHaveBeenCalled();
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.writeWorkspaceFile)!(event, {
				sessionId: codeSessionId,
				relativePath: "README.md",
				text: "changed",
				expectedRevision: "a".repeat(64),
			}),
		).resolves.toEqual({ revision: "b".repeat(64), byteLength: 7 });
		expect(workspaceFiles.writeFile).toHaveBeenCalledWith({
			sessionId: codeSessionId,
			relativePath: "README.md",
			text: "changed",
			expectedRevision: "a".repeat(64),
		});
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.mutateWorkspaceEntry)!(event, {
				action: "create",
				sessionId: codeSessionId,
				parentRelativePath: "",
				name: "new.ts",
				kind: "file",
			}),
		).resolves.toMatchObject({ action: "create", relativePath: "new.ts" });
		expect(workspaceFiles.mutateEntry).toHaveBeenCalledWith({
			action: "create",
			sessionId: codeSessionId,
			parentRelativePath: "",
			name: "new.ts",
			kind: "file",
		});
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getWorkspaceReview)!(event, {
				sessionId: codeSessionId,
				revision: "working-tree",
			}),
		).resolves.toMatchObject({ kind: "review", branch: "main" });
		expect(workspaceFiles.getReview).toHaveBeenCalledWith({
			sessionId: codeSessionId,
			revision: "working-tree",
		});
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getWorkspaceReviewFileDiff)!(event, {
				sessionId: codeSessionId,
				revision: "a".repeat(40),
				relativePath: "README.md",
			}),
		).resolves.toMatchObject({ kind: "text", patch: expect.stringContaining("@@") });
		expect(workspaceFiles.getReviewFileDiff).toHaveBeenCalledWith({
			sessionId: codeSessionId,
			revision: "a".repeat(40),
			relativePath: "README.md",
		});
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getWorkspaceReviewFileContext)!(event, {
				sessionId: codeSessionId,
				revision: "working-tree",
				relativePath: "README.md",
			}),
		).resolves.toMatchObject({ kind: "text", oldFile: { contents: "old" }, newFile: { contents: "new" } });
		expect(workspaceFiles.getReviewFileContext).toHaveBeenCalledWith({
			sessionId: codeSessionId,
			revision: "working-tree",
			relativePath: "README.md",
		});
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getWorkspaceReviewFileContext)!(event, {
				sessionId: codeSessionId,
				revision: "working-tree",
				relativePath: "../outside",
			}),
		).rejects.toThrow("Invalid workspace relative path");
		expect(workspaceFiles.getReviewFileContext).toHaveBeenCalledTimes(1);
		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getWorkspaceReview)!(event, {
				sessionId: codeSessionId,
				revision: "HEAD",
			}),
		).rejects.toThrow("Invalid workspace review revision");
		expect(workspaceFiles.getReview).toHaveBeenCalledTimes(1);
		await ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.deleteProject)!(event, {
			requestId: "11111111-1111-4111-8111-111111111391",
			mode: "code",
			cwd: "/work/project",
			expectedRevision: "a".repeat(64),
		});
		expect(workspaceFiles.revoke).toHaveBeenCalledWith(codeSessionId);

		await openSession(event, { sessionId: chatSessionId });
		expect(workspaceFiles.revoke).toHaveBeenCalledWith(chatSessionId);
		await ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.deleteSession)!(event, {
			sessionId: chatSessionId,
			requestId: "11111111-1111-4111-8111-111111111392",
		});
		expect(workspaceFiles.revoke).toHaveBeenCalledWith(chatSessionId);

		setView({ state: "restarting" });
		expect(workspaceFiles.clear).toHaveBeenCalledTimes(1);
		webContents.emit("did-start-navigation", {}, "app://renderer/index.html", false, true);
		expect(workspaceFiles.clear).toHaveBeenCalledTimes(2);
		broker.dispose();
		expect(workspaceFiles.clear).toHaveBeenCalledTimes(3);
	});

	it("maps only typed calls and revalidates their parameters in main", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		supervisor.request.mockImplementation(async (request) => {
			let result: unknown = { sessions: [], nextAfterSessionId: null };
			if (request.method === "skill/list") result = { skills: [{ name: "pdf", description: "Read PDF files" }] };
			if (request.method === "skill/get" || request.method === "skill/upsert") {
				result = {
					name: request.params.name,
					description: "Write implementation plans",
					source: request.params.source,
					revision: "b".repeat(64),
					directoryPath: "/safe/user/skills/writing-plans",
					entryFile: "SKILL.md",
					files: ["SKILL.md"],
					content: "---\nname: writing-plans\ndescription: Write implementation plans\n---\n\nWrite plans.",
					instructions: "Write plans.",
					updatedAt: "2026-08-11T00:00:00.000Z",
					editable: true,
				};
			}
			if (request.method === "skill/remove") result = { skills: [] };
			if (request.method === "skill/import/inspect") {
				result = {
					revision: "c".repeat(64),
					candidates: [{ id: "demo", name: "demo", description: "Demo Skill", fileCount: 1 }],
				};
			}
			if (request.method === "skill/import") result = { skills: [] };
			if (request.method === "mcp/list" || request.method === "mcp/upsert" || request.method === "mcp/remove") {
				result = { servers: [] };
			}
			if (request.method === "mcp/import/inspect") {
				result = {
					sourceRevision: "d".repeat(64),
					candidates: [
						{
							id: "docs",
							name: "docs",
							transport: "http",
							enabled: true,
							existingRevision: null,
							bearerTokenConfigured: false,
							credentialNames: [],
						},
					],
				};
			}
			if (request.method === "mcp/import") result = { servers: [] };
			if (request.method === "mcp/catalog/get") {
				result = { kind: "tool", id: "search", name: "Search", inputSchema: '{"type":"object"}' };
			}
			if (
				request.method === "mcp/get" ||
				request.method === "mcp/restart" ||
				request.method === "mcp/credential/set" ||
				request.method === "mcp/credential/clear"
			) {
				result = {
					server: {
						name: "web",
						scope: "user",
						effective: true,
						revision: "a".repeat(64),
						transport: "http",
						enabled: true,
						required: false,
						url: "https://mcp.example.test/rpc",
						disabledTools: [],
						state: "inactive",
						credentialConfigured: false,
						toolCount: 0,
						resourceCount: 0,
						resourceTemplateCount: 0,
						promptCount: 0,
						capabilities: [],
					},
					tools: [],
					resources: [],
					resourceTemplates: [],
					prompts: [],
				};
			}
			if (request.method === "profile/get") {
				result = {
					generatedAt: "2026-08-01T12:00:00.000Z",
					totalTokens: 0,
					peakDailyTokens: 0,
					longestSessionMs: 0,
					currentStreakDays: 0,
					longestStreakDays: 0,
					sessionCount: 0,
					usedSkillCount: 0,
					skillUseCount: 0,
					activity: [],
					topSkills: [],
				};
			}
			if (request.method === "model/settings/get" || request.method === "model/settings/update") {
				result = { defaultModel: null, defaultThinkingSelection: "medium", providers: [], loadError: null };
			}
			if (request.method === "personalization/get") result = { instructions: "" };
			if (request.method === "personalization/update") result = { instructions: request.params.instructions };
			if (request.method === "model/testConnection") {
				result = { ok: true, message: "Connection succeeded", latencyMs: 12 };
			}
			if (request.method === "usage/get") {
				result = {
					generatedAt: "2026-08-08T12:00:00.000Z",
					rangeDays: request.params.rangeDays,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					chatTokens: 0,
					codeTokens: 0,
					sessionCount: 0,
					chatSessionCount: 0,
					codeSessionCount: 0,
					daily: [],
					topModels: [],
				};
			}
			if (request.method === "project/deletePreview") {
				result = {
					mode: request.params.mode,
					cwd: request.params.cwd,
					sessionCount: 2,
					blockingScheduleCount: 0,
					revision: "a".repeat(64),
				};
			}
			if (request.method === "project/delete") {
				result = { mode: request.params.mode, cwd: request.params.cwd, deletedSessionCount: 2 };
			}
			if (request.method === "session/rename") {
				result = {
					session: {
						sessionId: request.params.sessionId,
						mode: "chat",
						cwdOrigin: "user-selected",
						cwd: "/work/project",
						name: request.params.name,
						createdAt: "2026-07-30T00:00:00.000Z",
						updatedAt: "2026-07-30T00:00:00.000Z",
						state: "idle",
						archived: false,
					},
				};
			}
			if (request.method === "session/delete") {
				result = { sessionId: request.params.sessionId, deleted: true, method: "trash" };
			}
			if (request.method === "session/setPermissionMode") {
				result = { permissionMode: request.params.permissionMode };
			}
			if (request.method.startsWith("permission/rules/")) {
				result = { projectPath: "/work/project", rules: [] };
			}
			if (request.method === "subagent/interrupt") {
				result = {
					subagent: {
						agentId: request.params.agentId,
						name: "Child",
						status: "closed",
						taskSummary: "Test child",
						createdAt: "2026-07-30T00:00:00.000Z",
						updatedAt: "2026-07-30T00:00:00.000Z",
					},
				};
			}
			return { jsonrpc: "2.0", id: request.id, result };
		});
		const writeClipboardText = vi.fn();
		const setWorkspaceEditState = vi.fn();
		const openPath = vi.fn(async () => "");
		const broker = new ClientBroker({
			ipcMain: ipcMain as never,
			supervisor,
			writeClipboardText,
			setWorkspaceEditState,
			openPath,
		});
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const listSessions = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.listSessions)!;
		const listSkills = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.listSkills)!;
		const getSkill = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getSkill)!;
		const upsertSkill = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.upsertSkill)!;
		const removeSkill = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.removeSkill)!;
		const inspectSkillImport = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.inspectSkillImport)!;
		const importSkills = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.importSkills)!;
		const openSkillFolder = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.openSkillFolder)!;
		const listMcpServers = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.listMcpServers)!;
		const getProfile = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getProfile)!;
		const getModelSettings = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getModelSettings)!;
		const updateModelSettings = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.updateModelSettings)!;
		const getPersonalization = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getPersonalization)!;
		const updatePersonalization = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.updatePersonalization)!;
		const testModelConnection = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.testModelConnection)!;
		const getUsage = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getUsage)!;
		const previewProjectDelete = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.previewProjectDelete)!;
		const deleteProject = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.deleteProject)!;
		const renameSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.renameSession)!;
		const deleteSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.deleteSession)!;
		const setPermissionMode = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.setPermissionMode)!;
		const listPermissionRules = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.listPermissionRules)!;
		const deletePermissionRule = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.deletePermissionRule)!;
		const clearPermissionRules = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.clearPermissionRules)!;
		const interruptSubagent = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.interruptSubagent)!;
		const copyText = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.writeClipboardText)!;
		const reportEditState = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.setWorkspaceEditState)!;

		await expect(copyText(event, { text: "copied" })).resolves.toBeUndefined();
		expect(writeClipboardText).toHaveBeenCalledWith("copied");
		await expect(copyText(event, { text: "copied", extra: true })).rejects.toThrow("Invalid clipboard write input");
		await expect(
			reportEditState(event, { dirty: true, language: "zh", visibleSessionId: "session-1" }),
		).resolves.toBeUndefined();
		expect(setWorkspaceEditState).toHaveBeenCalledWith({
			dirty: true,
			language: "zh",
			visibleSessionId: "session-1",
		});
		await expect(reportEditState(event, { dirty: true, language: "zh-CN", visibleSessionId: null })).rejects.toThrow(
			"Invalid workspace edit state",
		);

		await expect(listSessions(event, { limit: 0 })).rejects.toThrow("Invalid session/list params");
		expect(supervisor.request).not.toHaveBeenCalled();
		await expect(listSessions(event, { limit: 1 })).resolves.toEqual({
			sessions: [],
			nextAfterSessionId: null,
		});
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "session/list", params: { limit: 1 } }),
		);
		await expect(listSkills(event, { sessionId: "session", cwd: "/tmp" })).rejects.toThrow(
			"Invalid skill/list params",
		);
		await expect(listSkills(event, { cwd: null })).resolves.toEqual({
			skills: [{ name: "pdf", description: "Read PDF files" }],
		});
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "skill/list", params: { cwd: null } }),
		);
		const skillTarget = { cwd: null, source: "user", name: "writing-plans" } as const;
		await expect(getSkill(event, skillTarget)).resolves.toMatchObject({ name: "writing-plans", source: "user" });
		const skillUpsert = {
			...skillTarget,
			requestId: "20000000-0000-4000-8000-000000000001",
			expectedRevision: null,
			content: "---\nname: writing-plans\ndescription: Write implementation plans\n---\n\nWrite plans.",
		};
		await expect(upsertSkill(event, skillUpsert)).resolves.toMatchObject({ name: "writing-plans" });
		await expect(
			removeSkill(event, {
				...skillTarget,
				requestId: "20000000-0000-4000-8000-000000000002",
				expectedRevision: "b".repeat(64),
			}),
		).resolves.toEqual({ skills: [] });
		const importInput = { cwd: null, source: "user", input: { kind: "archive", path: "/tmp/demo.skill" } } as const;
		await expect(inspectSkillImport(event, importInput)).resolves.toMatchObject({ candidates: [{ name: "demo" }] });
		await expect(
			importSkills(event, {
				...importInput,
				requestId: "20000000-0000-4000-8000-000000000003",
				sourceRevision: "c".repeat(64),
				candidateIds: ["demo"],
			}),
		).resolves.toEqual({ skills: [] });
		await expect(
			inspectSkillImport(event, {
				...importInput,
				input: { kind: "github", url: "https://example.com/acme/skills" },
			}),
		).rejects.toThrow("Invalid skill/import/inspect params");
		for (const invalid of [
			{ path: "/etc" },
			{ ...skillTarget, extra: true },
			{ ...skillTarget, source: "temporary" },
			{ cwd: null, source: "project", name: "writing-plans" },
		]) {
			await expect(openSkillFolder(event, invalid)).rejects.toThrow("Invalid skill/get params");
		}
		expect(openPath).not.toHaveBeenCalled();
		await expect(openSkillFolder(event, skillTarget)).resolves.toBeUndefined();
		expect(openPath).toHaveBeenCalledWith("/safe/user/skills/writing-plans");
		const mcpInputs = [
			[DESKTOP_IPC_CHANNELS.listMcpServers, "mcp/list", { cwd: null }],
			[
				DESKTOP_IPC_CHANNELS.inspectMcpImport,
				"mcp/import/inspect",
				{
					cwd: null,
					scope: "user",
					text: '{"mcpServers":{"docs":{"url":"https://mcp.example.test"}}}',
				},
			],
			[
				DESKTOP_IPC_CHANNELS.importMcpServers,
				"mcp/import",
				{
					requestId: "10000000-0000-4000-8000-000000000000",
					cwd: null,
					scope: "user",
					text: '{"mcpServers":{"docs":{"url":"https://mcp.example.test"}}}',
					sourceRevision: "d".repeat(64),
					candidates: [{ id: "docs", expectedRevision: null }],
				},
			],
			[DESKTOP_IPC_CHANNELS.getMcpServer, "mcp/get", { cwd: null, scope: "user", name: "web" }],
			[
				DESKTOP_IPC_CHANNELS.getMcpCatalogItem,
				"mcp/catalog/get",
				{
					sessionId: "11111111-1111-4111-8111-111111111111",
					server: "web",
					kind: "tool",
					id: "search",
				},
			],
			[
				DESKTOP_IPC_CHANNELS.upsertMcpServer,
				"mcp/upsert",
				{
					requestId: "10000000-0000-4000-8000-000000000001",
					cwd: null,
					scope: "user",
					name: "web",
					expectedRevision: null,
					server: { transport: "http", url: "https://mcp.example.test/rpc" },
				},
			],
			[
				DESKTOP_IPC_CHANNELS.removeMcpServer,
				"mcp/remove",
				{
					requestId: "10000000-0000-4000-8000-000000000002",
					cwd: null,
					scope: "user",
					name: "web",
					expectedRevision: "a".repeat(64),
				},
			],
			[
				DESKTOP_IPC_CHANNELS.restartMcpServer,
				"mcp/restart",
				{
					requestId: "10000000-0000-4000-8000-000000000003",
					sessionId: "11111111-1111-4111-8111-111111111111",
					scope: "user",
					name: "web",
					expectedRevision: "a".repeat(64),
				},
			],
			[
				DESKTOP_IPC_CHANNELS.clearMcpCredential,
				"mcp/credential/clear",
				{
					requestId: "10000000-0000-4000-8000-000000000004",
					sessionId: "11111111-1111-4111-8111-111111111111",
					scope: "user",
					name: "web",
					expectedRevision: "a".repeat(64),
				},
			],
			[
				DESKTOP_IPC_CHANNELS.setMcpCredential,
				"mcp/credential/set",
				{
					requestId: "10000000-0000-4000-8000-000000000005",
					sessionId: "11111111-1111-4111-8111-111111111111",
					scope: "user",
					name: "web",
					expectedRevision: "a".repeat(64),
					credential: { bearerToken: "secret" },
				},
			],
		] as const;
		await expect(listMcpServers(event, { cwd: null, unexpected: true })).rejects.toThrow("Invalid mcp/list params");
		for (const [channel, method, input] of mcpInputs) {
			await expect(ipcMain.handlers.get(channel)!(event, input)).resolves.toBeDefined();
			expect(supervisor.request).toHaveBeenLastCalledWith(expect.objectContaining({ method, params: input }));
		}
		await expect(getProfile(event, { unexpected: true })).rejects.toThrow("Invalid profile/get params");
		await expect(getProfile(event, {})).resolves.toMatchObject({ totalTokens: 0, topSkills: [] });
		expect(supervisor.request).toHaveBeenCalledWith(expect.objectContaining({ method: "profile/get", params: {} }));
		await expect(getModelSettings(event, { unexpected: true })).rejects.toThrow("Invalid model/settings/get params");
		await expect(getModelSettings(event, {})).resolves.toMatchObject({ providers: [], loadError: null });
		await expect(
			updateModelSettings(event, {
				requestId: "bad",
				mutation: { type: "set_defaults", model: null, thinkingSelection: "medium" },
			}),
		).rejects.toThrow("Invalid model/settings/update params");
		await expect(
			updateModelSettings(event, {
				requestId: "11111111-1111-4111-8111-111111111321",
				mutation: { type: "set_defaults", model: null, thinkingSelection: "medium" },
			}),
		).resolves.toMatchObject({ defaultModel: null });
		await expect(getPersonalization(event, {})).resolves.toEqual({ instructions: "" });
		await expect(getPersonalization(event, { extra: true })).rejects.toThrow("Invalid personalization/get params");
		await expect(updatePersonalization(event, { instructions: "Be concise." })).resolves.toEqual({
			instructions: "Be concise.",
		});
		await expect(updatePersonalization(event, { instructions: "Be concise.", extra: true })).rejects.toThrow(
			"Invalid personalization/update params",
		);
		await expect(
			testModelConnection(event, {
				requestId: "11111111-1111-4111-8111-111111111322",
				provider: "openai",
				modelId: "gpt-5",
			}),
		).resolves.toMatchObject({ ok: true, latencyMs: 12 });
		await expect(getUsage(event, { rangeDays: 31 })).rejects.toThrow("Invalid usage/get params");
		await expect(getUsage(event, { rangeDays: 7 })).resolves.toMatchObject({ rangeDays: 7, totalTokens: 0 });
		await expect(previewProjectDelete(event, { mode: "all", cwd: "/work/project" })).rejects.toThrow(
			"Invalid project/deletePreview params",
		);
		await expect(previewProjectDelete(event, { mode: "chat", cwd: "/work/project" })).resolves.toMatchObject({
			ok: true,
			result: { mode: "chat", cwd: "/work/project", sessionCount: 2 },
		});
		const deleteInput = {
			requestId: "11111111-1111-4111-8111-111111111301",
			mode: "chat",
			cwd: "/work/project",
			expectedRevision: "a".repeat(64),
		};
		await expect(deleteProject(event, { ...deleteInput, expectedRevision: "short" })).rejects.toThrow(
			"Invalid project/delete params",
		);
		await expect(deleteProject(event, deleteInput)).resolves.toEqual({
			ok: true,
			result: { mode: "chat", cwd: "/work/project", deletedSessionCount: 2 },
		});
		const sessionInput = {
			sessionId: "session-a",
			requestId: "11111111-1111-4111-8111-111111111402",
		};
		await expect(renameSession(event, { ...sessionInput, name: "" })).rejects.toThrow(
			"Invalid session/rename params",
		);
		await expect(renameSession(event, { ...sessionInput, name: "Renamed" })).resolves.toMatchObject({
			session: { sessionId: "session-a", name: "Renamed" },
		});
		await expect(deleteSession(event, sessionInput)).resolves.toEqual({
			sessionId: "session-a",
			deleted: true,
			method: "trash",
		});
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "session/delete", params: sessionInput }),
		);
		const permissionInput = {
			sessionId: "session-a",
			requestId: "11111111-1111-4111-8111-111111111401",
			permissionMode: "full",
		};
		await expect(setPermissionMode(event, { ...permissionInput, permissionMode: "automatic" })).rejects.toThrow(
			"Invalid session/setPermissionMode params",
		);
		await expect(setPermissionMode(event, { ...permissionInput, permissionMode: "auto" })).resolves.toEqual({
			permissionMode: "auto",
		});
		await expect(setPermissionMode(event, permissionInput)).resolves.toEqual({ permissionMode: "full" });
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "session/setPermissionMode", params: permissionInput }),
		);
		await expect(listPermissionRules(event, { sessionId: "session-a", projectPath: "/forged" })).rejects.toThrow(
			"Invalid permission/rules/list params",
		);
		await expect(listPermissionRules(event, { sessionId: "session-a" })).resolves.toEqual({
			projectPath: "/work/project",
			rules: [],
		});
		const ruleMutation = {
			sessionId: "session-a",
			requestId: "11111111-1111-4111-8111-111111111404",
		};
		await expect(deletePermissionRule(event, { ...ruleMutation, ruleId: "" })).rejects.toThrow(
			"Invalid permission/rules/delete params",
		);
		await expect(deletePermissionRule(event, { ...ruleMutation, ruleId: "a".repeat(64) })).resolves.toMatchObject({
			projectPath: "/work/project",
		});
		await expect(clearPermissionRules(event, ruleMutation)).resolves.toMatchObject({ projectPath: "/work/project" });
		const subagentInput = {
			sessionId: "session-a",
			agentId: "child-a",
			requestId: "11111111-1111-4111-8111-111111111403",
		};
		await expect(interruptSubagent(event, { ...subagentInput, agentId: "" })).rejects.toThrow(
			"Invalid subagent/interrupt params",
		);
		await expect(interruptSubagent(event, subagentInput)).resolves.toMatchObject({
			subagent: { agentId: "child-a", status: "closed" },
		});
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "subagent/interrupt", params: subagentInput }),
		);
		supervisor.request.mockImplementationOnce(async (request) => ({
			jsonrpc: "2.0",
			id: request.id,
			error: { code: -32009, message: "Session is already in use" },
		}));
		await expect(deleteProject(event, deleteInput)).resolves.toEqual({
			ok: false,
			error: { code: -32009, message: "Session is already in use" },
		});
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "project/deletePreview", params: { mode: "chat", cwd: "/work/project" } }),
		);
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "project/delete", params: deleteInput }),
		);
		broker.dispose();
		expect(setWorkspaceEditState).toHaveBeenLastCalledWith({ dirty: false, language: "en", visibleSessionId: null });
	});

	it("keeps the current subscription when opening the replacement session fails", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const currentSessionId = "11111111-1111-4111-8111-111111111201";
		const replacementSessionId = "11111111-1111-4111-8111-111111111202";
		supervisor.request.mockImplementation(async (request) => {
			if (request.method === "session/open" && request.params.sessionId === replacementSessionId) {
				throw new Error("replacement open failed");
			}
			return {
				jsonrpc: "2.0",
				id: request.id,
				result:
					request.method === "session/subscribe"
						? { snapshot: { session: { sessionId: request.params.sessionId } } }
						: {},
			};
		});
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const openSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.openSession)!;

		await expect(openSession(event, { sessionId: currentSessionId })).resolves.toEqual({
			session: { sessionId: currentSessionId },
		});
		supervisor.request.mockClear();
		await expect(openSession(event, { sessionId: replacementSessionId })).rejects.toThrow("replacement open failed");

		expect(supervisor.request).not.toHaveBeenCalledWith(
			expect.objectContaining({ method: "session/unsubscribe", params: { sessionId: currentSessionId } }),
		);
		broker.dispose();
	});

	it("cancels hidden interactions only after the replacement session is subscribed", async () => {
		const ipcMain = new FakeIpcMain();
		const { emitMessage, supervisor } = supervisorHarness();
		const currentSessionId = "11111111-1111-4111-8111-111111111211";
		const replacementSessionId = "11111111-1111-4111-8111-111111111212";
		let interactionDuringUnsubscribe: unknown;
		supervisor.request.mockImplementation(async (request) => {
			if (request.method === "session/unsubscribe" && interactionDuringUnsubscribe) {
				emitMessage(interactionDuringUnsubscribe);
			}
			return {
				jsonrpc: "2.0",
				id: request.id,
				result:
					request.method === "session/subscribe"
						? { snapshot: { session: { sessionId: request.params.sessionId } } }
						: {},
			};
		});
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const openSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.openSession)!;
		await ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.subscribe)!(event);
		await openSession(event, { sessionId: currentSessionId });

		const interactionRequest = {
			jsonrpc: "2.0" as const,
			id: "interaction-rpc-switch",
			method: "interaction/request" as const,
			params: {
				serverEpoch: "11111111-1111-4111-8111-111111111111",
				interaction: {
					interactionId: "33333333-3333-4333-8333-333333333311",
					sessionId: currentSessionId,
					title: "Confirm",
					message: "Continue?",
					createdAt: "2026-07-16T00:00:00.000Z",
					kind: "confirm" as const,
				},
			},
		};
		emitMessage(interactionRequest);
		interactionDuringUnsubscribe = {
			...interactionRequest,
			id: "interaction-rpc-switch-late",
			params: {
				...interactionRequest.params,
				interaction: {
					...interactionRequest.params.interaction,
					interactionId: "33333333-3333-4333-8333-333333333312",
				},
			},
		};
		supervisor.respondToServerRequest.mockClear();
		supervisor.request.mockClear();

		await openSession(event, { sessionId: replacementSessionId });

		const methods = supervisor.request.mock.calls.map(([request]) => request.method);
		expect(methods).toEqual(["session/open", "session/subscribe", "session/unsubscribe"]);
		expect(supervisor.respondToServerRequest).toHaveBeenCalledWith(
			interactionRequest,
			expect.objectContaining({ error: expect.objectContaining({ code: -32008 }) }),
		);
		expect(supervisor.respondToServerRequest).toHaveBeenCalledWith(
			interactionDuringUnsubscribe,
			expect.objectContaining({ error: expect.objectContaining({ code: -32008 }) }),
		);
		expect(supervisor.respondToServerRequest).toHaveBeenCalledTimes(2);
		broker.dispose();
	});

	it("retries a session unsubscribe that was lost during renderer navigation", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const currentSessionId = "11111111-1111-4111-8111-111111111221";
		const replacementSessionId = "11111111-1111-4111-8111-111111111222";
		let loseNextUnsubscribe = false;
		supervisor.request.mockImplementation(async (request) => {
			if (request.method === "session/unsubscribe" && loseNextUnsubscribe) {
				loseNextUnsubscribe = false;
				throw new Error("unsubscribe response lost");
			}
			return {
				jsonrpc: "2.0",
				id: request.id,
				result:
					request.method === "session/subscribe"
						? { snapshot: { session: { sessionId: request.params.sessionId } } }
						: {},
			};
		});
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const openSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.openSession)!;
		await openSession(event, { sessionId: currentSessionId });

		loseNextUnsubscribe = true;
		webContents.emit("did-start-navigation", {}, "app://renderer/index.html", false, true);
		await vi.waitFor(() => {
			expect(supervisor.request).toHaveBeenCalledWith(
				expect.objectContaining({ method: "session/unsubscribe", params: { sessionId: currentSessionId } }),
			);
		});
		supervisor.request.mockClear();

		await openSession(event, { sessionId: replacementSessionId });
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "session/unsubscribe", params: { sessionId: currentSessionId } }),
		);
		broker.dispose();
	});

	it("serializes renderer teardown before a replacement subscription", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const sessionId = "11111111-1111-4111-8111-111111111231";
		let releaseUnsubscribe!: () => void;
		const unsubscribeGate = new Promise<void>((resolve) => {
			releaseUnsubscribe = resolve;
		});
		supervisor.request.mockImplementation(async (request) => {
			if (request.method === "session/unsubscribe") await unsubscribeGate;
			return {
				jsonrpc: "2.0",
				id: request.id,
				result:
					request.method === "session/subscribe"
						? { snapshot: { session: { sessionId: request.params.sessionId } } }
						: {},
			};
		});
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const openSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.openSession)!;
		await openSession(event, { sessionId });
		supervisor.request.mockClear();

		webContents.emit("did-start-navigation", {}, "app://renderer/index.html", false, true);
		await vi.waitFor(() => {
			expect(supervisor.request).toHaveBeenCalledWith(
				expect.objectContaining({ method: "session/unsubscribe", params: { sessionId } }),
			);
		});
		const reopened = openSession(event, { sessionId });
		await Promise.resolve();
		expect(supervisor.request).not.toHaveBeenCalledWith(
			expect.objectContaining({ method: "session/open", params: { sessionId } }),
		);

		releaseUnsubscribe();
		await expect(reopened).resolves.toEqual({ session: { sessionId } });
		expect(supervisor.request.mock.calls.map(([request]) => request.method)).toEqual([
			"session/unsubscribe",
			"session/open",
			"session/subscribe",
		]);
		broker.dispose();
	});

	it("exposes only the guarded native project-folder picker", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const selectProjectFolder = vi.fn().mockResolvedValue("/tmp/project");
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor, selectProjectFolder });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const select = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.selectProjectFolder)!;

		await expect(select({ sender: webContents, senderFrame: webContents.mainFrame })).resolves.toBe("/tmp/project");
		expect(selectProjectFolder).toHaveBeenCalledOnce();
		broker.dispose();
	});

	it("returns only selected files through the guarded native file capability", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const selectAttachmentFiles = vi.fn().mockResolvedValue([
			{
				path: "/tmp/photo.png",
				name: "photo.png",
				previewDataUrl: "data:image/png;base64,cHJldmlldw==",
			},
		]);
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor, selectAttachmentFiles });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };

		await expect(ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.selectAttachmentFiles)!(event)).resolves.toEqual([
			{
				path: "/tmp/photo.png",
				name: "photo.png",
				previewDataUrl: "data:image/png;base64,cHJldmlldw==",
			},
		]);
		expect(selectAttachmentFiles).toHaveBeenCalledOnce();
		broker.dispose();
	});

	it("guards the default location and bounded project creation capabilities", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const getDefaultProjectLocation = vi.fn().mockResolvedValue("/Users/test/Metis Projects");
		const createProjectFolder = vi.fn().mockResolvedValue("/Users/test/Metis Projects/Demo");
		const broker = new ClientBroker({
			ipcMain: ipcMain as never,
			supervisor,
			getDefaultProjectLocation,
			createProjectFolder,
		});
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const input = { parentDirectory: "/Users/test/Metis Projects", name: "Demo", files: [] };

		await expect(ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.getDefaultProjectLocation)!(event)).resolves.toBe(
			"/Users/test/Metis Projects",
		);
		await expect(ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.createProjectFolder)!(event, input)).resolves.toBe(
			"/Users/test/Metis Projects/Demo",
		);
		expect(createProjectFolder).toHaveBeenCalledWith(input);
		await expect(ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.createProjectFolder)!(event)).rejects.toThrow(
			"Invalid desktop IPC arguments",
		);
		broker.dispose();
	});

	it("acknowledges each validated event batch without exposing ack to the renderer", async () => {
		const ipcMain = new FakeIpcMain();
		const { emitMessage, supervisor } = supervisorHarness();
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		await ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.subscribe)!({
			sender: webContents,
			senderFrame: webContents.mainFrame,
		});
		supervisor.request.mockClear();

		emitMessage({
			jsonrpc: "2.0",
			method: "connection/events",
			params: {
				serverEpoch: "11111111-1111-4111-8111-111111111111",
				fromCursor: 1,
				toCursor: 1,
				events: [{ type: "server/state", state: "ready" }],
			},
		});

		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "connection/ack",
				params: { serverEpoch: "11111111-1111-4111-8111-111111111111", cursor: 1 },
			}),
		);
		expect(Object.values(DESKTOP_IPC_CHANNELS)).not.toContain("metis:connection-ack");
		broker.dispose();
	});

	it("drops stale interactions and event batches across a supervisor reconnect", async () => {
		const ipcMain = new FakeIpcMain();
		const { emitMessage, setView, supervisor } = supervisorHarness();
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		await ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.subscribe)!({
			sender: webContents,
			senderFrame: webContents.mainFrame,
		});
		supervisor.request.mockClear();
		setView({ state: "restarting", serverEpoch: null, failure: "overloaded" });
		webContents.sent.length = 0;

		const interaction = {
			jsonrpc: "2.0" as const,
			id: "stale-interaction-rpc",
			method: "interaction/request" as const,
			params: {
				serverEpoch: "11111111-1111-4111-8111-111111111111",
				interaction: {
					interactionId: "22222222-2222-4222-8222-222222222222",
					sessionId: "session-1",
					title: "Confirm",
					message: "Continue?",
					createdAt: "2026-07-16T00:00:00.000Z",
					kind: "confirm" as const,
				},
			},
		};
		const events = {
			jsonrpc: "2.0" as const,
			method: "connection/events" as const,
			params: {
				serverEpoch: "11111111-1111-4111-8111-111111111111",
				fromCursor: 1,
				toCursor: 1,
				events: [{ type: "server/state" as const, state: "ready" as const }],
			},
		};

		expect(() => emitMessage(interaction)).not.toThrow();
		expect(() => emitMessage(events)).not.toThrow();
		expect(webContents.sent).toHaveLength(0);
		expect(supervisor.request).not.toHaveBeenCalled();

		setView({
			state: "ready",
			serverEpoch: "33333333-3333-4333-8333-333333333333",
			failure: null,
		});
		webContents.sent.length = 0;
		expect(() => emitMessage(events)).not.toThrow();
		expect(webContents.sent).toHaveLength(0);
		expect(supervisor.request).not.toHaveBeenCalled();
		broker.dispose();
	});

	it("cancels a pending interaction when its renderer reloads", async () => {
		const ipcMain = new FakeIpcMain();
		const { emitMessage, supervisor } = supervisorHarness();
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		await ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.subscribe)!({
			sender: webContents,
			senderFrame: webContents.mainFrame,
		});
		webContents.sent.length = 0;
		const request = {
			jsonrpc: "2.0" as const,
			id: "interaction-rpc-1",
			method: "interaction/request" as const,
			params: {
				serverEpoch: "11111111-1111-4111-8111-111111111111",
				interaction: {
					interactionId: "22222222-2222-4222-8222-222222222222",
					sessionId: "session-1",
					title: "Confirm",
					message: "Continue?",
					createdAt: "2026-07-16T00:00:00.000Z",
					kind: "confirm" as const,
				},
			},
		};

		emitMessage(request);
		expect(webContents.sent).toHaveLength(1);
		webContents.emit("did-start-navigation", {}, "app://renderer/index.html", false, true);

		expect(supervisor.respondToServerRequest).toHaveBeenCalledWith(
			request,
			expect.objectContaining({
				id: request.id,
				error: expect.objectContaining({ code: -32008 }),
			}),
		);
		broker.dispose();
	});

	it("clears an expired interaction from main and renderer state", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
		try {
			const ipcMain = new FakeIpcMain();
			const { emitMessage, supervisor } = supervisorHarness();
			const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
			const webContents = new FakeWebContents();
			broker.attach({ webContents: webContents as never });
			await ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.subscribe)!({
				sender: webContents,
				senderFrame: webContents.mainFrame,
			});
			webContents.sent.length = 0;
			const request = {
				jsonrpc: "2.0" as const,
				id: "interaction-rpc-2",
				method: "interaction/request" as const,
				params: {
					serverEpoch: "11111111-1111-4111-8111-111111111111",
					interaction: {
						interactionId: "33333333-3333-4333-8333-333333333333",
						sessionId: "session-1",
						title: "Confirm",
						message: "Continue?",
						createdAt: "2026-07-16T00:00:00.000Z",
						expiresAt: "2026-07-16T00:00:01.000Z",
						kind: "confirm" as const,
					},
				},
			};

			emitMessage(request);
			vi.advanceTimersByTime(1_000);

			expect(supervisor.respondToServerRequest).toHaveBeenCalledWith(
				request,
				expect.objectContaining({ error: expect.objectContaining({ code: -32008 }) }),
			);
			expect(webContents.sent).toContainEqual([
				"metis:event",
				{
					type: "interaction-cancelled",
					interactionId: "33333333-3333-4333-8333-333333333333",
				},
			]);
			broker.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports only validated current-epoch session summaries to the main process", async () => {
		const ipcMain = new FakeIpcMain();
		const { emitMessage, supervisor } = supervisorHarness();
		const onSessionUpdated = vi.fn();
		const updatedSession: SessionSummary = {
			sessionId: "session-1",
			name: "检查登录流程",
			mode: "code",
			cwdOrigin: "user-selected",
			cwd: "/tmp/project",
			createdAt: "2026-08-14T00:00:00.000Z",
			updatedAt: "2026-08-14T00:00:01.000Z",
			state: "idle",
			lastTurnOutcome: "completed",
			archived: false,
			unread: true,
		};
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor, onSessionUpdated });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });

		emitMessage({
			jsonrpc: "2.0",
			method: "connection/events",
			params: {
				serverEpoch: "11111111-1111-4111-8111-111111111111",
				fromCursor: 1,
				toCursor: 1,
				events: [{ type: "session/updated", session: updatedSession }],
			},
		});

		expect(onSessionUpdated).toHaveBeenCalledOnce();
		broker.dispose();
	});

	it("reports validated deleted session and project invalidations", () => {
		const ipcMain = new FakeIpcMain();
		const { emitMessage, supervisor } = supervisorHarness();
		const onSessionDeleted = vi.fn();
		const onProjectDeleted = vi.fn();
		const broker = new ClientBroker({
			ipcMain: ipcMain as never,
			supervisor,
			onSessionDeleted,
			onProjectDeleted,
		});

		emitMessage({
			jsonrpc: "2.0",
			method: "connection/events",
			params: {
				serverEpoch: "11111111-1111-4111-8111-111111111111",
				fromCursor: 1,
				toCursor: 3,
				events: [
					{ type: "session/invalidated", sessionId: "session-1", reason: "deleted" },
					{ type: "session/invalidated", sessionId: "session-2", reason: "reload_required" },
					{ type: "project/invalidated", mode: "code", cwd: "/tmp/project", reason: "deleted" },
				],
			},
		});

		expect(onSessionDeleted).toHaveBeenCalledExactlyOnceWith("session-1");
		expect(onProjectDeleted).toHaveBeenCalledExactlyOnceWith("code", "/tmp/project");
		broker.dispose();
	});

	it("tracks a trusted user interruption around the server request", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const onUserInterruptPending = vi.fn();
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor, onUserInterruptPending });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		supervisor.request.mockRejectedValueOnce(new Error("interrupt failed"));

		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.interruptTurn)!(
				{
					sender: webContents,
					senderFrame: webContents.mainFrame,
				},
				{ sessionId: "session-1", requestId: "00000000-0000-4000-8000-000000000001" },
			),
		).rejects.toThrow("interrupt failed");

		expect(onUserInterruptPending.mock.calls).toEqual([
			["session-1", true],
			["session-1", false],
		]);
		broker.dispose();
	});

	it("acknowledges the viewed session after a successful open", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const onSessionOpened = vi.fn();
		supervisor.request.mockImplementation(async (request) => ({
			jsonrpc: "2.0",
			id: request.id,
			result:
				request.method === "session/subscribe"
					? {
							snapshot: {
								session: {
									sessionId: "session-1",
									name: "检查登录流程",
									mode: "code",
									cwdOrigin: "user-selected",
									cwd: "/tmp/project",
									createdAt: "2026-08-14T00:00:00.000Z",
									updatedAt: "2026-08-14T00:00:01.000Z",
									state: "idle",
									lastTurnOutcome: "completed",
									archived: false,
									unread: false,
								},
							},
						}
					: {},
		}));
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor, onSessionOpened });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };

		await expect(
			ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.openSession)!(event, { sessionId: "session-1" }),
		).resolves.toMatchObject({ session: { sessionId: "session-1" } });

		expect(onSessionOpened).toHaveBeenCalledExactlyOnceWith("session-1");
		broker.dispose();
	});

	it("validates only exact open-session desktop events", () => {
		expect(validateDesktopApiEvent({ type: "open-session", sessionId: "session-1", mode: "code" })).toEqual({
			type: "open-session",
			sessionId: "session-1",
			mode: "code",
		});
		expect(validateDesktopApiEvent({ type: "open-session", sessionId: "session-1", mode: "chat" })).toEqual({
			type: "open-session",
			sessionId: "session-1",
			mode: "chat",
		});
		expect(() =>
			validateDesktopApiEvent({ type: "open-session", sessionId: "session-1", mode: "code", extra: true }),
		).toThrow("Invalid desktop event");
		expect(() => validateDesktopApiEvent({ type: "open-session", sessionId: "session-1", mode: "terminal" })).toThrow(
			"Invalid desktop event",
		);
		expect(() => validateDesktopApiEvent({ type: "open-session", sessionId: "", mode: "code" })).toThrow(
			"Invalid session id",
		);
	});

	it("queues notification navigation until the renderer subscribes", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });

		expect(broker.requestRendererOpenSession("session-1", "code")).toBe(false);
		expect(webContents.sent).not.toContainEqual([
			"metis:event",
			{ type: "open-session", sessionId: "session-1", mode: "code" },
		]);
		await ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.subscribe)!({
			sender: webContents,
			senderFrame: webContents.mainFrame,
		});
		expect(webContents.sent).toContainEqual([
			"metis:event",
			{ type: "open-session", sessionId: "session-1", mode: "code" },
		]);
		broker.dispose();
	});
});
