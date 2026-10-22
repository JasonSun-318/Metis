// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "../src/renderer/components/TerminalPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { DesktopTerminalEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";

const terminals = vi.hoisted(
	() =>
		[] as Array<{
			options: Record<string, unknown>;
			output: string;
			disposed: boolean;
			focus: ReturnType<typeof vi.fn>;
			input?: (data: string) => void;
		}>,
);
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		output = "";
		disposed = false;
		options: Record<string, unknown>;
		focus = vi.fn();
		input?: (data: string) => void;
		constructor(options: Record<string, unknown>) {
			this.options = options;
			terminals.push(this);
		}
		loadAddon() {}
		open() {}
		write(text: string) {
			this.output += text;
		}
		onData(handler: (data: string) => void) {
			this.input = handler;
			return { dispose() {} };
		}
		scrollToBottom() {}
		clear() {}
		dispose() {
			this.disposed = true;
		}
	},
}));

const createTerminal = vi.fn();
const writeTerminal = vi.fn().mockResolvedValue(undefined);
const resizeTerminal = vi.fn().mockResolvedValue(undefined);
const unsubscribeTerminal = vi.fn();
let terminalListener: ((event: DesktopTerminalEvent) => void) | undefined;
const subscribeTerminal = vi.fn((listener: (event: DesktopTerminalEvent) => void) => {
	terminalListener = listener;
	return unsubscribeTerminal;
});
const api = {
	createTerminal,
	resizeTerminal,
	subscribeTerminal,
	writeTerminal,
} as unknown as MetisDesktopApi;

let root: Root | null = null;
let container: HTMLDivElement | undefined;

async function render() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<StrictMode>
				<TerminalPanel api={api} cwd="/tmp/project" terminalId="terminal-1" theme="dark" visible />
			</StrictMode>,
		);
	});
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function retryButton() {
	return [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Retry");
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	terminals.length = 0;
	terminalListener = undefined;
	vi.clearAllMocks();
});

afterEach(async () => {
	if (root) {
		await act(async () => root?.unmount());
		root = null;
	}
	container?.remove();
	container = undefined;
});

describe("TerminalPanel creation", () => {
	it("retries a failed creation with the same terminal id and cwd, then enables input", async () => {
		let rejectFirst!: (cause: Error) => void;
		const first = new Promise((_, reject) => {
			rejectFirst = reject;
		});
		createTerminal.mockReturnValueOnce(first).mockResolvedValueOnce({ terminalId: "terminal-1" });

		await render();
		expect(createTerminal).toHaveBeenCalledTimes(1);
		expect(container?.querySelector("output")).toBeNull();

		await act(async () => {
			rejectFirst(new Error("spawn failed"));
		});
		await flush();
		expect(container?.querySelector("output")?.textContent).toContain("spawn failed");
		expect(retryButton()).not.toBeUndefined();

		await act(async () => retryButton()?.click());
		await flush();
		expect(createTerminal).toHaveBeenCalledTimes(2);
		expect(createTerminal.mock.calls[0]?.[0]).toMatchObject({ terminalId: "terminal-1", cwd: "/tmp/project" });
		expect(createTerminal.mock.calls[1]?.[0]).toMatchObject({ terminalId: "terminal-1", cwd: "/tmp/project" });
		expect(container?.querySelector("output")).toBeNull();

		const terminal = terminals.at(-1)!;
		expect(terminal.options.disableStdin).toBe(false);
		terminal.input?.("pwd\n");
		expect(writeTerminal).toHaveBeenCalledWith({ terminalId: "terminal-1", data: "pwd\n" });
	});

	it("does not create twice while the first creation is still pending", async () => {
		let resolveFirst!: (value: unknown) => void;
		createTerminal.mockReturnValue(
			new Promise((resolve) => {
				resolveFirst = resolve;
			}),
		);

		await render();
		expect(createTerminal).toHaveBeenCalledTimes(1);
		expect(container?.querySelector("output")).toBeNull();
		expect(retryButton()).toBeUndefined();
		const terminal = terminals.at(-1)!;
		expect(terminal.options.disableStdin).toBe(true);

		await act(async () => {
			resolveFirst({ terminalId: "terminal-1" });
		});
		await flush();
		expect(terminal.options.disableStdin).toBe(false);
	});

	it("ignores a late creation rejection after unmount and disposes the terminal", async () => {
		let rejectFirst!: (cause: Error) => void;
		createTerminal.mockReturnValue(
			new Promise((_, reject) => {
				rejectFirst = reject;
			}),
		);

		await render();
		const terminal = terminals.at(-1)!;
		await act(async () => {
			root?.unmount();
			root = null;
		});
		expect(terminal.disposed).toBe(true);
		expect(unsubscribeTerminal).toHaveBeenCalled();

		await act(async () => {
			rejectFirst(new Error("late failure"));
		});
		await flush();
		expect(container?.textContent).toBe("");
	});

	it("keeps a normal exit read-only with its exit code and no Retry", async () => {
		createTerminal.mockResolvedValue({ terminalId: "terminal-1" });
		await render();
		await flush();

		const terminal = terminals.at(-1)!;
		expect(terminal.options.disableStdin).toBe(false);
		expect(terminalListener).toBeTypeOf("function");
		await act(async () => {
			terminalListener?.({ type: "exit", terminalId: "terminal-1", exitCode: 7 });
		});
		expect(terminal.options.disableStdin).toBe(true);
		expect(terminal.output).toContain("Process exited with code 7");
		expect(retryButton()).toBeUndefined();
		expect(container?.textContent).not.toContain("Retry");

		terminal.input?.("ignored\n");
		expect(writeTerminal).not.toHaveBeenCalled();
		expect(createTerminal).toHaveBeenCalledTimes(1);
	});

	it("shows a write disconnect without offering a creation retry", async () => {
		createTerminal.mockResolvedValue({ terminalId: "terminal-1" });
		writeTerminal.mockRejectedValueOnce(new Error("socket closed"));
		await render();
		await flush();

		const terminal = terminals.at(-1)!;
		await act(async () => {
			terminal.input?.("echo hello\n");
		});
		await flush();
		expect(container?.querySelector("output")?.textContent).toContain("Terminal disconnected");
		expect(retryButton()).toBeUndefined();
		expect(createTerminal).toHaveBeenCalledTimes(1);
	});
});
