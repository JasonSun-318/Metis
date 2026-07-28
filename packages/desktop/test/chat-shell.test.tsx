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
		availableModels: [
			{ provider: "test-provider", modelId: "test-model", name: "Test model" },
			{ provider: "test-provider", modelId: "other-model", name: "Other model" },
		],
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
	const match = [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
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
		listSkills: vi.fn().mockResolvedValue({
			skills: [
				{ name: "pdf", description: "Read and create PDF documents" },
				{ name: "xlsx", description: "Read and create spreadsheets" },
			],
		}),
		selectProjectFolder: vi.fn().mockResolvedValue("/work/selected-project"),
		selectAttachmentFiles: vi.fn().mockResolvedValue([
			{ path: "/tmp/report.pdf", name: "report.pdf" },
		]),
		createSession: vi.fn(async (input) => {
			order.push("create");
			const createdMode = input.mode ?? "code";
			const created = createdByRequestId.get(input.requestId) ?? {
				...session(
					createdMode === "chat" ? "chat-created" : "code-created",
					createdMode,
					input.cwd ?? `/managed/${createdMode}-created`,
					input.name ?? "Untitled",
				),
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
		setModel: vi.fn().mockResolvedValue({}),
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
		expect(button(container, "New task").getAttribute("aria-current")).toBe("page");
		expect(container.querySelector('.session-button[aria-current="page"]')).toBeNull();

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

	it("creates an unfoldered Chat task only on its first send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.querySelectorAll("#composer-input")).toHaveLength(1);
		expect(container.querySelectorAll('[aria-label="Add to message"]')).toHaveLength(1);
		expect(api.createSession).not.toHaveBeenCalled();
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
		await act(async () => changeTextarea(textarea, "Start without a folder"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		const createInput = vi.mocked(api.createSession).mock.calls[0]![0];
		expect(createInput).toMatchObject({
			mode: "chat",
			name: "Start without a folder",
		});
		expect(createInput).not.toHaveProperty("cwd");
		expect(api.startTurn).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("keeps Code New task local until a folder-backed first send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api, order } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "New task").click());

		expect(container.textContent).toContain("What can I take off your plate?");
		expect(container.querySelectorAll("#composer-input")).toHaveLength(1);
		expect(container.querySelectorAll('[aria-label="Add to message"]')).toHaveLength(1);
		expect(container.querySelector(".model-control")?.textContent).toBe("Test model");
		expect(button(container, "Select effort, current Off")).not.toBeNull();
		expect(api.selectProjectFolder).not.toHaveBeenCalled();
		expect(api.createSession).not.toHaveBeenCalled();

		const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
		await act(async () => changeTextarea(textarea, "Inspect this repository"));
		expect(button(container, "Send message").disabled).toBe(true);
		await act(async () => button(container, "Work in a project or folder").click());
		await flush();
		expect(api.createSession).not.toHaveBeenCalled();
		expect(button(container, "Send message").disabled).toBe(false);

		order.length = 0;
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "code",
			cwd: "/work/selected-project",
			name: "Inspect this repository",
		}));
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "code-created",
			text: "Inspect this repository",
		}));
		expect(order).toEqual(["create", "list", "open", "start"]);
		await act(async () => root.unmount());
	});

	it("keeps the add menu in an existing Code session composer", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		vi.mocked(api.listSkills).mockClear();

		await act(async () => button(container, "Code").click());
		await flush();

		expect(container.querySelector('[data-active-session-id="code-existing"]')).not.toBeNull();
		expect(api.listSkills).toHaveBeenCalledWith({ sessionId: "code-existing" });
		expect(container.querySelectorAll('[aria-label="Add to message"]')).toHaveLength(1);
		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		expect(container.querySelector(".composer-skill-menu")?.textContent).toContain("pdf");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		expect(container.querySelector(".composer-chips")?.textContent).toContain("report.pdf");
		await act(async () => root.unmount());
	});

	it("clears skills while the newly visible session skills are loading", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		expect(container.querySelector(".composer-skill-menu")?.textContent).toContain("pdf");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

		vi.mocked(api.listSkills).mockImplementationOnce(() => new Promise(() => undefined));
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());

		expect(container.querySelector(".composer-skill-menu")?.textContent).not.toContain("pdf");
		await act(async () => root.unmount());
	});

	it("reports a failed interrupt without leaving an unhandled rejection", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		vi.mocked(api.openSession).mockImplementation(async ({ sessionId }) => {
			const summary = session(sessionId, "chat", "/work/chat-project", "Chat project task");
			return {
				...snapshot({ ...summary, state: "running" }),
				activeTurnId: "00000000-0000-4000-8000-000000000301",
			};
		});
		vi.mocked(api.interruptTurn).mockRejectedValueOnce(new Error("interrupt failed"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Stop task").click());
		await flush();

		expect(api.interruptTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "chat-existing" }));
		expect(container.textContent).toContain("interrupt failed");
		await act(async () => root.unmount());
	});

	it("submits selected files and one hidden skill on first Chat send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.querySelector('[aria-label="Add folder (coming soon)"]')).toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyU", metaKey: true })));
		await flush();
		expect(api.selectAttachmentFiles).toHaveBeenCalledTimes(1);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		expect(container.querySelector(".composer-add-menu > .composer-menu-separator")).not.toBeNull();
		expect(container.querySelector(".composer-menu-shortcut")?.textContent).toBe("⌘U");
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		expect(api.selectAttachmentFiles).toHaveBeenCalledTimes(2);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		const skillsButton = button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills");
		await act(async () => skillsButton.click());
		expect(skillsButton.classList.contains("is-active")).toBe(true);
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "pdf").click());

		expect(container.textContent).toContain("report.pdf");
		expect(container.querySelector('[aria-label="Remove skill pdf"]')).not.toBeNull();
		expect([...container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Browse skills")).toBe(false);
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Summarize this"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "/skill:pdf Summarize this",
			attachments: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
		}));
		await act(async () => root.unmount());
	});

	it("removes files, replaces the selected skill, closes with Escape, and routes Manage skills", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const add = () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!;
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove file report.pdf"]')!.click());
		expect(container.textContent).not.toContain("report.pdf");

		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "pdf").click());
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "xlsx").click());
		expect(container.querySelector('[aria-label="Remove skill pdf"]')).toBeNull();
		expect(container.querySelector('[aria-label="Remove skill xlsx"]')).not.toBeNull();

		await act(async () => add().click());
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(container.querySelector(".composer-add-menu")).toBeNull();

		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "Manage skills").click());
		expect(container.textContent).toContain("Skills are coming to Desktop.");
		await act(async () => root.unmount());
	});

	it("permits an attachment-only Chat send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		await act(async () => container.querySelector<HTMLTextAreaElement>("textarea")!.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			text: "",
			attachments: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
		}));
		await act(async () => root.unmount());
	});

	it("retains additions after a failed active send and changes replay identity with the file", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({ loseFirstStartResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(container.querySelector(".model-control")?.textContent).toBe("Test model");
		expect(button(container, "Select effort, current Off")).not.toBeNull();

		const add = () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!;
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "pdf").click());
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Same prompt"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		expect(textarea.value).toBe("Same prompt");
		expect(container.querySelector('[aria-label="Remove file report.pdf"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Remove skill pdf"]')).not.toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove file report.pdf"]')!.click());
		vi.mocked(api.selectAttachmentFiles).mockResolvedValueOnce([{ path: "/tmp/other.pdf", name: "other.pdf" }]);
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		const first = vi.mocked(api.startTurn).mock.calls[0]![0];
		const second = vi.mocked(api.startTurn).mock.calls[1]![0];
		expect(second.requestId).not.toBe(first.requestId);
		expect(second).toEqual(expect.objectContaining({
			text: "/skill:pdf Same prompt",
			attachments: [{ path: "/tmp/other.pdf", name: "other.pdf" }],
		}));
		expect(textarea.value).toBe("");
		expect(container.querySelector(".composer-chips")).toBeNull();
		await act(async () => root.unmount());
	});

	it("keeps an optimistic effort visible and resnapshots after a failed change", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const codeSnapshot = {
			...snapshot(session("code-existing", "code", "/work/code-project", "Code project task")),
			thinkingSelection: "high" as const,
			actualThinkingLevel: "high" as const,
			availableThinkingSelections: ["off", "low", "medium", "high", "ultra"] as const,
		};
		vi.mocked(api.openSession).mockResolvedValue(codeSnapshot);
		let rejectChange!: (reason: Error) => void;
		vi.mocked(api.setThinkingSelection).mockImplementation(() => new Promise((_resolve, reject) => {
			rejectChange = reject;
		}));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();

		const trigger = button(container, "Select effort, current High");
		await act(async () => trigger.click());
		const range = container.querySelector<HTMLInputElement>('.thinking-control input[type="range"]')!;
		await act(async () => {
			range.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(range, "3.8");
			range.dispatchEvent(new Event("input", { bubbles: true }));
			range.dispatchEvent(new Event("pointerup", { bubbles: true }));
			trigger.click();
		});

		expect(api.setThinkingSelection).toHaveBeenCalledWith(expect.objectContaining({ selection: "ultra" }));
		expect(trigger.textContent).toContain("Ultra");
		await act(async () => rejectChange(new Error("selection failed")));
		await flush();
		await flush();
		expect(trigger.textContent).toContain("High");
		expect(container.textContent).toContain("selection failed");
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

	it("keeps a folder-backed Code draft after its created session fails to open", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness({ failOpenSessionIds: ["code-created"] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "New task").click());
		await act(async () => button(container, "Work in a project or folder").click());
		await flush();

		const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
		await act(async () => changeTextarea(textarea, "Keep this Code draft"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(textarea.value).toBe("Keep this Code draft");
		expect(button(container, "selected-project").disabled).toBe(true);
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
		expect(container.textContent).toContain("Test model");
		expect(container.querySelector('[aria-label="Add to message"]')).not.toBeNull();

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
		expect(container.querySelector('[aria-label="Add to message"]')).not.toBeNull();
		await act(async () => root.unmount());
	});
});
