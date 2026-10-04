// @vitest-environment jsdom
import type { SessionProcessView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspaceView } from "../src/renderer/components/SessionWorkspace.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const terminals = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>; output: string; disposed: boolean }>);
vi.mock("@xterm/xterm", () => ({ Terminal: class {
	output = "";
	disposed = false;
	constructor(public options: Record<string, unknown>) { terminals.push(this); }
	loadAddon() {}
	open() {}
	write(text: string) { this.output = text.startsWith("\x1bc") ? text.slice(2) : this.output + text; }
	dispose() { this.disposed = true; }
} }));
vi.mock("../src/renderer/components/preview/UniversalFilePreviewer.tsx", () => ({ UniversalFilePreviewer: () => null }));

const sessionId = "11111111-1111-4111-8111-111111111111";
let root: Root;
let container: HTMLDivElement;
const api = { listBrowserProfiles: vi.fn().mockResolvedValue([]), subscribeBrowser: vi.fn(() => () => {}), createTerminal: vi.fn(), retainWorkspaceSessions: vi.fn().mockResolvedValue(undefined) } as unknown as MetisDesktopApi;
const onError = vi.fn();
const command = (id: string, output = "", state: SessionProcessView["state"] = "running"): SessionProcessView => ({ processId: id, command: `echo ${id}`, output, state, truncated: false });
const activeProcessTab = () => container.querySelector('[role="tab"][aria-label="Process"][aria-selected="true"]');

const sessionsById = new Map([
	[sessionId, { sessionId, cwd: "/tmp/project", mode: "chat" as const }],
	["other", { sessionId: "other", cwd: "/tmp/other", mode: "chat" as const }],
]);

async function render(process?: SessionProcessView, owner = sessionId, mode: "chat" | "code" = "chat") {
	await act(async () => root.render(<SessionWorkspaceView
		api={api}
		chat={<div />}
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
		process={process}
		sessionsById={sessionsById}
		sessionTitleFor={(id) => id}
		store={{} as AppStore}
		theme="dark"
		visible
	/>));
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
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("Process workspace tab", () => {
	it.each(["chat", "code"] as const)("opens one read-only tab in %s, streams output and clears it for the next command", async (mode) => {
		await render(undefined, sessionId, mode);
		expect(container.querySelector('[role="tab"][aria-label="Process"]')).toBeNull();
		await render(command("one"), sessionId, mode);
		expect(activeProcessTab()).not.toBeNull();
		expect(terminals.at(-1)?.options.disableStdin).toBe(true);
		await render(command("one", "first\n"), sessionId, mode);
		await render(command("one", "first\nsecond\n", "completed"), sessionId, mode);
		expect(terminals.at(-1)?.output).toBe("first\nsecond\n");
		expect(container.querySelector('[role="status"]')?.textContent).toBe("Command completed");
		await render(command("two"), sessionId, mode);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(terminals[0]?.disposed).toBe(true);
		expect(terminals.at(-1)?.output).toBe("");
		expect(api.createTerminal).not.toHaveBeenCalled();
	});

	it("respects closing the tab, then opens for a new command even when it completed within one batch", async () => {
		await render(command("one"));
		await act(async () => (container.querySelector('[aria-label="Close Process"]') as HTMLButtonElement).click());
		await render(command("one", "late"));
		expect(container.querySelector('[role="tab"][aria-label="Process"]')).toBeNull();
		await render(command("fast", "", "completed"));
		expect(container.querySelector('[role="tab"][aria-label="Process"]')).not.toBeNull();
		expect(container.textContent).toContain("This command produced no output.");
	});

	it("keeps session outputs separate and replaces a rolling output tail without duplicating it", async () => {
		await render(command("one", "old text"));
		await render({ ...command("one", "new tail"), truncated: true });
		expect(terminals.at(-1)?.output).toBe("new tail");
		expect(container.textContent).toContain("earlier output was truncated");
		// Tool tabs stay live for any session; switching the chat projection
		// does not hide the other session's process panel.
		await render(undefined, "other");
		expect(container.querySelector('.process-panel:not([hidden]) .process-command')?.textContent).toContain("echo one");
		await render(command("two", "failure", "failed"), "other");
		const otherPanel = [...container.querySelectorAll(".process-panel")]
			.find((panel) => panel.textContent?.includes("echo two"));
		expect(otherPanel?.textContent).toContain("Command stopped with an error");
		await render(command("one", "new tail", "completed"));
		expect(container.querySelector('.process-panel .process-command')?.textContent).toContain("echo one");
	});
});
