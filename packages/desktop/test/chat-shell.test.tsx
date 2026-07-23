// @vitest-environment jsdom

import type { SessionSnapshot, SessionSummary } from "@arcmind/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	App,
	firstInteractionForSession,
	sessionDisplayTitle,
	titleFromPrompt,
} from "../src/renderer/components/App.tsx";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { ArcMindDesktopApi } from "../src/shared/desktop-api.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";

function session(sessionId: string, mode: "chat" | "code", cwd: string, name: string): SessionSummary {
	return {
		sessionId,
		mode,
		cwdOrigin: "user-selected",
		cwd,
		name,
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
		state: "idle",
		archived: false,
	};
}

function snapshot(summary: SessionSummary): SessionSnapshot {
	return {
		session: summary,
		model: { provider: "test-provider", modelId: "test-model" },
		turns: [],
		recentItems: [],
		nextBeforeItemId: null,
		activeTurnId: null,
		pendingInteractions: [],
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		subagents: [],
		serverEpoch: EPOCH,
		cursor: 0,
	};
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function createHarness(options: {
	failFirstOpen?: boolean;
	failOpenSessionIds?: readonly string[];
	loseFirstCreateResponse?: boolean;
	loseFirstStartResponse?: boolean;
} = {}) {
	const chat = session("chat-existing", "chat", "/work/chat-project", "Chat project task");
	const code = session("code-existing", "code", "/work/code-project", "Code project task");
	let sessions = [chat, code];
	let failFirstOpen = options.failFirstOpen ?? false;
	let loseFirstCreateResponse = options.loseFirstCreateResponse ?? false;
	let loseFirstStartResponse = options.loseFirstStartResponse ?? false;
	const failOpenSessionIds = new Set(options.failOpenSessionIds ?? []);
	const createdByRequestId = new Map<string, SessionSummary>();
	const order: string[] = [];
	let subscriber: Parameters<ArcMindDesktopApi["subscribe"]>[0] | undefined;
	const api = {
		getServerState: vi.fn().mockResolvedValue({ state: "ready", serverEpoch: EPOCH, restartAttempt: 0, failure: null }),
		listSessions: vi.fn(async () => {
			order.push("list");
			return { sessions, nextAfterSessionId: null };
		}),
		selectProjectFolder: vi.fn().mockResolvedValue("/work/selected-project"),
		createSession: vi.fn(async (input) => {
			order.push("create");
			const created = createdByRequestId.get(input.requestId) ?? {
				...session("chat-created", "chat", input.cwd ?? "/managed/chat-created", input.name ?? "Untitled"),
				cwdOrigin: input.cwd ? "user-selected" : "managed",
			};
			if (!createdByRequestId.has(input.requestId)) {
				createdByRequestId.set(input.requestId, created);
				sessions = [created, ...sessions];
			}
			if (loseFirstCreateResponse) {
				loseFirstCreateResponse = false;
				throw new Error("create response lost");
			}
			return { session: created };
		}),
		openSession: vi.fn(async ({ sessionId }) => {
			order.push("open");
			if (failFirstOpen || failOpenSessionIds.delete(sessionId)) {
				failFirstOpen = false;
				throw new Error("open failed once");
			}
			const summary = sessions.find((candidate) => candidate.sessionId === sessionId);
			if (!summary) throw new Error("missing session");
			return snapshot(summary);
		}),
		startTurn: vi.fn(async () => {
			order.push("start");
			if (loseFirstStartResponse) {
				loseFirstStartResponse = false;
				throw new Error("start response lost");
			}
			return {};
		}),
		steerTurn: vi.fn().mockResolvedValue({}),
		interruptTurn: vi.fn().mockResolvedValue({}),
		readItems: vi.fn().mockResolvedValue({ items: [], nextBeforeItemId: null }),
		readSubagentItems: vi.fn().mockResolvedValue({ items: [], nextBeforeItemId: null }),
		setThinkingSelection: vi.fn().mockResolvedValue({}),
		respondToInteraction: vi.fn().mockResolvedValue(undefined),
		retryServer: vi.fn().mockResolvedValue(undefined),
		subscribe: vi.fn((listener) => {
			subscriber = listener;
			return () => {
				if (subscriber === listener) subscriber = undefined;
			};
		}),
	} as unknown as ArcMindDesktopApi;
	return { api, emitEvent: (event: Parameters<NonNullable<typeof subscriber>>[0]) => subscriber?.(event), order };
}

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	document.body.replaceChildren();
});

describe("Chat desktop shell", () => {
	it("builds a compact Unicode-safe title from the first prompt", () => {
		expect(titleFromPrompt("  分析这个项目\n carefully  ")).toBe("分析这个项目 carefully");
		expect(titleFromPrompt("🚀".repeat(49))).toBe(`${"🚀".repeat(47)}…`);
	});

	it("never exposes the managed workspace path as the session title", () => {
		expect(sessionDisplayTitle({ cwd: "/Users/example/.arcmind/agent/workspaces/session-id", cwdOrigin: "managed", name: "" })).toBe("Chat");
		expect(sessionDisplayTitle({ cwd: "/work/project", cwdOrigin: "user-selected", name: "" })).toBe("/work/project");
	});

	it("selects the first pending interaction for the visible session", () => {
		const other = {
			interactionId: "00000000-0000-4000-8000-000000000201",
			sessionId: "other-session",
			title: "Other",
			message: "Other session prompt",
			createdAt: "2026-07-20T00:00:00.000Z",
			kind: "confirm" as const,
		};
		const visible = {
			interactionId: "00000000-0000-4000-8000-000000000202",
			sessionId: "visible-session",
			title: "Visible",
			message: "Visible session prompt",
			createdAt: "2026-07-20T00:00:00.000Z",
			kind: "confirm" as const,
		};
		const interactions = new Map([
			[other.interactionId, other],
			[visible.interactionId, visible],
		]);

		expect(firstInteractionForSession(
			[other.interactionId, visible.interactionId],
			interactions,
			"visible-session",
		)).toBe(visible);
	});

	it("filters the initial Chat tree and creates the real session only on first send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api, order } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.textContent).toContain("Chat project task");
		expect(container.textContent).not.toContain("Code project task");
		expect(api.openSession).not.toHaveBeenCalled();
		await act(async () => button(container, "New task").click());
		expect(api.createSession).not.toHaveBeenCalled();

		await act(async () => button(container, "Work in a project or folder").click());
		await flush();
		expect(api.selectProjectFolder).toHaveBeenCalledTimes(1);
		expect(api.createSession).not.toHaveBeenCalled();
		expect(container.textContent).toContain("selected-project");

		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "  Analyze this repository\ncarefully  "));
		order.length = 0;
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "chat",
			cwd: "/work/selected-project",
			name: "Analyze this repository carefully",
		}));
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "Analyze this repository\ncarefully",
		}));
		expect(order).toEqual(["create", "list", "open", "start"]);

		await act(async () => root.unmount());
	});

	it("keeps a project group collapsed across unrelated renders", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const project = container.querySelector<HTMLDetailsElement>("details.project-group")!;
		expect(project.open).toBe(true);
		await act(async () => project.querySelector("summary")!.click());
		expect(project.open).toBe(false);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show tools sidebar"]')!.click());
		expect(container.querySelector<HTMLDetailsElement>("details.project-group")!.open).toBe(false);

		await act(async () => root.unmount());
	});

	it("does not submit while an input method editor is composing", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "还在组词"));

		await act(async () => {
			textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true }));
		});
		expect(api.createSession).not.toHaveBeenCalled();
		expect(textarea.value).toBe("还在组词");

		await act(async () => root.unmount());
	});

	it("keeps the draft after an open failure and retries without a second create", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ failFirstOpen: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Keep this draft"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(textarea.value).toBe("Keep this draft");
		expect(api.createSession).toHaveBeenCalledTimes(1);
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(api.startTurn).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("locks the selected folder after a draft session has been created", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ failFirstOpen: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Work in a project or folder").click());
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Keep the real folder"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		const folderButton = button(container, "selected-project");
		expect(folderButton.disabled).toBe(true);
		folderButton.click();
		expect(api.selectProjectFolder).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("keys a retried Chat turn request ID to its session and text", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ loseFirstStartResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;

		await act(async () => changeTextarea(textarea, "First payload"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(container.textContent).toContain("start response lost");

		await act(async () => changeTextarea(textarea, "Changed payload"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		const first = vi.mocked(api.startTurn).mock.calls[0]![0];
		const second = vi.mocked(api.startTurn).mock.calls[1]![0];
		expect(second.sessionId).toBe(first.sessionId);
		expect(second.text).toBe("Changed payload");
		expect(second.requestId).not.toBe(first.requestId);
		await act(async () => root.unmount());
	});

	it("reuses the Chat create request ID when the first response is lost", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ loseFirstCreateResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Retry the same create"));

		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(container.textContent).toContain("create response lost");
		expect(textarea.value).toBe("Retry the same create");

		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.createSession).mock.calls[1]![0].requestId).toBe(
			vi.mocked(api.createSession).mock.calls[0]![0].requestId,
		);
		expect(api.startTurn).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("reuses an active turn request ID when its first response is lost", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({ loseFirstStartResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Retry active turn"));

		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(container.textContent).toContain("start response lost");
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		expect(api.startTurn).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.startTurn).mock.calls[1]![0].requestId).toBe(
			vi.mocked(api.startTurn).mock.calls[0]![0].requestId,
		);
		await act(async () => root.unmount());
	});

	it("keeps the Chat home visible when opening a sidebar session fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ failOpenSessionIds: ["chat-existing"] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Chat project task").click());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(container.textContent).toContain("What can I take off your plate?");
		expect(container.textContent).not.toContain("ArcMind Code");
		await act(async () => root.unmount());
	});

	it("keeps the current session synchronized when reopening it fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();
		expect(store.getSnapshot().syncStatus).toBe("ready");
		vi.mocked(api.openSession).mockRejectedValueOnce(new Error("reopen failed"));

		await act(async () => button(container, "Chat project task").click());
		await flush();

		expect(container.textContent).toContain("reopen failed");
		expect(store.getSnapshot().activeSessionId).toBe("chat-existing");
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(localStorage.getItem("arcmind.activeSessionId.chat")).toBe("chat-existing");
		await act(async () => root.unmount());
	});

	it("resnapshots the current session when events race with a failed open", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();
		let rejectOpen!: (error: Error) => void;
		vi.mocked(api.openSession).mockImplementationOnce(
			() => new Promise((_resolve, reject) => {
				rejectOpen = reject;
			}),
		);

		act(() => button(container, "Chat project task").click());
		emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 1,
					events: [{ type: "server/state", state: "ready" }],
				},
			},
		});
		expect(store.getSnapshot().syncStatus).toBe("resnapshot_required");
		await act(async () => rejectOpen(new Error("switch failed")));
		await flush();

		expect(api.openSession).toHaveBeenCalledTimes(3);
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "chat-existing" });
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(container.textContent).toContain("switch failed");
		await act(async () => root.unmount());
	});

	it("keeps the Chat home visible when restoring its remembered session fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness({ failOpenSessionIds: ["chat-existing"] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		expect(container.querySelector(".mode-switch")?.getAttribute("data-mode")).toBe("chat");
		expect(container.querySelectorAll(".mode-switch-indicator")).toHaveLength(1);

		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.querySelector(".mode-switch")?.getAttribute("data-mode")).toBe("code");
		await act(async () => button(container, "Chat").click());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(container.textContent).toContain("What can I take off your plate?");
		expect(container.textContent).not.toContain("ArcMind Code");
		await act(async () => root.unmount());
	});

	it("does not flash the mode home while restoring its remembered session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(container.textContent).toContain("Chat project task");

		let resolveCodeOpen!: (value: SessionSnapshot) => void;
		vi.mocked(api.openSession).mockImplementationOnce(() => new Promise((resolve) => {
			resolveCodeOpen = resolve;
		}));
		act(() => button(container, "Code").click());

		expect(container.textContent).toContain("Chat project task");
		expect(container.textContent).not.toContain("ArcMind Code");

		await act(async () => resolveCodeOpen(snapshot(session("code-existing", "code", "/work/code-project", "Code project task"))));
		expect(container.textContent).toContain("Code project task");
		await act(async () => root.unmount());
	});

	it("does not expose a draft composer while the remembered session is bootstrapping", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		let resolveOpen!: (value: SessionSnapshot) => void;
		vi.mocked(api.openSession).mockImplementationOnce(
			() => new Promise((resolve) => {
				resolveOpen = resolve;
			}),
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.textContent).not.toContain("What can I take off your plate?");
		expect(container.querySelector("#composer-input")).toBeNull();

		await act(async () => resolveOpen(snapshot(session("chat-existing", "chat", "/work/chat-project", "Chat project task"))));
		expect(container.querySelector('[data-active-session-id="chat-existing"]')).not.toBeNull();
		expect(container.querySelector("#composer-input")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("shows an interaction required to finish remembered-session bootstrapping", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		vi.mocked(api.openSession).mockImplementationOnce(() => new Promise(() => undefined));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		act(() => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				id: "00000000-0000-4000-8000-000000000201",
				method: "interaction/request",
				params: {
					serverEpoch: EPOCH,
					interaction: {
						interactionId: "00000000-0000-4000-8000-000000000202",
						sessionId: "chat-existing",
						title: "Trust this project?",
						message: "Project resources can execute code.",
						createdAt: "2026-07-20T00:00:00.000Z",
						kind: "project_trust",
						projectPath: "/work/chat-project",
						choices: [{ id: "trust-once", label: "Trust (this session only)" }],
					},
				},
			},
		}));

		expect(container.textContent).toContain("Trust this project?");
		expect(container.textContent).not.toContain("What can I take off your plate?");
		expect(container.querySelector("#composer-input")).toBeNull();
		await act(async () => root.unmount());
	});

	it("restores the remembered session per mode and keeps Skills visual-only", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");

		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.textContent).toContain("Code project task");
		expect(container.textContent).not.toContain("Chat project task");
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "code-existing" });
		expect(container.textContent).toContain("test-model");

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Hide sessions sidebar"]')!.click());
		expect(container.querySelector(".session-sidebar")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show sessions sidebar"]')!.click());
		expect(container.querySelector(".session-sidebar")).not.toBeNull();
		expect(container.querySelector('[aria-label="Search"]')).not.toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show tools sidebar"]')!.click());
		expect(container.textContent).toContain("审阅");
		expect(container.textContent).toContain("文件");
		expect(container.textContent).toContain("Subagent");

		const backendCalls = vi.mocked(api.createSession).mock.calls.length + vi.mocked(api.openSession).mock.calls.length;
		await act(async () => button(container, "Skills").click());
		expect(container.textContent).toContain("Skills are coming to Desktop.");
		expect(vi.mocked(api.createSession).mock.calls.length + vi.mocked(api.openSession).mock.calls.length).toBe(backendCalls);

		await act(async () => button(container, "Chat").click());
		await flush();
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "chat-existing" });
		expect(container.textContent).toContain("Chat project task");
		expect(container.textContent).not.toContain("Code project task");
		expect(container.textContent).toContain("终端");
		expect(container.textContent).toContain("浏览器");
		expect(container.textContent).toContain("侧边任务");
		expect(container.textContent).not.toContain("审阅");
		expect(container.textContent).not.toContain("文件");
		expect(container.textContent).not.toContain("Subagent");
		await act(async () => root.unmount());
	});
});
