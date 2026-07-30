import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveRendererAsset } from "../src/main/app-protocol-scheme.ts";
import { ClientBroker, isTrustedRendererUrl } from "../src/main/client-broker.ts";
import { isSafeExternalUrl } from "../src/main/external-url.ts";
import { DESKTOP_IPC_CHANNELS, type SupervisorView } from "../src/shared/desktop-api.ts";

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
		expect(html).not.toContain("'unsafe-eval'");
		expect(html).not.toContain("'unsafe-inline'");

		for (const rendererSource of rendererSources()) {
			expect(rendererSource).not.toMatch(
				/from\s+["'](?:node:|electron|@arcmind\/(?:agent|coding-agent|app-server))/u,
			);
			expect(rendererSource).not.toMatch(/ipcRenderer|\.invoke\(|shell\.open|moveToTrash/u);
		}
		const preload = source("src/preload.ts");
		expect(preload).toContain('"project/deletePreview"');
		expect(preload).toContain('"project/delete"');
		expect(preload).toContain('"session/rename"');
		expect(preload).toContain('"session/delete"');
		expect(preload).not.toContain('exposeInMainWorld("arcMind", ipcRenderer');
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
		supervisor.request.mockImplementation(async (request) => {
			let result: unknown = { sessions: [], nextAfterSessionId: null };
			if (request.method === "skill/list") result = { skills: [{ name: "pdf", description: "Read PDF files" }] };
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
			return { jsonrpc: "2.0", id: request.id, result };
		});
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };
		const listSessions = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.listSessions)!;
		const listSkills = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.listSkills)!;
		const previewProjectDelete = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.previewProjectDelete)!;
		const deleteProject = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.deleteProject)!;
		const renameSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.renameSession)!;
		const deleteSession = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.deleteSession)!;
		const setPermissionMode = ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.setPermissionMode)!;

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
		await expect(setPermissionMode(event, { ...permissionInput, permissionMode: "auto" })).rejects.toThrow(
			"Invalid session/setPermissionMode params",
		);
		await expect(setPermissionMode(event, permissionInput)).resolves.toEqual({ permissionMode: "full" });
		expect(supervisor.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "session/setPermissionMode", params: permissionInput }),
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
		const selectAttachmentFiles = vi.fn().mockResolvedValue([{ path: "/tmp/report.pdf", name: "report.pdf" }]);
		const broker = new ClientBroker({ ipcMain: ipcMain as never, supervisor, selectAttachmentFiles });
		const webContents = new FakeWebContents();
		broker.attach({ webContents: webContents as never });
		const event = { sender: webContents, senderFrame: webContents.mainFrame };

		await expect(ipcMain.handlers.get(DESKTOP_IPC_CHANNELS.selectAttachmentFiles)!(event)).resolves.toEqual([
			{ path: "/tmp/report.pdf", name: "report.pdf" },
		]);
		expect(selectAttachmentFiles).toHaveBeenCalledOnce();
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
