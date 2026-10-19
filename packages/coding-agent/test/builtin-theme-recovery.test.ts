import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ResourceBehavior = "missing" | "malformed" | "invalid-semantic" | undefined;

const resources = vi.hoisted(() => ({
	dark: undefined as ResourceBehavior,
	light: undefined as ResourceBehavior,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((
		file: Parameters<typeof actual.readFileSync>[0],
		options?: Parameters<typeof actual.readFileSync>[1],
	) => {
		const pathText = String(file).replace(/\\/g, "/");
		const match = /\/modes\/interactive\/theme\/(dark|light)\.json$/.exec(pathText);
		const behavior = match ? resources[match[1] as "dark" | "light"] : undefined;
		if (behavior === "missing") {
			const error = new Error(`ENOENT: no such file or directory, open '${pathText}'`) as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		if (behavior === "malformed") return "{";
		if (behavior === "invalid-semantic") {
			const content = actual.readFileSync(file as never, "utf-8") as string;
			const json = JSON.parse(content) as { colors: Record<string, unknown> };
			json.colors.accent = "missing-emergency-var";
			return JSON.stringify(json);
		}
		return actual.readFileSync(file as never, options as never);
	}) as unknown as typeof actual.readFileSync;
	return { ...actual, readFileSync };
});

const ANSI = {
	darkAccent: "\x1b[38;2;138;190;183m",
	lightAccent: "\x1b[38;2;90;128;128m",
	emergencyAccent: "\x1b[38;5;6m",
} as const;

let warnings: ReturnType<typeof vi.spyOn>;

async function loadFreshThemes() {
	vi.resetModules();
	const tui = await import("@metis/tui");
	tui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const theme = await import("../src/presentation/theme.ts");
	const legacyTheme = await import("../src/modes/interactive/theme/theme.ts");
	return { theme, legacyTheme };
}

beforeEach(() => {
	resources.dark = undefined;
	resources.light = undefined;
	warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("builtin theme recovery", () => {
	it("keeps healthy dark and light output and the legacy import path", async () => {
		const { theme, legacyTheme } = await loadFreshThemes();

		expect(legacyTheme.theme).toBe(theme.theme);
		expect(legacyTheme.initTheme).toBe(theme.initTheme);
		expect(legacyTheme.getMarkdownTheme).toBe(theme.getMarkdownTheme);

		theme.initTheme("dark");
		expect(theme.theme.name).toBe("dark");
		expect(theme.theme.getFgAnsi("accent")).toBe(ANSI.darkAccent);
		expect(theme.getResolvedThemeColors()).toMatchObject({ mdHeading: "#f0c674", accent: "#8abeb7" });

		expect(theme.setTheme("light")).toEqual({ success: true });
		expect(theme.theme.name).toBe("light");
		expect(theme.theme.getFgAnsi("accent")).toBe(ANSI.lightAccent);
		expect(theme.getResolvedThemeColors("light")).toMatchObject({ mdHeading: "#9a7326", accent: "#5a8080" });
		expect(warnings).not.toHaveBeenCalled();
	});

	it("uses an emergency dark theme when only the dark resource is missing", async () => {
		resources.dark = "missing";
		const { theme } = await loadFreshThemes();

		expect(() => theme.initTheme("dark")).not.toThrow();
		expect(theme.theme.name).toBe("dark");
		expect(theme.theme.getFgAnsi("accent")).toBe(ANSI.emergencyAccent);
		expect(theme.theme.getFgAnsi("error")).toBe("\x1b[38;5;1m");
		expect(theme.getAvailableThemes()).toEqual(expect.arrayContaining(["dark", "light"]));
		expect(theme.getThemeByName("light")?.getFgAnsi("accent")).toBe(ANSI.lightAccent);
		expect(theme.getResolvedThemeColors("dark").accent).toBe("#008080");

		expect(warnings).toHaveBeenCalledTimes(1);
		expect(String(warnings.mock.calls[0]?.[0])).toMatch(/dark[\s\S]*ENOENT/i);

		theme.initTheme("dark");
		theme.getThemeByName("dark");
		theme.getAvailableThemes();
		expect(warnings).toHaveBeenCalledTimes(1);
	});

	it("uses an emergency light theme for malformed JSON without invalidating dark", async () => {
		resources.light = "malformed";
		const { theme } = await loadFreshThemes();

		expect(() => theme.initTheme("light")).not.toThrow();
		expect(theme.theme.name).toBe("light");
		expect(theme.theme.getFgAnsi("accent")).toBe(ANSI.emergencyAccent);
		expect(theme.getThemeByName("dark")?.getFgAnsi("accent")).toBe(ANSI.darkAccent);
		expect(theme.getResolvedThemeColors("light").accent).toBe("#008080");
		expect(theme.getThemeExportColors("light")).toEqual({});

		expect(warnings).toHaveBeenCalledTimes(1);
		expect(String(warnings.mock.calls[0]?.[0])).toMatch(/light[\s\S]*parse/i);
	});

	it("falls back for a semantically invalid dark resource", async () => {
		resources.dark = "invalid-semantic";
		const { theme } = await loadFreshThemes();

		expect(() => theme.initTheme("dark")).not.toThrow();
		expect(theme.theme.getFgAnsi("accent")).toBe(ANSI.emergencyAccent);
		expect(theme.getThemeByName("light")?.getFgAnsi("accent")).toBe(ANSI.lightAccent);

		expect(warnings).toHaveBeenCalledTimes(1);
		expect(String(warnings.mock.calls[0]?.[0])).toMatch(/dark[\s\S]*missing-emergency-var/i);
	});

	it("starts with both builtin resources missing", async () => {
		resources.dark = "missing";
		resources.light = "missing";
		const { theme } = await loadFreshThemes();

		expect(() => theme.initTheme()).not.toThrow();
		expect(theme.theme.name).toBe("dark");
		expect(theme.getAvailableThemes()).toEqual(expect.arrayContaining(["dark", "light"]));
		expect(theme.getThemeByName("light")?.getFgAnsi("accent")).toBe(ANSI.emergencyAccent);
		expect(warnings).toHaveBeenCalledTimes(2);
	});
});
