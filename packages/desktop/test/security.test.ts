import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveRendererAsset } from "../src/main/app-protocol-scheme.ts";
import { ClientBroker, isTrustedRendererUrl } from "../src/main/client-broker.ts";
import { DESKTOP_IPC_CHANNELS } from "../src/shared/desktop-api.ts";

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
	let stateListener: ((view: ReturnType<typeof supervisor.view>) => void) | undefined;
	let messageListener: ((message: unknown) => void) | undefined;
	const supervisor = {
		view: () => ({
			state: "ready" as const,
			serverEpoch: "11111111-1111-4111-8111-111111111111",
			restartAttempt: 0,
			failure: null,
		}),
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
	};
}

describe("desktop trust boundaries", () => {
	it("keeps the BrowserWindow sandboxed and denies ambient browser capabilities", () => {
		const windowSource = source("src/main/window.ts");
		expect(windowSource).toContain("contextIsolation: true");
		expect(windowSource).toContain("sandbox: true");
		expect(windowSource).toContain("nodeIntegration: false");
		expect(windowSource).toContain("webviewTag: false");
		expect(windowSource).not.toMatch(/enableRemoteModule|@electron\/remote/u);
		expect(windowSource).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
		expect(windowSource).toContain("will-navigate");
		expect(windowSource).toContain("will-redirect");
		expect(windowSource).toContain("will-attach-webview");
		expect(windowSource).toContain("setPermissionRequestHandler");
		expect(windowSource).toContain("setPermissionCheckHandler");
	});

	it("ships a strict production CSP and no renderer runtime imports", () => {
		const html = source("src/renderer/index.html");
		expect(html).toContain("default-src 'self'");
		expect(html).toContain("script-src 'self'");
		expect(html).not.toContain("'unsafe-eval'");
		expect(html).not.toContain("'unsafe-inline'");

		for (const rendererSource of rendererSources()) {
			expect(rendererSource).not.toMatch(
				/from\s+["'](?:node:|electron|@arcmind\/(?:agent|coding-agent|app-server))/u,
			);
		}
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

	it("maps only typed calls and revalidates their parameters in main", async () => {
		const ipcMain = new FakeIpcMain();
		const { supervisor } = supervisorHarness();
		supervisor.request.mockImplementation(async (request) => ({
			jsonrpc: "2.0",
			id: request.id,
			result: { sessions: [], nextAfterSessionId: null },
		}));
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const listSessions = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.listSessions)!;

		await expect(listSessions(event, { limit: 0 })).rejects.toThrow("Invalid session/list params");
		expect(supervisor.request).not.toHaveBeenCalled();
		await expect(listSessions(event, { limit: 1 })).resolves.toEqual({
			sessions: [],
			nextAfterSessionId: null,
		});
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "session/list", params: { limit: 1 } }),
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
		expect(Object.values(DESKTOP_IPC_CHANNELS)).not.toContain("arcmind:connection-ack");
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
				"arcmind:event",
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
});
