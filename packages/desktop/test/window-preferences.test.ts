import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMainWindow } from "../src/main/window.ts";

const electronState = vi.hoisted(() => {
	const windows: FakeWindow[] = [];
	class FakeWindow {
		readonly listeners = new Map<string, Set<() => void>>();
		readonly options: { width: number; height: number; minWidth: number; minHeight: number };
		destroyed = false;
		maximized = false;
		normalBounds = { x: 80, y: 50, width: 1280, height: 840 };
		readonly show = vi.fn();
		readonly maximize = vi.fn(() => {
			this.maximized = true;
			this.emit("maximize");
		});
		readonly webContents = {
			setWindowOpenHandler: vi.fn(),
			on: vi.fn(),
			session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
		};

		constructor(options: FakeWindow["options"]) {
			this.options = options;
			this.normalBounds = { ...this.normalBounds, width: options.width, height: options.height };
			windows.push(this);
		}

		on(event: string, callback: () => void) {
			const handlers = this.listeners.get(event) ?? new Set<() => void>();
			handlers.add(callback);
			this.listeners.set(event, handlers);
			return this;
		}

		once(event: string, callback: () => void) {
			const handler = () => {
				this.listeners.get(event)?.delete(handler);
				callback();
			};
			return this.on(event, handler);
		}

		emit(event: string) {
			for (const callback of [...(this.listeners.get(event) ?? [])]) callback();
		}

		isDestroyed() {
			return this.destroyed;
		}

		isMaximized() {
			return this.maximized;
		}

		getNormalBounds() {
			if (this.destroyed) throw new Error("Window destroyed");
			return this.normalBounds;
		}
	}
	return { windows, FakeWindow, directory: "", workArea: { width: 1920, height: 1080 } };
});

vi.mock("electron", () => ({
	app: { getPath: () => electronState.directory },
	BrowserWindow: electronState.FakeWindow,
	nativeTheme: { themeSource: "dark" },
	shell: { openExternal: vi.fn() },
	screen: { getPrimaryDisplay: () => ({ workAreaSize: electronState.workArea }) },
}));

vi.mock("../src/main/theme-manager.ts", () => ({
	readStoredTheme: () => "dark",
	windowBackgroundFor: () => "#121212",
	windowsTitleBarOverlayFor: () => ({ color: "#121212", symbolColor: "#eeeeee", height: 32 }),
}));

const preferencesPath = () => join(electronState.directory, "window-preferences.json");

beforeEach(() => {
	electronState.directory = mkdtempSync(join(tmpdir(), "metis-window-preferences-"));
	electronState.windows.length = 0;
	electronState.workArea = { width: 1920, height: 1080 };
	vi.stubGlobal("MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY", "/test/preload.js");
	vi.useFakeTimers();
});

afterEach(() => {
	for (const window of electronState.windows) window.emit("closed");
	vi.useRealTimers();
	vi.unstubAllGlobals();
	rmSync(electronState.directory, { recursive: true, force: true });
});

describe("main window preferences", () => {
	it("restores the normal window size so the saved tools width has the same available space", () => {
		writeFileSync(preferencesPath(), JSON.stringify({ width: 1720, height: 940, maximized: false }));
		createMainWindow();
		expect(electronState.windows[0]!.options).toMatchObject({ width: 1720, height: 940 });
	});

	it.each([
		"not json",
		"null",
		"[]",
		JSON.stringify({ width: "1720", height: 940 }),
		JSON.stringify({ width: -1, height: 940 }),
		JSON.stringify({ width: 1720, height: 0 }),
		JSON.stringify({ width: null, height: 940 }),
		JSON.stringify({ width: 1720, height: 940, maximized: "true" }),
	])("uses the normal startup size for invalid preferences: %s", (contents) => {
		writeFileSync(preferencesPath(), contents);
		createMainWindow();
		expect(electronState.windows[0]!.options).toMatchObject({ width: 1280, height: 840 });
	});

	it("starts normally when preferences are missing", () => {
		createMainWindow();
		expect(electronState.windows[0]!.options).toMatchObject({ width: 1280, height: 840 });
	});

	it("limits a saved size to the current display without lowering the normal minimums", () => {
		writeFileSync(preferencesPath(), JSON.stringify({ width: 3000, height: 2000, maximized: false }));
		electronState.workArea = { width: 1440, height: 900 };
		createMainWindow();
		expect(electronState.windows[0]!.options).toMatchObject({
			width: 1440,
			height: 900,
			minWidth: 900,
			minHeight: 640,
		});
	});

	it("rounds native window dimensions and retains the existing minimum size", () => {
		writeFileSync(preferencesPath(), JSON.stringify({ width: 1720.6, height: 940.1, maximized: false }));
		createMainWindow();
		expect(electronState.windows[0]!.options).toMatchObject({ width: 1721, height: 940 });
		writeFileSync(preferencesPath(), JSON.stringify({ width: 50, height: 20, maximized: false }));
		createMainWindow();
		expect(electronState.windows[1]!.options).toMatchObject({ width: 900, height: 640 });
	});

	it("restores maximization after creating the window at its saved normal size", () => {
		writeFileSync(preferencesPath(), JSON.stringify({ width: 1600, height: 900, maximized: true }));
		createMainWindow();
		const window = electronState.windows[0]!;
		expect(window.options).toMatchObject({ width: 1600, height: 900 });
		expect(window.maximize).not.toHaveBeenCalled();
		window.emit("ready-to-show");
		expect(window.maximize).toHaveBeenCalledOnce();
		expect(window.show).toHaveBeenCalledOnce();
		window.emit("close");
		expect(JSON.parse(readFileSync(preferencesPath(), "utf8"))).toEqual({
			width: 1600,
			height: 900,
			maximized: true,
		});
	});

	it("combines repeated resizes and saves the latest normal bounds before a later restart", () => {
		createMainWindow();
		const window = electronState.windows[0]!;
		window.normalBounds = { x: 120, y: 90, width: 1440, height: 900 };
		window.emit("resize");
		vi.advanceTimersByTime(100);
		window.normalBounds = { x: 120, y: 90, width: 1720, height: 960 };
		window.emit("resize");
		expect(existsSync(preferencesPath())).toBe(false);
		vi.advanceTimersByTime(1000);
		expect(JSON.parse(readFileSync(preferencesPath(), "utf8"))).toEqual({
			width: 1720,
			height: 960,
			maximized: false,
		});
		createMainWindow();
		expect(electronState.windows[1]!.options).toMatchObject({ width: 1720, height: 960 });
		expect(readdirSync(electronState.directory)).toEqual(["window-preferences.json"]);
	});

	it("flushes a pending resize synchronously on close and clears its timer", () => {
		createMainWindow();
		const window = electronState.windows[0]!;
		window.normalBounds = { x: 80, y: 50, width: 1690, height: 920 };
		window.emit("resize");
		window.emit("close");
		expect(JSON.parse(readFileSync(preferencesPath(), "utf8"))).toMatchObject({ width: 1690, height: 920 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears pending writes when a window is destroyed", () => {
		createMainWindow();
		const window = electronState.windows[0]!;
		window.emit("resize");
		window.destroyed = true;
		window.emit("closed");
		expect(vi.getTimerCount()).toBe(0);
		expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
		expect(existsSync(preferencesPath())).toBe(false);
	});

	it("updates a saved maximized preference after returning to a normal window", () => {
		writeFileSync(preferencesPath(), JSON.stringify({ width: 1600, height: 900, maximized: true }));
		createMainWindow();
		const window = electronState.windows[0]!;
		window.emit("ready-to-show");
		window.maximized = false;
		window.emit("unmaximize");
		vi.advanceTimersByTime(1000);
		expect(JSON.parse(readFileSync(preferencesPath(), "utf8"))).toEqual({
			width: 1600,
			height: 900,
			maximized: false,
		});
	});

	it("keeps the app usable and removes temporary files when a preference write fails", () => {
		mkdirSync(preferencesPath());
		createMainWindow();
		const window = electronState.windows[0]!;
		expect(() => window.emit("close")).not.toThrow();
		expect(readdirSync(electronState.directory)).toEqual(["window-preferences.json"]);
	});
});
