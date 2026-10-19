import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { getDefaultSessionDir, getSessionDisplayMetadataPath, SessionManager } from "../src/core/session-manager.ts";
import { showDeprecationWarnings } from "../src/migrations.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type FakeUi = {
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

type FakeStdin = PassThrough & {
	isTTY?: boolean;
	rawModes: Array<boolean | undefined>;
	setRawMode: (mode: boolean) => FakeStdin;
};

type HandleCtrlZThis = { ui: FakeUi };

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleCtrlZ(this: HandleCtrlZThis): void;
	setupExtensionShortcuts(this: Record<string, unknown>, runner: unknown): void;
};

function createFakeStdin(options: { isTTY: boolean; destroyed?: boolean }): FakeStdin {
	const stdin = new PassThrough() as FakeStdin;
	stdin.isTTY = options.isTTY;
	stdin.rawModes = [];
	stdin.setRawMode = (mode: boolean) => {
		stdin.rawModes.push(mode);
		return stdin;
	};
	if (options.destroyed) stdin.destroy();
	return stdin;
}

async function withFakeStdin<T>(stdin: FakeStdin, operation: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
	Object.defineProperty(process, "stdin", {
		configurable: true,
		enumerable: true,
		value: stdin,
	});
	try {
		return await operation();
	} finally {
		if (descriptor) Object.defineProperty(process, "stdin", descriptor);
		stdin.removeAllListeners();
		stdin.destroy();
	}
}

async function settlementWithin(promise: Promise<void>, timeoutMs = 250): Promise<"resolved" | "pending"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => "resolved" as const),
			new Promise<"pending">((resolve) => {
				timer = setTimeout(() => resolve("pending"), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function hasErrorDiagnostic(result: ReturnType<typeof parseArgs>): boolean {
	return result.diagnostics.some((diagnostic) => diagnostic.type === "error");
}

function withInteractiveModePrototype<T extends Record<string, unknown>>(fields: T): T {
	return Object.defineProperties(
		Object.create(InteractiveMode.prototype),
		Object.getOwnPropertyDescriptors(fields),
	) as T;
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
});

const sessionRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of sessionRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createPersistedSession(): { manager: SessionManager; sidecar: string } {
	const root = mkdtempSync(join(tmpdir(), "metis-wave5-review-session-"));
	sessionRoots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir), {
		id: "11111111-1111-4111-8111-111111111111",
		mode: "chat",
	});
	manager.appendSessionInfo("wave5 review");
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	return { manager, sidecar: getSessionDisplayMetadataPath(sessionFile) };
}

describe("deprecation warning startup compatibility", () => {
	it.each([
		["non-TTY stdin", { isTTY: false }],
		["destroyed stdin", { isTTY: true, destroyed: true }],
	] as const)("returns without waiting for a keypress on %s", async (_name, options) => {
		const stdin = createFakeStdin(options);
		const outcome = await withFakeStdin(stdin, async () =>
			settlementWithin(showDeprecationWarnings(["legacy hooks/ directory found."])),
		);
		expect(outcome).toBe("resolved");
		expect(stdin.listenerCount("data")).toBe(0);
	});

	it("settles and restores raw mode when stdin ends before a keypress", async () => {
		const stdin = createFakeStdin({ isTTY: true });
		const outcome = await withFakeStdin(stdin, async () => {
			const pending = showDeprecationWarnings(["legacy hooks/ directory found."]);
			stdin.emit("end");
			return await settlementWithin(pending);
		});
		expect(outcome).toBe("resolved");
		expect(stdin.rawModes.at(-1)).toBe(false);
	});

	it("resolves on a keypress and restores raw mode", async () => {
		const stdin = createFakeStdin({ isTTY: true });
		await withFakeStdin(stdin, async () => {
			const pending = showDeprecationWarnings(["legacy hooks/ directory found."]);
			stdin.emit("data", Buffer.from("x"));
			await pending;
		});
		expect(stdin.rawModes).toEqual([true, false]);
		expect(stdin.isPaused()).toBe(true);
	});
});

describe("interactive suspend cleanup compatibility", () => {
	it.skipIf(process.platform === "win32")(
		"restores the TUI and removes temporary signal handlers when SIGTSTP cannot be delivered",
		() => {
			const ui: FakeUi = { start: vi.fn(), stop: vi.fn(), requestRender: vi.fn() };
			const listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();
			const add = (event: string, listener: (...args: unknown[]) => void) => {
				const handlers = listeners.get(event) ?? new Set();
				handlers.add(listener);
				listeners.set(event, handlers);
				return process;
			};
			const remove = (event: string, listener: (...args: unknown[]) => void) => {
				listeners.get(event)?.delete(listener);
				return process;
			};
			const keepAlive = setTimeout(() => undefined, 0);
			clearTimeout(keepAlive);

			vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAlive);
			vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
			vi.spyOn(process, "on").mockImplementation(add as typeof process.on);
			vi.spyOn(process, "once").mockImplementation(add as typeof process.once);
			vi.spyOn(process, "removeListener").mockImplementation(remove as typeof process.removeListener);
			vi.spyOn(process, "off").mockImplementation(remove as typeof process.off);
			vi.spyOn(process, "kill").mockImplementation(() => {
				throw new Error("cannot suspend");
			});

			try {
				interactiveModePrototype.handleCtrlZ.call(withInteractiveModePrototype({ ui }));
			} catch {
				// The failure may still propagate after cleanup; cleanup is what this regression protects.
			}

			expect(ui.start).toHaveBeenCalledTimes(1);
			expect(listeners.get("SIGCONT")?.size ?? 0).toBe(0);
			expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
		},
	);
});

describe("extension shutdown request compatibility", () => {
	function shortcutContext(options: { isIdle: boolean; shutdown: () => void }) {
		let captured: { shutdown: () => void } | undefined;
		const editor: { onExtensionShortcut?: (data: string) => boolean } = {};
		const context = withInteractiveModePrototype({
			keybindings: { getEffectiveConfig: () => [] },
			defaultEditor: editor,
			createExtensionUIContext: () => ({}),
			restoreQueuedMessagesToEditor: vi.fn(),
			sessionManager: { getCwd: () => process.cwd() },
			session: {
				modelRegistry: {},
				model: {},
				agent: { signal: undefined },
				isIdle: options.isIdle,
				pendingMessageCount: 0,
				getContextUsage: () => undefined,
				compact: vi.fn(async () => ({})),
				systemPrompt: "",
			},
			settingsManager: { isProjectTrusted: () => true },
			guardCompactionMutation: () => false,
			shutdownRequested: false,
			shutdown: options.shutdown,
			showError: vi.fn(),
		});
		const runner = {
			getShortcuts: () =>
				new Map([
					[
						"ctrl+k",
						{
							handler: (extensionContext: { shutdown: () => void }) => {
								captured = extensionContext;
							},
						},
					],
				]),
		};
		interactiveModePrototype.setupExtensionShortcuts.call(context, runner);
		return { context, editor, getCaptured: () => captured };
	}

	it("shuts down immediately when an extension shortcut requests shutdown while idle", async () => {
		const shutdown = vi.fn();
		const { editor, getCaptured } = shortcutContext({ isIdle: true, shutdown });

		expect(editor.onExtensionShortcut?.("\x0b")).toBe(true);
		await vi.waitFor(() => expect(getCaptured()).toBeDefined());
		getCaptured()?.shutdown();
		await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
	});

	it("defers an extension shortcut shutdown until the agent settles while active", async () => {
		const shutdown = vi.fn();
		const { context, editor, getCaptured } = shortcutContext({ isIdle: false, shutdown });

		expect(editor.onExtensionShortcut?.("\x0b")).toBe(true);
		await vi.waitFor(() => expect(getCaptured()).toBeDefined());
		getCaptured()?.shutdown();
		await Promise.resolve();

		expect(context.shutdownRequested).toBe(true);
		expect(shutdown).not.toHaveBeenCalled();
	});
});

describe("RPC listener isolation compatibility", () => {
	it("keeps dispatching later listeners when an earlier listener throws", () => {
		const client = new RpcClient();
		const calls: string[] = [];
		client.onEvent(() => {
			calls.push("first");
			throw new Error("listener failed");
		});
		client.onEvent(() => {
			calls.push("second");
		});
		const handleLine = (
			client as unknown as {
				handleLine(line: string): void;
			}
		).handleLine.bind(client);

		expect(() => handleLine(JSON.stringify({ type: "agent_settled" }))).not.toThrow();
		expect(calls).toEqual(["first", "second"]);
	});

	it.each(["null", "42", "true", '"text"', "[]"])("does not dispatch malformed JSON primitive %s", (line) => {
		const client = new RpcClient();
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		const handleLine = (
			client as unknown as {
				handleLine(line: string): void;
			}
		).handleLine.bind(client);

		expect(() => handleLine(line)).not.toThrow();
		expect(events).toEqual([]);
	});
});

describe("CLI value parsing compatibility", () => {
	const requiredValueFlags = [
		"--mode",
		"--provider",
		"--model",
		"--api-key",
		"--system-prompt",
		"--append-system-prompt",
		"--name",
		"--session",
		"--session-id",
		"--fork",
		"--session-dir",
		"--models",
		"--tools",
		"--exclude-tools",
		"--thinking",
		"--export",
		"--extension",
		"--skill",
		"--prompt-template",
		"--theme",
	] as const;

	it.each(requiredValueFlags)("diagnoses a missing value for %s at end of args", (flag) => {
		const result = parseArgs([flag]);
		expect(hasErrorDiagnostic(result)).toBe(true);
	});

	it.each([
		["--model", "--help"],
		["--mode", "--help"],
	] as const)("treats %s followed by %s as a missing value", (flag, option) => {
		const result = parseArgs([flag, option]);
		expect(result.help).toBe(true);
		expect(result.model).toBeUndefined();
		expect(result.mode).toBeUndefined();
		expect(hasErrorDiagnostic(result)).toBe(true);
	});

	it("diagnoses an invalid output mode", () => {
		const result = parseArgs(["--mode", "bogus"]);
		expect(result.mode).toBeUndefined();
		expect(hasErrorDiagnostic(result)).toBe(true);
	});

	it("preserves valid option values, free-text values, positional messages, and extension flags", () => {
		const result = parseArgs([
			"--mode",
			"json",
			"--provider",
			"openai",
			"--model",
			"gpt-4o",
			"--thinking",
			"high",
			"--system-prompt",
			"- You are concise",
			"--custom-extension-flag",
			"custom-value",
			"hello",
		]);

		expect(result.mode).toBe("json");
		expect(result.provider).toBe("openai");
		expect(result.model).toBe("gpt-4o");
		expect(result.thinking).toBe("high");
		expect(result.systemPrompt).toBe("- You are concise");
		expect(result.unknownFlags.get("custom-extension-flag")).toBe("custom-value");
		expect(result.messages).toEqual(["hello"]);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("SessionManager sidecar lifecycle compatibility", () => {
	it("does not write guarded sidecars after close", () => {
		const { manager, sidecar } = createPersistedSession();
		expect(existsSync(sidecar)).toBe(true);
		manager.close();

		expect(() => manager.setMemoryFlags({ useMemory: false })).toThrow(/closed/i);
		expect(() => manager.setSessionUnread(true)).toThrow(/closed/i);
		expect(existsSync(sidecar)).toBe(true);
	});

	it("does not delete the display metadata sidecar when appendSessionInfo is called after close", () => {
		const { manager, sidecar } = createPersistedSession();
		manager.close();

		expect(() => manager.appendSessionInfo("after close")).toThrow(/closed/i);
		expect(existsSync(sidecar)).toBe(true);
	});
});
