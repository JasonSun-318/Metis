// @vitest-environment jsdom
import type { ClientResult, SessionProcessView } from "@metis/app-protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessPanel } from "../src/renderer/components/ProcessPanel.tsx";
import type { SessionChatViewContext } from "../src/renderer/components/SessionChatView.tsx";
import { SessionWorkspaceView } from "../src/renderer/components/SessionWorkspace.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const terminals = vi.hoisted(
	() => [] as Array<{ options: Record<string, unknown>; output: string; disposed: boolean }>,
);
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		output = "";
		disposed = false;
		options: Record<string, unknown>;
		constructor(options: Record<string, unknown>) {
			this.options = options;
			terminals.push(this);
		}
		loadAddon() {}
		open() {}
		write(text: string) {
			this.output = text.startsWith("\x1bc") ? text.slice(2) : this.output + text;
		}
		dispose() {
			this.disposed = true;
		}
	},
}));
vi.mock("../src/renderer/components/preview/UniversalFilePreviewer.tsx", () => ({
	UniversalFilePreviewer: () => null,
}));
vi.mock("../src/renderer/components/BrowserPanel.tsx", () => ({
	BrowserPanel: ({ startPageTools }: { startPageTools?: ReactNode }) => <>{startPageTools}</>,
}));

vi.mock("../src/renderer/components/KnowledgePanel.tsx", () => ({ KnowledgePanel: () => null }));

const sessionId = "11111111-1111-4111-8111-111111111111";
let root: Root;
let container: HTMLDivElement;
const api = {
	readProcess: vi.fn().mockResolvedValue({ total: 1, index: 0, process: null }),
	listBrowserProfiles: vi.fn().mockResolvedValue([]),
	subscribeBrowser: vi.fn(() => () => {}),
	createTerminal: vi.fn(),
	retainWorkspaceSessions: vi.fn().mockResolvedValue(undefined),
} as unknown as MetisDesktopApi;
const onError = vi.fn();
const command = (id: string, output = "", state: SessionProcessView["state"] = "running"): SessionProcessView => ({
	processId: id,
	startedAt: id === "one" ? "2026-10-11T12:00:00.000Z" : "2026-10-12T12:00:00.000Z",
	turnId: id === "two" ? "turn-one" : `turn-${id}`,
	command: `echo ${id}`,
	output,
	state,
	truncated: false,
});
const activeProcessTab = () => container.querySelector('[role="tab"][aria-label="Activity log"][aria-selected="true"]');

const sessionsById = new Map([
	[sessionId, { sessionId, cwd: "/tmp/project", mode: "chat" as const }],
	["other", { sessionId: "other", cwd: "/tmp/other", mode: "chat" as const }],
]);

const chatView: SessionChatViewContext = {
	api,
	bootstrapped: false,
	composerFormRef: { current: null },
	registerSubmit: vi.fn(),
	unregisterSubmit: vi.fn(),
	onChangeModel: vi.fn(),
	onChangePermissionPreset: vi.fn(),
	onChangeThinking: vi.fn(),
	onClearError: vi.fn(),
	onError,
	onFork: vi.fn(),
	onManageMcp: vi.fn(),
	onManageSkills: vi.fn(),
	onNotice: vi.fn(),
	onOpenKnowledge: vi.fn(),
	onOpenPlan: vi.fn(),
	onPickFiles: vi.fn(async () => []),
	onPreviewDeliveredFile: vi.fn(),
	onResolveDroppedFiles: vi.fn(() => []),
	onRespond: vi.fn(async () => {}),
	reducedMotion: true,
	skillCatalogEpoch: 0,
	store: new AppStore(),
};

async function render(process?: SessionProcessView, owner = sessionId, mode: "chat" | "code" = "chat") {
	await act(async () =>
		root.render(
			<SessionWorkspaceView
				api={api}
				chat={<div />}
				chatView={chatView}
				chatCwd="/tmp/project"
				chatFocusRequest={null}
				chatIsDraft={false}
				chatSessionId={owner}
				cleanupSessionIds={[]}
				mode={mode}
				onActivateSession={vi.fn()}
				onChatSession={vi.fn()}
				onCleanupSessionIdsHandled={vi.fn()}
				onDirtySessionIdsChange={vi.fn()}
				onError={onError}
				onLiveSessionsChange={vi.fn()}
				process={process}
				sessionsById={sessionsById}
				sessionTitleFor={(id) => id}
				store={{} as AppStore}
				theme="dark"
				visible
			/>,
		),
	);
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	terminals.length = 0;
	vi.clearAllMocks();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("Process workspace tab", () => {
	it("opens a command that completes within one render batch, but not an initial completed snapshot", async () => {
		await render(command("old", "saved", "completed"));
		expect(activeProcessTab()).toBeNull();
		await render(command("new", "finished", "completed"));
		expect(activeProcessTab()).not.toBeNull();
		expect(terminals.at(-1)?.output).toBe("finished");
	});
	it("does not steal another tool and remains available through the manual launcher", async () => {
		await render();
		const tools = container.querySelectorAll(".tool-sidebar-menu button");
		expect(tools[0]?.textContent?.trim()).toBe("Activity log");
		const activityIcon = tools[0]?.querySelector("svg")?.innerHTML;
		expect(activityIcon).toBeTruthy();
		expect(activityIcon).not.toBe(tools[1]?.querySelector("svg")?.innerHTML);
		await act(async () =>
			(container.querySelector(".tool-sidebar-menu button:last-child") as HTMLButtonElement).click(),
		);
		expect(container.querySelector('[role="tab"][aria-label="Knowledge"][aria-selected="true"]')).not.toBeNull();
		await render(command("one"));
		expect(activeProcessTab()).toBeNull();
		expect(container.querySelector('[role="tab"][aria-label="Knowledge"][aria-selected="true"]')).not.toBeNull();
		await act(async () => (container.querySelector(".tool-sidebar-menu button") as HTMLButtonElement).click());
		expect(activeProcessTab()).not.toBeNull();
		expect(activeProcessTab()?.querySelector("svg")?.innerHTML).toBe(activityIcon);
	});
	it("places the selected command status below the timeline", async () => {
		await render(command("one"));
		await render(command("one", "finished", "completed"));
		const footer = container.querySelector(".process-history-footer");
		const controls = footer?.querySelector(".process-history-controls");
		const status = footer?.querySelector("output");
		expect(controls).toBeTruthy();
		expect(status?.textContent).toBe("Command completed");
		expect(controls!.compareDocumentPosition(status!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(container.querySelectorAll("output")).toHaveLength(1);
	});
	it("keeps pending approval distinct from running and completed commands", async () => {
		await render(command("one"));
		await render(command("one", "", "awaiting_approval"));
		expect(activeProcessTab()).not.toBeNull();
		expect(container.querySelector(".process-state")?.textContent).toBe("Waiting for permission approval");
		expect(container.textContent).toContain("The command has not started.");
		await render(command("one"));
		expect(container.querySelector(".process-state")?.textContent).toBe("Command running");
		await render(command("one", "Permission denied", "failed"));
		expect(container.querySelector(".process-state")?.textContent).toBe("Command stopped with an error");
	});

	it.each(["chat", "code"] as const)(
		"opens one read-only tab in %s, streams output and clears it for the next command",
		async (mode) => {
			await render(undefined, sessionId, mode);
			expect(container.querySelector('[role="tab"][aria-label="Activity log"]')).toBeNull();
			await render(command("one"), sessionId, mode);
			expect(activeProcessTab()).not.toBeNull();
			expect(terminals.at(-1)?.options.disableStdin).toBe(true);
			await render(command("one", "first\n"), sessionId, mode);
			await render(command("one", "first\nsecond\n", "completed"), sessionId, mode);
			expect(terminals.at(-1)?.output).toBe("first\nsecond\n");
			expect(container.querySelector('output, [role="status"]')?.textContent).toBe("Command completed");
			await render(command("two"), sessionId, mode);
			expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
			expect(terminals).toHaveLength(1);
			expect(terminals[0]?.disposed).toBe(false);
			expect(terminals.at(-1)?.output).toBe("");
			expect(api.createTerminal).not.toHaveBeenCalled();
		},
	);

	it("respects closing within a turn and opens once for the next turn even if its command completed in one batch", async () => {
		await render(command("one"));
		await act(async () =>
			(container.querySelector('[aria-label="Close Activity log"]') as HTMLButtonElement).click(),
		);
		await render(command("one", "late"));
		expect(container.querySelector('[role="tab"][aria-label="Activity log"]')).toBeNull();
		await render(command("two"));
		expect(container.querySelector('[role="tab"][aria-label="Activity log"]')).toBeNull();
		await render(command("fast", "", "completed"));
		expect(container.querySelector('[role="tab"][aria-label="Activity log"]')).not.toBeNull();
		expect(container.textContent).toContain("This command produced no output.");
	});

	it("starts with the command and omits the copy output button", async () => {
		await render(command("one"));
		await render(command("one", "first\n", "completed"));
		const panel = container.querySelector(".process-panel:not([hidden])");
		expect(panel?.firstElementChild?.textContent).toBe("$ echo one");
		expect(panel?.querySelector('button[aria-label="Copy output"]')).toBeNull();
	});

	it("relocalizes the process panel name and status", async () => {
		await render(command("one"));
		await render(command("one", "first\n", "completed"));
		const panel = () => container.querySelector<HTMLElement>(".process-panel:not([hidden])");
		expect(panel()?.getAttribute("aria-label")).toBe("Activity log");
		expect(container.querySelector("output")?.textContent).toBe("Command completed");

		await act(async () => {
			await setLocale("zh-CN");
		});
		expect(panel()?.getAttribute("aria-label")).toBe("操作记录");
		expect(container.querySelector("output")?.textContent).toBe("命令已完成");

		await act(async () => {
			await setLocale("en");
		});
		expect(panel()?.getAttribute("aria-label")).toBe("Activity log");
		expect(container.querySelector("output")?.textContent).toBe("Command completed");
	});

	it("keeps session outputs separate and replaces a rolling output tail without duplicating it", async () => {
		await render(command("one", "old text"));
		await render({ ...command("one", "new tail"), truncated: true });
		expect(terminals.at(-1)?.output).toBe("new tail");
		expect(container.textContent).toContain("earlier output was truncated");
		// The sidebar follows the focused session: switching the chat projection
		// hides this session's process panel without unmounting it.
		await render(undefined, "other");
		expect(container.querySelector(".process-panel[hidden] .process-command")).toBeNull();
		await render(command("two"), "other");
		await render(command("two", "failure", "failed"), "other");
		const otherPanel = [...container.querySelectorAll(".process-panel")].find((panel) =>
			panel.textContent?.includes("echo two"),
		);
		expect(otherPanel?.textContent).toContain("Command stopped with an error");
		await render(command("one", "new tail", "completed"));
		expect(container.querySelector(".process-panel:not([hidden]) .process-command")?.textContent).toContain(
			"echo one",
		);
	});
});

describe("process history selection", () => {
	it("coalesces rapid selections, ignores obsolete failures and drops pending work when hidden", async () => {
		type Page = ClientResult<"session/readProcess">;
		const pending: Array<{ resolve: (page: Page) => void; reject: (error: Error) => void }> = [];
		const readProcess = vi.fn(() => new Promise<Page>((resolve, reject) => pending.push({ resolve, reject })));
		const historyApi = { readProcess };
		const show = (visible = true) =>
			act(async () =>
				root.render(
					<ProcessPanel
						api={historyApi}
						sessionId={sessionId}
						panelId="history"
						theme="dark"
						visible={visible}
						onError={onError}
					/>,
				),
			);
		const previous = () =>
			act(async () => (container.querySelector('[aria-label="Previous command"]') as HTMLButtonElement).click());
		await show();
		await act(async () =>
			pending[0]!.resolve({ total: 6, index: 5, process: command("latest", "latest", "completed") }),
		);
		await previous();
		await previous();
		await previous();
		expect(readProcess).toHaveBeenCalledTimes(2);
		expect(container.querySelector<HTMLInputElement>('[type="range"]')!.value).toBe("2500");
		await act(async () => pending[1]!.reject(new Error("obsolete")));
		expect(onError).not.toHaveBeenCalled();
		expect(readProcess).toHaveBeenLastCalledWith({ sessionId, index: 2 });
		await act(async () =>
			pending[2]!.resolve({ total: 6, index: 2, process: command("selected", "selected", "completed") }),
		);
		expect(terminals.at(-1)?.output).toBe("selected");
		await previous();
		await previous();
		await show(false);
		await act(async () =>
			pending[3]!.resolve({ total: 6, index: 1, process: command("stale", "stale", "completed") }),
		);
		expect(readProcess).toHaveBeenCalledTimes(4);
		await show();
		expect(readProcess).toHaveBeenLastCalledWith({ sessionId, index: 0 });
		await act(async () => pending[4]!.reject(new Error("current failure")));
		expect(onError).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		await act(async () => (container.querySelector('[role="alert"] button') as HTMLButtonElement).click());
		await act(async () =>
			pending[5]!.resolve({ total: 6, index: 0, process: command("recovered", "recovered", "completed") }),
		);
		expect(terminals.at(-1)?.output).toBe("recovered");
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("allows slow polling to finish without overlapping requests or starving updates", async () => {
		vi.useFakeTimers();
		try {
			const readProcess = vi
				.fn()
				.mockResolvedValueOnce({ total: 2, index: 1, process: command("latest", "latest", "completed") })
				.mockResolvedValueOnce({ total: 2, index: 0, process: command("one", "running") })
				.mockImplementation(async () => {
					await new Promise((resolve) => setTimeout(resolve, 800));
					return { total: 2, index: 0, process: command("one", "finished", "completed") };
				});
			await act(async () =>
				root.render(
					<ProcessPanel
						api={{ readProcess }}
						sessionId={sessionId}
						panelId="history"
						theme="dark"
						visible
						onError={onError}
					/>,
				),
			);
			await act(async () =>
				(container.querySelector('[aria-label="Previous command"]') as HTMLButtonElement).click(),
			);
			await act(async () => vi.advanceTimersByTimeAsync(500));
			expect(readProcess).toHaveBeenCalledTimes(3);
			await act(async () => vi.advanceTimersByTimeAsync(800));
			expect(readProcess).toHaveBeenCalledTimes(3);
			expect(terminals.at(-1)?.output).toBe("finished");
			await act(async () => vi.advanceTimersByTimeAsync(1000));
			expect(readProcess).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the selected identity as new commands arrive and stops work while hidden", async () => {
		const records = [command("one", "first", "completed"), command("two", "second", "completed")];
		const readProcess = vi.fn(async (input: { index?: number; processId?: string }) => {
			const index = input.processId
				? records.findIndex((record) => record.processId === input.processId)
				: (input.index ?? records.length - 1);
			return { total: records.length, index, process: records[index] ?? null };
		});
		const historyApi = { readProcess };
		const show = async (visible = true, latest?: SessionProcessView) =>
			act(async () =>
				root.render(
					<ProcessPanel
						api={historyApi}
						sessionId={sessionId}
						panelId="history"
						theme="dark"
						visible={visible}
						process={latest}
						onError={onError}
					/>,
				),
			);
		await show(false);
		expect(readProcess).not.toHaveBeenCalled();
		await show();
		expect(container.textContent).toContain("echo two");
		expect(container.querySelector(".process-history-date")?.getAttribute("datetime")).toBe(
			"2026-10-12T12:00:00.000Z",
		);
		expect(container.querySelector(".process-live")?.textContent).toBe("Live");
		expect(container.querySelector(".process-return-live")).toBeNull();
		const slider = () => container.querySelector<HTMLInputElement>('[type="range"]')!;
		expect(slider().value).toBe(slider().max);
		await act(async () => (container.querySelector('[aria-label="Previous command"]') as HTMLButtonElement).click());
		expect(container.textContent).toContain("echo one");
		expect(readProcess).toHaveBeenCalledTimes(2);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.output).toBe("first");
		expect(container.querySelector(".process-history-date")?.getAttribute("datetime")).toBe(
			"2026-10-11T12:00:00.000Z",
		);
		expect(container.querySelector(".process-return-live")?.textContent?.trim()).toBe("Return to live");
		expect(container.querySelector(".process-live")?.textContent).toBe("Live");
		const pinnedPosition = slider().value;
		const latest = { ...command("three", "live"), revision: 1 };
		records.push(latest);
		await show(true, latest);
		expect(container.textContent).toContain("echo one");
		expect(container.querySelector(".process-history-position")?.textContent).toBe("1/3");
		expect(slider().value).toBe(pinnedPosition);
		await act(async () => (container.querySelector(".process-live") as HTMLButtonElement).click());
		expect(container.textContent).toContain("echo three");
		expect(slider().value).toBe(slider().max);
		await show(false, latest);
		const count = readProcess.mock.calls.length;
		await show(false, { ...latest, revision: 2, output: "more" });
		expect(readProcess).toHaveBeenCalledTimes(count);
		expect(container.querySelector(".process-output")).toBeNull();
	});
});
