import { beforeEach, expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS, DESKTOP_THEME_CHANNEL, type MetisDesktopApi } from "../src/shared/desktop-api.ts";

const electron = vi.hoisted(() => ({
	contextBridge: { exposeInMainWorld: vi.fn() },
	ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
	webUtils: { getPathForFile: vi.fn() },
	app: {
		getPath: () => {
			throw new Error("No test profile");
		},
	},
	nativeTheme: { themeSource: "system", shouldUseDarkColors: true },
}));
vi.mock("electron", () => electron);

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

it("grants only native File paths and waits for the grant before creating a project", async () => {
	let grant!: () => void;
	electron.ipcRenderer.invoke.mockImplementation(async (channel) => {
		if (channel === DESKTOP_IPC_CHANNELS.registerDroppedFiles)
			await new Promise<void>((resolve) => {
				grant = resolve;
			});
		return "/projects/Demo";
	});
	electron.webUtils.getPathForFile.mockImplementation((file) => {
		if (file !== nativeFile) throw new Error("Not a native File");
		return "/picked/report.txt";
	});
	const nativeFile = { name: "report.txt" };
	await import("../src/preload.ts");
	const api = electron.contextBridge.exposeInMainWorld.mock.calls[0][1] as MetisDesktopApi;
	expect("readDeliveredFile" in api).toBe(false);
	expect("registerDroppedFiles" in api).toBe(false);
	expect(() => api.resolveDroppedFiles([{ path: "/private/secret" } as unknown as File])).toThrow("Not a native File");
	const files = api.resolveDroppedFiles([nativeFile as File]);
	expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.registerDroppedFiles, [
		"/picked/report.txt",
	]);
	const result = api.createProjectFolder({ parentDirectory: "/projects", name: "Demo", files });
	expect(electron.ipcRenderer.invoke).not.toHaveBeenCalledWith(
		DESKTOP_IPC_CHANNELS.createProjectFolder,
		expect.anything(),
	);
	grant();
	await expect(result).resolves.toBe("/projects/Demo");
});

it("validates theme senders before reading or changing preferences", async () => {
	const { registerThemeHandlers } = await import("../src/main/theme-manager.ts");
	const handle = vi.fn();
	const setBackgroundColor = vi.fn();
	const trusted = {};
	registerThemeHandlers(
		{ handle } as never,
		() => ({ isDestroyed: () => false, setBackgroundColor }) as never,
		(event) => {
			if (event !== trusted) throw new Error("Untrusted desktop IPC sender");
		},
	);
	expect(handle.mock.calls[0][0]).toBe(DESKTOP_THEME_CHANNEL);
	const handler = handle.mock.calls[0][1];
	expect(() => handler({}, "get")).toThrow("Untrusted");
	expect(() => handler({}, "light")).toThrow("Untrusted");
	expect(setBackgroundColor).not.toHaveBeenCalled();
	handler(trusted, "light");
	expect(setBackgroundColor).toHaveBeenCalledWith("#faf9f6");
});
