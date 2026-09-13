// @vitest-environment jsdom
import type { SessionProcessView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolsSidebar } from "../src/renderer/components/ToolsSidebar.tsx";
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
const api = { listBrowserProfiles: vi.fn().mockResolvedValue([]), subscribeBrowser: vi.fn(() => () => {}), createTerminal: vi.fn() } as unknown as MetisDesktopApi;
const onOpen = vi.fn();
const onError = vi.fn();
const command = (id: string, output = "", state: SessionProcessView["state"] = "running"): SessionProcessView => ({ processId: id, command: `echo ${id}`, output, state, truncated: false });

async function render(process?: SessionProcessView, owner = sessionId, mode: "chat" | "code" = "chat") {
	await act(async () => root.render(<ToolsSidebar activeSession={{ sessionId: owner, cwd: "/tmp/project" }} api={api} cleanupSessionIds={[]} mode={mode} onActivateSession={vi.fn()} onClose={vi.fn()} onOpen={onOpen} process={process} onCleanupSessionIdsHandled={vi.fn()} onDirtySessionIdsChange={vi.fn()} onError={onError} onWidthChange={vi.fn()} open preferredWidth={393} store={{} as AppStore} theme="dark" width={393} />));
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

describe("Process sidebar", () => {
	it.each(["chat", "code"] as const)("opens one read-only tab in %s, streams output and clears it for the next command", async (mode) => {
		await render(undefined, sessionId, mode);
		expect(container.querySelector('[role="tab"][aria-label="Process"]')).toBeNull();
		expect(container.querySelector('.tool-sidebar-menu button[aria-label="Process"]')).toBeNull();
		if (mode === "code") {
			expect(container.querySelector('.tool-sidebar-menu button[aria-label="Files"] .animated-nav-icon')).toBeNull();
			expect(container.querySelector('.tool-sidebar-menu button[aria-label="Files"] svg')).not.toBeNull();
		}
		await render(command("one"), sessionId, mode);
		expect(onOpen).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="tab"][aria-label="Process"]')).not.toBeNull();
		expect(terminals.at(-1)?.options.disableStdin).toBe(true);
		await render(command("one", "first\n"), sessionId, mode);
		await render(command("one", "first\nsecond\n", "completed"), sessionId, mode);
		expect(terminals.at(-1)?.output).toBe("first\nsecond\n");
		expect(container.querySelector('[role="status"]')?.textContent).toBe("Command completed");
		expect(onOpen).toHaveBeenCalledOnce();
		await render(command("two"), sessionId, mode);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(terminals[0]?.disposed).toBe(true);
		expect(terminals.at(-1)?.output).toBe("");
		expect(onOpen).toHaveBeenCalledTimes(2);
		expect(api.createTerminal).not.toHaveBeenCalled();
	});

	it("respects closing the tab, then opens for a new command even when it completed within one batch", async () => {
		await render(command("one"));
		await act(async () => (container.querySelector('[aria-label="Close Process"]') as HTMLButtonElement).click());
		expect(container.querySelector('.tool-sidebar-menu button[aria-label="Process"]')).toBeNull();
		await render(command("one", "late"));
		expect(container.querySelector('[role="tab"][aria-label="Process"]')).toBeNull();
		expect(onOpen).toHaveBeenCalledOnce();
		await render(command("fast", "", "completed"));
		expect(onOpen).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("This command produced no output.");
	});

	it("keeps session outputs separate and replaces a rolling output tail without duplicating it", async () => {
		await render(command("one", "old text"));
		await render({ ...command("one", "new tail"), truncated: true });
		expect(terminals.at(-1)?.output).toBe("new tail");
		expect(container.textContent).toContain("earlier output was truncated");
		await render(undefined, "other");
		expect(container.querySelector('.process-panel:not([hidden])')).toBeNull();
		await render(command("two", "failure", "failed"), "other");
		expect(container.querySelector('.process-panel:not([hidden])')?.textContent).toContain("Command stopped with an error");
		await render(command("one", "new tail", "completed"));
		expect(container.querySelector('.process-panel:not([hidden]) .process-command')?.textContent).toContain("echo one");
	});
});
