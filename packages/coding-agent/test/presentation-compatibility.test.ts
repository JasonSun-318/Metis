import type { WatchListener } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, resetCapabilitiesCache, setCapabilities, setKeybindings } from "@metis/tui";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCustomThemesDir } from "../src/config.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	getMarkdownTheme as getMarkdownThemeFromRoot,
	initTheme as initThemeFromRoot,
	keyHint as keyHintFromRoot,
	keyText as keyTextFromRoot,
	Theme as RootTheme,
	rawKeyHint as rawKeyHintFromRoot,
	renderDiff as renderDiffFromRoot,
	truncateToVisualLines as truncateToVisualLinesFromRoot,
} from "../src/index.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import {
	formatKeyText,
	keyDisplayText,
	keyHint,
	keyText,
	rawKeyHint,
} from "../src/modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../src/modes/interactive/components/visual-truncate.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getResolvedThemeColors,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	type ThemeBg,
	type ThemeColor,
	theme,
} from "../src/modes/interactive/theme/theme.ts";

const watchState = vi.hoisted(() => ({
	calls: [] as Array<{
		path: string;
		listener: WatchListener<string>;
		onError: () => void;
		watcher: { close: ReturnType<typeof vi.fn> };
	}>,
}));

vi.mock("../src/utils/fs-watch.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/fs-watch.ts")>();
	return {
		...actual,
		watchWithErrorHandler: (
			watchedPath: Parameters<typeof actual.watchWithErrorHandler>[0],
			listener: Parameters<typeof actual.watchWithErrorHandler>[1],
			onError: Parameters<typeof actual.watchWithErrorHandler>[2],
		) => {
			const watcher = { close: vi.fn() };
			watchState.calls.push({ path: watchedPath, listener, onError, watcher });
			return watcher as unknown as ReturnType<typeof actual.watchWithErrorHandler>;
		},
		closeWatcher: (watcher: Parameters<typeof actual.closeWatcher>[0]) => {
			watcher?.close();
		},
	};
});

const ANSI = {
	reset: "\x1b[39m",
	inverse: "\x1b[7m",
	inverseOff: "\x1b[27m",
	dim: "\x1b[38;2;102;102;102m",
	muted: "\x1b[38;2;128;128;128m",
	darkAccent: "\x1b[38;2;138;190;183m",
	lightAccent: "\x1b[38;2;90;128;128m",
	darkHeading: "\x1b[38;2;240;198;116m",
	lightHeading: "\x1b[38;2;154;115;38m",
	diffAdded: "\x1b[38;2;181;189;104m",
	diffRemoved: "\x1b[38;2;204;102;102m",
	diffContext: "\x1b[38;2;128;128;128m",
} as const;

const darkThemeJson = JSON.parse(
	readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
) as {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

function fg(color: string, text: string): string {
	return `${color}${text}${ANSI.reset}`;
}

function makeTheme(name: string, accent: string, options: { sourcePath?: string } = {}): Theme {
	return new Theme(
		{ accent, thinkingXhigh: "#000000" } as Record<ThemeColor, string | number>,
		{ selectedBg: "#040506" } as Record<ThemeBg, string | number>,
		"truecolor",
		{ name, sourcePath: options.sourcePath },
	);
}

function writeCustomTheme(fileName: string, name: string, accent: string): string {
	const themesDir = getCustomThemesDir();
	mkdirSync(themesDir, { recursive: true });
	const themePath = join(themesDir, fileName);
	const themeJson = {
		...darkThemeJson,
		name,
		colors: { ...darkThemeJson.colors, accent },
	};
	writeFileSync(themePath, JSON.stringify(themeJson, null, 2));
	return themePath;
}

function lastWatchCall(): (typeof watchState.calls)[number] {
	const call = watchState.calls.at(-1);
	if (!call) throw new Error("Expected a theme watcher to be registered");
	return call;
}

let tempRoot: string;
let previousKeybindings: ReturnType<typeof getKeybindings>;
let previousChalkLevel: typeof chalk.level;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "metis-presentation-compat-"));
	vi.stubEnv("METIS_CODING_AGENT_DIR", join(tempRoot, "agent"));
	mkdirSync(getCustomThemesDir(), { recursive: true });
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager());
	previousChalkLevel = chalk.level;
	setRegisteredThemes([]);
	watchState.calls.length = 0;
	onThemeChange(() => {});
	initTheme("dark");
});

afterEach(() => {
	stopThemeWatcher();
	vi.useRealTimers();
	onThemeChange(() => {});
	setRegisteredThemes([]);
	initTheme("dark");
	setKeybindings(previousKeybindings);
	chalk.level = previousChalkLevel;
	resetCapabilitiesCache();
	vi.unstubAllEnvs();
	delete (globalThis as Record<string, unknown>).__metisPresentationCompatProbe;
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("theme registration and active theme lifecycle", () => {
	it("replaces the registered theme map by content name and exposes source paths", () => {
		const first = makeTheme("registry-one", "#101010", { sourcePath: "/themes/first.json" });
		const second = makeTheme("registry-two", "#202020", { sourcePath: "/themes/second.json" });
		const replacement = makeTheme("registry-one", "#303030");

		setRegisteredThemes([first, second, replacement]);

		expect(getThemeByName("registry-one")).toBe(replacement);
		expect(getThemeByName("registry-two")).toBe(second);
		expect(getAvailableThemesWithPaths()).toContainEqual({ name: "registry-one", path: undefined });
		expect(getAvailableThemesWithPaths()).toContainEqual({ name: "registry-two", path: "/themes/second.json" });
		expect(getAvailableThemes()).toEqual(expect.arrayContaining(["dark", "light", "registry-one", "registry-two"]));

		setRegisteredThemes([]);
		expect(getThemeByName("registry-one")).toBeUndefined();
	});

	it("rejects registered theme names containing the auto-theme slash", () => {
		expect(() => setRegisteredThemes([makeTheme("bad/name", "#000000")])).toThrow(
			'Invalid theme name "bad/name": theme names cannot contain "/"',
		);
	});

	it("switches built-in themes, reports current-theme state and notifies only the latest callback", () => {
		const firstCallback = vi.fn();
		const latestCallback = vi.fn();
		onThemeChange(firstCallback);
		onThemeChange(latestCallback);

		initTheme("dark");
		expect(theme.name).toBe("dark");
		expect(theme.getColorMode()).toBe("truecolor");
		expect(theme.getFgAnsi("accent")).toBe(ANSI.darkAccent);
		expect(getResolvedThemeColors().mdHeading).toBe("#f0c674");
		expect(latestCallback).not.toHaveBeenCalled();

		expect(setTheme("light")).toEqual({ success: true });
		expect(theme.name).toBe("light");
		expect(theme.getFgAnsi("accent")).toBe(ANSI.lightAccent);
		expect(getResolvedThemeColors().mdHeading).toBe("#9a7326");
		expect(firstCallback).not.toHaveBeenCalled();
		expect(latestCallback).toHaveBeenCalledTimes(1);
	});

	it("falls back to dark without notifying when a theme cannot be loaded", () => {
		const callback = vi.fn();
		onThemeChange(callback);

		expect(setTheme("definitely-missing")).toEqual({
			success: false,
			error: "Theme not found: definitely-missing",
		});
		expect(theme.name).toBe("dark");
		expect(theme.getFgAnsi("accent")).toBe(ANSI.darkAccent);
		expect(callback).not.toHaveBeenCalled();

		expect(() => initTheme("also-missing")).not.toThrow();
		expect(theme.name).toBe("dark");
		expect(callback).not.toHaveBeenCalled();
	});

	it("loads registered themes without a source file", () => {
		const registered = makeTheme("registered-active", "#0a0b0c");
		setRegisteredThemes([registered]);

		expect(setTheme("registered-active")).toEqual({ success: true });
		expect(theme.name).toBe("registered-active");
		expect(theme.getFgAnsi("accent")).toBe("\x1b[38;2;10;11;12m");
	});

	it("installs an in-memory theme, stops the watcher and invokes the callback", () => {
		writeCustomTheme("instance-watch.json", "instance-watch", "#010101");
		expect(setTheme("instance-watch", true)).toEqual({ success: true });
		const watcher = lastWatchCall().watcher;
		const callback = vi.fn();
		onThemeChange(callback);
		const instance = makeTheme("instance-theme", "#112233");

		setThemeInstance(instance);

		expect(watcher.close).toHaveBeenCalledTimes(1);
		expect(theme.name).toBe("instance-theme");
		expect(theme.fg("accent", "x")).toBe("\x1b[38;2;17;34;51mx\x1b[39m");
		expect(theme.bg("selectedBg", "y")).toBe("\x1b[48;2;4;5;6my\x1b[49m");
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("keeps root theme utilities on the old theme path implementation", () => {
		expect(RootTheme).toBe(Theme);
		initThemeFromRoot("light");
		expect(theme.name).toBe("light");
		expect(getMarkdownThemeFromRoot().heading("heading")).toBe(fg(ANSI.lightHeading, "heading"));
	});
});

describe("theme watcher reloads", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		watchState.calls.length = 0;
		initTheme("dark");
	});

	afterEach(() => {
		stopThemeWatcher();
		vi.useRealTimers();
	});

	it("does not watch built-in themes", () => {
		expect(setTheme("dark", true)).toEqual({ success: true });
		expect(watchState.calls).toHaveLength(0);
	});

	it("debounces one reload, updates the active theme and notifies once", () => {
		const themePath = writeCustomTheme("watch-reload.json", "watch-reload", "#111111");
		expect(setTheme("watch-reload", true)).toEqual({ success: true });
		expect(watchState.calls).toHaveLength(1);
		expect(lastWatchCall().path).toBe(getCustomThemesDir());

		const callback = vi.fn();
		onThemeChange(callback);
		writeCustomTheme("watch-reload.json", "watch-reload", "#222222");

		lastWatchCall().listener("change", "watch-reload.json");
		vi.advanceTimersByTime(99);
		expect(callback).not.toHaveBeenCalled();
		expect(theme.getFgAnsi("accent")).toBe("\x1b[38;2;17;17;17m");

		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(theme.getFgAnsi("accent")).toBe("\x1b[38;2;34;34;34m");
		expect(getThemeByName("watch-reload")?.getFgAnsi("accent")).toBe("\x1b[38;2;34;34;34m");
		expect(getThemeByName("watch-reload")?.sourcePath).toBe(themePath);
	});

	it("ignores a scheduled reload after switching to another theme", () => {
		writeCustomTheme("watch-stale.json", "watch-stale", "#111111");
		expect(setTheme("watch-stale", true)).toEqual({ success: true });

		const callback = vi.fn();
		onThemeChange(callback);
		lastWatchCall().listener("change", "watch-stale.json");
		expect(setTheme("light")).toEqual({ success: true });
		expect(callback).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(100);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(theme.name).toBe("light");
		expect(theme.getFgAnsi("accent")).toBe(ANSI.lightAccent);
	});

	it("clears a pending reload and closes the watcher on cancellation", () => {
		writeCustomTheme("watch-cancel.json", "watch-cancel", "#111111");
		expect(setTheme("watch-cancel", true)).toEqual({ success: true });
		const watcher = lastWatchCall().watcher;
		const callback = vi.fn();
		onThemeChange(callback);
		lastWatchCall().listener("change", "watch-cancel.json");

		stopThemeWatcher();

		expect(watcher.close).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1_000);
		expect(callback).not.toHaveBeenCalled();
		expect(theme.getFgAnsi("accent")).toBe("\x1b[38;2;17;17;17m");
	});

	it("keeps the last loaded theme when the watched file disappears", () => {
		const themePath = writeCustomTheme("watch-missing.json", "watch-missing", "#111111");
		expect(setTheme("watch-missing", true)).toEqual({ success: true });
		const callback = vi.fn();
		onThemeChange(callback);

		rmSync(themePath);
		lastWatchCall().listener("change", "watch-missing.json");
		vi.advanceTimersByTime(100);

		expect(callback).not.toHaveBeenCalled();
		expect(theme.name).toBe("watch-missing");
		expect(theme.getFgAnsi("accent")).toBe("\x1b[38;2;17;17;17m");
	});

	it("closes the watcher through the error handler", () => {
		writeCustomTheme("watch-error.json", "watch-error", "#111111");
		expect(setTheme("watch-error", true)).toEqual({ success: true });
		const watcher = lastWatchCall().watcher;

		lastWatchCall().onError();

		expect(watcher.close).toHaveBeenCalledTimes(1);
	});
});

describe("keybinding hint formatting", () => {
	it("keeps key text, display text and default bindings exact", () => {
		expect(formatKeyText("ctrl+a/shift+b")).toBe("ctrl+a/shift+b");
		expect(formatKeyText("ctrl+a/shift+b", { capitalize: true })).toBe("Ctrl+A/Shift+B");
		const altLabel = process.platform === "darwin" ? "Option" : "Alt";
		expect(formatKeyText("alt+enter", { capitalize: true })).toBe(`${altLabel}+Enter`);
		expect(keyText("app.tools.expand")).toBe("ctrl+o");
		expect(keyDisplayText("app.tools.expand")).toBe("Ctrl+O");
		expect(keyText("app.session.new")).toBe("");
		expect(keyDisplayText("app.session.new")).toBe("");
		expect(keyTextFromRoot("app.tools.expand")).toBe("ctrl+o");
	});

	it("keeps exact hint formatting on the old path and root exports", () => {
		const expectedRaw = `${ANSI.dim}ctrl+a/shift+b${ANSI.reset}${ANSI.muted} save${ANSI.reset}`;
		const expectedHint = `${ANSI.dim}ctrl+o${ANSI.reset}${ANSI.muted} expand${ANSI.reset}`;

		expect(rawKeyHint("ctrl+a/shift+b", "save")).toBe(expectedRaw);
		expect(keyHint("app.tools.expand", "expand")).toBe(expectedHint);
		expect(rawKeyHintFromRoot("ctrl+a/shift+b", "save")).toBe(expectedRaw);
		expect(keyHintFromRoot("app.tools.expand", "expand")).toBe(expectedHint);
	});
});

describe("diff rendering", () => {
	it("renders one modified line with exact intra-line inverse", () => {
		chalk.level = 3;
		const expected = `${fg(ANSI.diffRemoved, `-1 ${ANSI.inverse}old${ANSI.inverseOff} value`)}\n${fg(
			ANSI.diffAdded,
			`+1 ${ANSI.inverse}new${ANSI.inverseOff} value`,
		)}`;
		const diff = "-1 old value\n+1 new value";

		expect(renderDiff(diff)).toBe(expected);
		expect(renderDiff(diff, { filePath: "legacy.ts" })).toBe(expected);
		expect(renderDiffFromRoot(diff)).toBe(expected);
	});

	it("renders multi-line and context blocks without intra-line diffing", () => {
		const expected = [
			fg(ANSI.diffContext, " 1 old value"),
			fg(ANSI.diffRemoved, "-2 old line"),
			fg(ANSI.diffRemoved, "-3 second old"),
			fg(ANSI.diffAdded, "+2 new line"),
			fg(ANSI.diffAdded, "+3 second new"),
		].join("\n");

		expect(renderDiff(" 1 old value\n-2 old line\n-3 second old\n+2 new line\n+3 second new")).toBe(expected);
	});

	it("renders non-diff, standalone added and standalone removed lines exactly", () => {
		const expected = [
			fg(ANSI.diffContext, "not a diff line"),
			fg(ANSI.diffAdded, "+7 added"),
			fg(ANSI.diffRemoved, "-8 removed"),
		].join("\n");

		expect(renderDiff("not a diff line\n+7 added\n-8 removed")).toBe(expected);
	});

	it("keeps colored output without intra-line inverses when chalk is disabled", () => {
		chalk.level = 0;
		const expected = [fg(ANSI.diffRemoved, "-1 old value"), fg(ANSI.diffAdded, "+1 new value")].join("\n");

		expect(renderDiff("-1 old value\n+1 new value")).toBe(expected);
	});
});

describe("visual line truncation", () => {
	it("keeps empty text and default padding behavior", () => {
		expect(truncateToVisualLines("", 2, 4)).toEqual({ visualLines: [], skippedCount: 0 });
		expect(truncateToVisualLines("aaaa\nbbbb\ncccc", 2, 4)).toEqual({
			visualLines: ["bbbb", "cccc"],
			skippedCount: 1,
		});
		expect(truncateToVisualLines("aaaa\nbbbb\ncccc", 2, 4, 0)).toEqual({
			visualLines: ["bbbb", "cccc"],
			skippedCount: 1,
		});
		expect(truncateToVisualLines("aaaa\nbbbb", 5, 4)).toEqual({
			visualLines: ["aaaa", "bbbb"],
			skippedCount: 0,
		});
		expect(truncateToVisualLinesFromRoot("aaaa\nbbbb\ncccc", 2, 4)).toEqual({
			visualLines: ["bbbb", "cccc"],
			skippedCount: 1,
		});
	});
});

describe("jiti extension loading", () => {
	it("shares the active theme across the real extension loader and host module", async () => {
		const extensionRoot = join(tempRoot, "extension-root");
		mkdirSync(extensionRoot, { recursive: true });
		const extensionPath = join(extensionRoot, "presentation-probe.ts");
		writeFileSync(
			extensionPath,
			[
				'import { getMarkdownTheme } from "@metis/coding-agent";',
				"",
				"const readTheme = () => ({",
				'  heading: getMarkdownTheme().heading("heading"),',
				"});",
				"",
				"export default function (metis) {",
				"  globalThis.__metisPresentationCompatProbe = readTheme();",
				'  metis.registerCommand("presentation-probe", {',
				'    description: "presentation compatibility probe",',
				"    handler: async () => {",
				"      globalThis.__metisPresentationCompatProbe = readTheme();",
				"    },",
				"  });",
				"}",
				"",
			].join("\n"),
		);

		initTheme("light");
		const result = await loadExtensions([extensionPath], extensionRoot);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);

		const probe = (globalThis as Record<string, unknown>).__metisPresentationCompatProbe as {
			heading: string;
		};
		expect(probe).toEqual({
			heading: fg(ANSI.lightHeading, "heading"),
		});

		const command = result.extensions[0]?.commands.get("presentation-probe");
		expect(command).toBeDefined();
		initTheme("dark");
		await command!.handler("", {} as never);

		expect((globalThis as Record<string, unknown>).__metisPresentationCompatProbe).toEqual({
			heading: fg(ANSI.darkHeading, "heading"),
		});

		delete (globalThis as Record<string, unknown>).__metisPresentationCompatProbe;
	});
});
