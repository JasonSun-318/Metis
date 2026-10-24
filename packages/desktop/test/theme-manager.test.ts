import { beforeEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
	const listeners = new Map<string, Set<() => void>>();
	const nativeTheme = {
		themeSource: "system",
		shouldUseDarkColors: false,
		on: vi.fn((event: string, listener: () => void) => {
			let eventListeners = listeners.get(event);
			if (!eventListeners) {
				eventListeners = new Set();
				listeners.set(event, eventListeners);
			}
			eventListeners.add(listener);
		}),
		emit(event: string) {
			for (const listener of listeners.get(event) ?? []) listener();
		},
		clear() {
			listeners.clear();
		},
	};
	return { app: { getPath: () => "/tmp/metis-theme-test" }, nativeTheme };
});

const fsState = vi.hoisted(() => {
	let contents: string | null = null;
	let failWrites = false;
	return {
		reset() {
			contents = null;
			failWrites = false;
		},
		setWriteFailure(value: boolean) {
			failWrites = value;
		},
		read() {
			if (contents === null) throw new Error("No stored theme");
			return contents;
		},
		write(value: string) {
			if (failWrites) throw new Error("Theme persistence failed");
			contents = value;
		},
	};
});

vi.mock("electron", () => electron);
vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => fsState.read()),
	writeFileSync: vi.fn((_path: string, value: string) => fsState.write(value)),
}));

type FakeWindow = ReturnType<typeof makeWindow>;

function makeWindow(): {
	isDestroyed: ReturnType<typeof vi.fn>;
	setBackgroundColor: ReturnType<typeof vi.fn>;
	setTitleBarOverlay: ReturnType<typeof vi.fn>;
} {
	return {
		isDestroyed: vi.fn(() => false),
		setBackgroundColor: vi.fn(),
		setTitleBarOverlay: vi.fn(),
	};
}

function storeTheme(theme: string): void {
	fsState.write(JSON.stringify(theme));
}

async function register(getMainWindow: () => FakeWindow | null): Promise<(event: unknown, value: unknown) => unknown> {
	const handle = vi.fn();
	const { registerThemeHandlers } = await import("../src/main/theme-manager.ts");
	registerThemeHandlers(
		{ handle } as never,
		() => getMainWindow() as never,
		() => {},
	);
	return handle.mock.calls[0][1] as (event: unknown, value: unknown) => unknown;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	fsState.reset();
	electron.nativeTheme.clear();
	electron.nativeTheme.themeSource = "system";
	electron.nativeTheme.shouldUseDarkColors = false;
});

it("reapplies system native colors when the OS switches dark and light", async () => {
	storeTheme("system");
	const window = makeWindow();
	await register(() => window);

	expect(electron.nativeTheme.on).toHaveBeenCalledWith("updated", expect.any(Function));

	electron.nativeTheme.shouldUseDarkColors = true;
	electron.nativeTheme.emit("updated");
	expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#1f201e");

	electron.nativeTheme.shouldUseDarkColors = false;
	electron.nativeTheme.emit("updated");
	expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#faf9f6");
	expect(electron.nativeTheme.themeSource).toBe("system");
});

it("does not follow OS changes for an explicit theme preference", async () => {
	const window = makeWindow();
	const handler = await register(() => window);
	handler({}, "light");
	window.setBackgroundColor.mockClear();
	window.setTitleBarOverlay.mockClear();

	electron.nativeTheme.shouldUseDarkColors = true;
	electron.nativeTheme.emit("updated");

	expect(window.setBackgroundColor).not.toHaveBeenCalled();
	expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
	expect(electron.nativeTheme.themeSource).toBe("light");
});

it("keeps following system changes when preference persistence fails", async () => {
	const window = makeWindow();
	const handler = await register(() => window);
	fsState.setWriteFailure(true);
	handler({}, "system");
	expect(electron.nativeTheme.themeSource).toBe("system");
	window.setBackgroundColor.mockClear();

	electron.nativeTheme.shouldUseDarkColors = true;
	electron.nativeTheme.emit("updated");
	expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#1f201e");
});

it("keeps the listener safe with a null or destroyed main window", async () => {
	storeTheme("system");
	const window = makeWindow();
	let current: FakeWindow | null = null;
	await register(() => current);

	electron.nativeTheme.shouldUseDarkColors = true;
	expect(() => electron.nativeTheme.emit("updated")).not.toThrow();

	current = window;
	window.isDestroyed.mockReturnValue(true);
	expect(() => electron.nativeTheme.emit("updated")).not.toThrow();
	expect(window.setBackgroundColor).not.toHaveBeenCalled();
});

it("applies subsequent system updates to a replacement main window", async () => {
	storeTheme("system");
	const first = makeWindow();
	let current: FakeWindow | null = first;
	await register(() => current);

	electron.nativeTheme.shouldUseDarkColors = true;
	electron.nativeTheme.emit("updated");
	expect(first.setBackgroundColor).toHaveBeenLastCalledWith("#1f201e");

	const replacement = makeWindow();
	current = replacement;
	electron.nativeTheme.shouldUseDarkColors = false;
	electron.nativeTheme.emit("updated");
	expect(replacement.setBackgroundColor).toHaveBeenLastCalledWith("#faf9f6");
});

it("reapplies the Windows title bar overlay for system changes", async () => {
	storeTheme("system");
	const window = makeWindow();
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	try {
		await register(() => window);

		electron.nativeTheme.shouldUseDarkColors = true;
		electron.nativeTheme.emit("updated");
		expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({
			color: "#121212",
			symbolColor: "#e8e8e8",
			height: 32,
		});

		electron.nativeTheme.shouldUseDarkColors = false;
		electron.nativeTheme.emit("updated");
		expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({
			color: "#faf9f6",
			symbolColor: "#202020",
			height: 32,
		});
	} finally {
		if (platform) Object.defineProperty(process, "platform", platform);
	}
});
