import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ShutdownContext = {
	shutdownRequested: boolean;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
};

type ShortcutHarness = {
	context: ShutdownContext;
	invoke: () => boolean | undefined;
	getCaptured: () => { shutdown: () => void } | undefined;
};

type CommandHarness = {
	context: ShutdownContext;
	getShutdownHandler: () => (() => void) | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as any;

function createModeContext(fields: Record<string, unknown>): any {
	const context = Object.create(InteractiveMode.prototype);
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(context, key, { configurable: true, writable: true, enumerable: true, value });
	}
	return context;
}

function createShortcutHarness(isIdle: boolean): ShortcutHarness {
	let captured: { shutdown: () => void } | undefined;
	const context = createModeContext({
		keybindings: { getEffectiveConfig: () => ({}) },
		createExtensionUIContext: () => ({}),
		sessionManager: { getCwd: () => "/repo" },
		session: {
			modelRegistry: {},
			model: undefined,
			isIdle,
			agent: { signal: undefined },
			pendingMessageCount: 0,
		},
		settingsManager: { isProjectTrusted: () => true },
		restoreQueuedMessagesToEditor: vi.fn(),
		defaultEditor: {},
		shutdownRequested: false,
		shutdown: vi.fn(async () => {}),
	});
	const runner = {
		getShortcuts: () =>
			new Map([
				[
					"ctrl+x",
					{
						handler: (extensionContext: { shutdown: () => void }) => {
							captured = extensionContext;
						},
					},
				],
			]),
	};

	interactiveModePrototype.setupExtensionShortcuts.call(context, runner);
	return {
		context,
		invoke: () => context.defaultEditor.onExtensionShortcut("\x18"),
		getCaptured: () => captured,
	};
}

async function createCommandHarness(isIdle: boolean): Promise<CommandHarness> {
	let shutdownHandler: (() => void) | undefined;
	const context = createModeContext({
		createExtensionUIContext: () => ({}),
		session: {
			isIdle,
			bindExtensions: vi.fn(async (bindings: { shutdownHandler: () => void }) => {
				shutdownHandler = bindings.shutdownHandler;
			}),
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			extensionRunner: {},
		},
		setupAutocompleteProvider: vi.fn(),
		setupExtensionShortcuts: vi.fn(),
		showLoadedResources: vi.fn(),
		shutdownRequested: false,
		shutdown: vi.fn(async () => {}),
	});

	await interactiveModePrototype.bindCurrentSessionExtensions.call(context);
	return { context, getShutdownHandler: () => shutdownHandler };
}

describe("InteractiveMode extension context shutdown lifecycle", () => {
	it("exits immediately when an idle shortcut context requests shutdown", () => {
		const { context, invoke, getCaptured } = createShortcutHarness(true);
		invoke();
		const extensionContext = getCaptured();

		expect(extensionContext).toBeDefined();
		extensionContext?.shutdown();

		expect(context.shutdownRequested).toBe(true);
		expect(context.shutdown).toHaveBeenCalledTimes(1);
	});

	it("defers an active shortcut shutdown until agent_settled", async () => {
		const { context, invoke, getCaptured } = createShortcutHarness(false);
		invoke();
		getCaptured()?.shutdown();

		expect(context.shutdownRequested).toBe(true);
		expect(context.shutdown).not.toHaveBeenCalled();

		await interactiveModePrototype.checkShutdownRequested.call(context);

		expect(context.shutdown).toHaveBeenCalledTimes(1);
	});

	it("keeps the command context idle shutdown behavior consistent", async () => {
		const { context, getShutdownHandler } = await createCommandHarness(true);
		getShutdownHandler()?.();

		expect(context.shutdownRequested).toBe(true);
		expect(context.shutdown).toHaveBeenCalledTimes(1);
	});
});
