import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { basename } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const mocks = vi.hoisted(() => ({ spawnProcess: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

vi.mock("../src/utils/child-process.ts", () => ({ spawnProcess: mocks.spawnProcess }));

const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

type Lifecycle = {
	order: string[];
	spawnedFile: string | undefined;
	cleanupObservedAtStart: boolean[];
};

function createLifecycle(): Lifecycle {
	return { order: [], spawnedFile: undefined, cleanupObservedAtStart: [] };
}

function createUi(lifecycle: Lifecycle) {
	return {
		stop: vi.fn(() => lifecycle.order.push("stop")),
		start: vi.fn(() => {
			lifecycle.order.push("start");
			lifecycle.cleanupObservedAtStart.push(
				lifecycle.spawnedFile === undefined ? true : !fs.existsSync(lifecycle.spawnedFile),
			);
		}),
		requestRender: vi.fn(() => lifecycle.order.push("render")),
	};
}

type Harness = {
	initialText: string;
	fileNamePattern: RegExp;
	expectedCommand: string;
	expectedArgs: string[];
	errors: string[];
	editor: { setText: ReturnType<typeof vi.fn> };
	replaceEditor: (editor: { getText?: ReturnType<typeof vi.fn>; setText: ReturnType<typeof vi.fn> }) => void;
	invoke: () => Promise<void>;
};

function createInteractiveHarness(lifecycle: Lifecycle): Harness {
	const errors: string[] = [];
	const editor = {
		getExpandedText: vi.fn(() => "expanded text"),
		getText: vi.fn(() => "collapsed text"),
		setText: vi.fn((_text: string) => lifecycle.order.push("setText")),
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: { settingsManager: { getExternalEditorCommand: () => "test-editor --flag" } } },
		editor,
		ui: createUi(lifecycle),
		showError: vi.fn((message: string) => {
			errors.push(message);
			lifecycle.order.push("error");
		}),
	});

	return {
		initialText: "expanded text",
		fileNamePattern: /^metis-editor-\d+\.metis\.md$/,
		expectedCommand: "test-editor",
		expectedArgs: ["--flag"],
		errors,
		editor,
		replaceEditor: (replacement) => {
			(mode as any).editor = replacement;
		},
		invoke: () => (InteractiveMode.prototype as any).openExternalEditor.call(mode),
	};
}

function createExtensionHarness(lifecycle: Lifecycle): Harness {
	const errors: string[] = [];
	const editor = {
		getText: vi.fn(() => "extension text"),
		setText: vi.fn((_text: string) => lifecycle.order.push("setText")),
	};
	const component = Object.assign(Object.create(ExtensionEditorComponent.prototype), {
		editor,
		tui: createUi(lifecycle),
		externalEditorCommand: "ext-editor",
		addChild: vi.fn((child: { text?: string }) => {
			errors.push(child.text ?? "");
			lifecycle.order.push("error");
		}),
	});

	return {
		initialText: "extension text",
		fileNamePattern: /^metis-extension-editor-\d+\.md$/,
		expectedCommand: "ext-editor",
		expectedArgs: [],
		errors,
		editor,
		replaceEditor: (replacement) => {
			(component as any).editor = replacement;
		},
		invoke: () => (ExtensionEditorComponent.prototype as any).openExternalEditor.call(component),
	};
}

type Scenario = "success" | "nonzero" | "spawnError" | "writeError" | "readError";

async function runScenario(harness: Harness, lifecycle: Lifecycle, scenario: Scenario): Promise<void> {
	if (scenario === "writeError") {
		mockedWriteFileSync.mockImplementationOnce(() => {
			throw new Error("disk full");
		});
	}

	mocks.spawnProcess.mockImplementation(((_command: string, args: string[]) => {
		const filePath = args.at(-1);
		if (!filePath) throw new Error("missing temporary file argument");
		lifecycle.spawnedFile = filePath;
		lifecycle.order.push("spawn");
		const child = new EventEmitter();

		if (scenario === "success") {
			expect(fs.readFileSync(filePath, "utf-8")).toBe(harness.initialText);
			fs.writeFileSync(filePath, "updated\n\n");
			queueMicrotask(() => child.emit("close", 0));
		} else if (scenario === "nonzero") {
			fs.writeFileSync(filePath, "changed\n");
			queueMicrotask(() => child.emit("close", 3));
		} else if (scenario === "spawnError") {
			queueMicrotask(() => child.emit("error", new Error("ENOENT")));
		} else if (scenario === "readError") {
			fs.unlinkSync(filePath);
			queueMicrotask(() => child.emit("close", 0));
		}

		return child;
	}) as never);

	await harness.invoke();
}

const kinds = [
	["interactive mode", createInteractiveHarness],
	["extension editor", createExtensionHarness],
] as const;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.spawnProcess.mockReset();
});

for (const [kind, createHarness] of kinds) {
	describe(kind, () => {
		it("replaces text before cleanup and restart on success", async () => {
			const lifecycle = createLifecycle();
			const harness = createHarness(lifecycle);

			await runScenario(harness, lifecycle, "success");

			expect(mocks.spawnProcess).toHaveBeenCalledWith(
				harness.expectedCommand,
				[...harness.expectedArgs, lifecycle.spawnedFile],
				{ stdio: "inherit" },
			);
			expect(basename(lifecycle.spawnedFile!)).toMatch(harness.fileNamePattern);
			expect(harness.editor.setText).toHaveBeenCalledWith("updated\n");
			expect(harness.errors).toEqual([]);
			expect(lifecycle.order).toEqual(["stop", "spawn", "setText", "start", "render"]);
			expect(lifecycle.cleanupObservedAtStart).toEqual([true]);
			expect(fs.existsSync(lifecycle.spawnedFile!)).toBe(false);
		});

		it("applies the result to the editor that is current when the launch completes", async () => {
			const lifecycle = createLifecycle();
			const harness = createHarness(lifecycle);
			const replacement = {
				getText: vi.fn(() => "replacement text"),
				setText: vi.fn((_text: string) => lifecycle.order.push("setText")),
			};

			mocks.spawnProcess.mockImplementation(((_command: string, args: string[]) => {
				const filePath = args.at(-1);
				if (!filePath) throw new Error("missing temporary file argument");
				lifecycle.spawnedFile = filePath;
				lifecycle.order.push("spawn");
				expect(fs.readFileSync(filePath, "utf-8")).toBe(harness.initialText);
				fs.writeFileSync(filePath, "updated\n");
				const child = new EventEmitter();
				queueMicrotask(() => child.emit("close", 0));
				return child;
			}) as never);

			const pending = harness.invoke();
			harness.replaceEditor(replacement);
			await pending;

			expect(replacement.getText).not.toHaveBeenCalled();
			expect(harness.editor.setText).not.toHaveBeenCalled();
			expect(replacement.setText).toHaveBeenCalledTimes(1);
			expect(replacement.setText).toHaveBeenCalledWith("updated");
			expect(lifecycle.order).toEqual(["stop", "spawn", "setText", "start", "render"]);
			expect(fs.existsSync(lifecycle.spawnedFile!)).toBe(false);
		});

		it("keeps the original text on a non-zero exit", async () => {
			const lifecycle = createLifecycle();
			const harness = createHarness(lifecycle);

			await runScenario(harness, lifecycle, "nonzero");

			expect(harness.editor.setText).not.toHaveBeenCalled();
			expect(harness.errors).toEqual([]);
			expect(lifecycle.order).toEqual(["stop", "spawn", "start", "render"]);
			expect(lifecycle.cleanupObservedAtStart).toEqual([true]);
			expect(fs.existsSync(lifecycle.spawnedFile!)).toBe(false);
		});

		it("shows spawn failures before cleanup and restart", async () => {
			const lifecycle = createLifecycle();
			const harness = createHarness(lifecycle);

			await runScenario(harness, lifecycle, "spawnError");

			expect(harness.editor.setText).not.toHaveBeenCalled();
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toContain("Failed to launch external editor: ENOENT");
			expect(lifecycle.order).toEqual(["stop", "spawn", "error", "start", "render"]);
			expect(lifecycle.cleanupObservedAtStart).toEqual([true]);
			expect(fs.existsSync(lifecycle.spawnedFile!)).toBe(false);
		});

		it("shows write failures without stopping the TUI, then restarts", async () => {
			const lifecycle = createLifecycle();
			const harness = createHarness(lifecycle);

			await runScenario(harness, lifecycle, "writeError");

			expect(mocks.spawnProcess).not.toHaveBeenCalled();
			expect(harness.editor.setText).not.toHaveBeenCalled();
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toContain("Failed to launch external editor: disk full");
			expect(lifecycle.order).toEqual(["error", "start", "render"]);
			expect(lifecycle.cleanupObservedAtStart).toEqual([true]);
		});

		it("shows read failures after the editor exits, then cleans up", async () => {
			const lifecycle = createLifecycle();
			const harness = createHarness(lifecycle);

			await runScenario(harness, lifecycle, "readError");

			expect(harness.editor.setText).not.toHaveBeenCalled();
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toContain("Failed to launch external editor: ENOENT");
			expect(lifecycle.order).toEqual(["stop", "spawn", "error", "start", "render"]);
			expect(lifecycle.cleanupObservedAtStart).toEqual([true]);
			expect(fs.existsSync(lifecycle.spawnedFile!)).toBe(false);
		});
	});
}
