import type { ClientParams, ClientRequestMethod, InteractionResponseInput } from "@metis/app-protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron";
import { createDesktopRpcForwarders } from "./shared/app-server-rpc-forwarding.ts";
import {
	DESKTOP_BROWSER_EVENT_CHANNEL,
	DESKTOP_EVENT_CHANNEL,
	DESKTOP_IPC_CHANNELS,
	DESKTOP_TERMINAL_EVENT_CHANNEL,
	DESKTOP_THEME_CHANNEL,
	DESKTOP_UPDATE_EVENT_CHANNEL,
	type DesktopApiEvent,
	type DesktopBrowserEvent,
	type DesktopTerminalEvent,
	type DesktopThemePreference,
	type DesktopUpdateState,
	type MetisDesktopApi,
	validateBrowserControlInput,
	validateBrowserDownloadControlInput,
	validateBrowserDownloadList,
	validateBrowserHistoryList,
	validateBrowserImportInput,
	validateBrowserImportResult,
	validateBrowserImportSourceList,
	validateBrowserProfileList,
	validateCloseBrowserInput,
	validateCloseTerminalInput,
	validateCreateBrowserInput,
	validateCreateTerminalInput,
	validateDesktopApiEvent,
	validateDesktopBrowserEvent,
	validateDesktopClientParams,
	validateDesktopTerminalEvent,
	validateDesktopUpdateState,
	validateInteractionResponseInput,
	validateListBrowserHistoryInput,
	validateListWorkspaceDirectoryInput,
	validateOpenWorkspaceFileInput,
	validateReadPreviewFileInput,
	validateReadWorkspaceFileInput,
	validateResizeTerminalInput,
	validateResolveBrowserHandoffInput,
	validateSearchWorkspaceFilesInput,
	validateWorkspaceEditState,
	validateWorkspaceMutationInput,
	validateWorkspaceReviewFileInput,
	validateWorkspaceReviewInput,
	validateWriteClipboardTextInput,
	validateWriteTerminalInput,
	validateWriteWorkspaceFileInput,
} from "./shared/desktop-api.ts";

function invoke<Method extends Exclude<ClientRequestMethod, "initialize">>(
	channel: string,
	method: Method,
	input: unknown,
): Promise<unknown> {
	return ipcRenderer.invoke(channel, validateDesktopClientParams(method, input));
}

const rpcForwarders = createDesktopRpcForwarders((definition, input) =>
	invoke(definition.channel, definition.method, input),
);

const api = {
	platform: process.platform,
	...rpcForwarders,
	openSkillFolder: async (input: ClientParams<"skill/get">) => {
		await invoke(DESKTOP_IPC_CHANNELS.openSkillFolder, "skill/get", input);
	},
	subscribeSchedule: () =>
		invoke(DESKTOP_IPC_CHANNELS.subscribeSchedule, "schedule/subscribe", {}) as ReturnType<
			MetisDesktopApi["subscribeSchedule"]
		>,
	unsubscribeSchedule: () =>
		invoke(DESKTOP_IPC_CHANNELS.unsubscribeSchedule, "schedule/unsubscribe", {}) as ReturnType<
			MetisDesktopApi["unsubscribeSchedule"]
		>,
	setScheduleKeepAwake: async (enabled: boolean) => {
		if (typeof enabled !== "boolean") throw new TypeError("Keep Awake state must be a boolean");
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setScheduleKeepAwake, enabled);
	},
	previewProjectDelete: (input: ClientParams<"project/deletePreview">) =>
		invoke(DESKTOP_IPC_CHANNELS.previewProjectDelete, "project/deletePreview", input) as ReturnType<
			MetisDesktopApi["previewProjectDelete"]
		>,
	deleteProject: (input: ClientParams<"project/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deleteProject, "project/delete", input) as ReturnType<
			MetisDesktopApi["deleteProject"]
		>,
	deleteSession: (input: ClientParams<"session/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deleteSession, "session/delete", input) as ReturnType<
			MetisDesktopApi["deleteSession"]
		>,
	openSession: (input: ClientParams<"session/open">) =>
		invoke(DESKTOP_IPC_CHANNELS.openSession, "session/open", input) as ReturnType<MetisDesktopApi["openSession"]>,
	readDeliveredFile: (input: ClientParams<"session/readDeliveredFile">) =>
		invoke(DESKTOP_IPC_CHANNELS.readDeliveredFile, "session/readDeliveredFile", input) as ReturnType<
			MetisDesktopApi["readDeliveredFile"]
		>,
	readPreviewFile: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readPreviewFile, validateReadPreviewFileInput(input)),
	interruptTurn: (input: ClientParams<"turn/interrupt">) =>
		invoke(DESKTOP_IPC_CHANNELS.interruptTurn, "turn/interrupt", input) as ReturnType<
			MetisDesktopApi["interruptTurn"]
		>,
	respondToInteraction: async (input: InteractionResponseInput) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.respondToInteraction, validateInteractionResponseInput(input));
	},
	selectProjectFolder: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.selectProjectFolder),
	selectAttachmentFiles: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.selectAttachmentFiles),
	resolveDroppedFiles: (files: readonly File[]) =>
		files.map((file) => ({ path: webUtils.getPathForFile(file), name: file.name })),
	getDefaultProjectLocation: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getDefaultProjectLocation),
	createProjectFolder: (input) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.createProjectFolder, input),
	createTerminal: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.createTerminal, validateCreateTerminalInput(input)),
	writeTerminal: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.writeTerminal, validateWriteTerminalInput(input));
	},
	resizeTerminal: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.resizeTerminal, validateResizeTerminalInput(input));
	},
	closeTerminal: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.closeTerminal, validateCloseTerminalInput(input));
	},
	subscribeTerminal: (listener: (event: DesktopTerminalEvent) => void) => {
		if (typeof listener !== "function") throw new TypeError("Metis terminal listener must be a function");
		const onEvent = (_event: IpcRendererEvent, value: unknown) => {
			listener(structuredClone(validateDesktopTerminalEvent(value)));
		};
		ipcRenderer.on(DESKTOP_TERMINAL_EVENT_CHANNEL, onEvent);
		return () => ipcRenderer.off(DESKTOP_TERMINAL_EVENT_CHANNEL, onEvent);
	},
	createBrowser: (input) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.createBrowser, validateCreateBrowserInput(input)),
	captureBrowserPreview: async (input) => {
		const preview = await ipcRenderer.invoke(
			DESKTOP_IPC_CHANNELS.captureBrowserPreview,
			validateCloseBrowserInput(input),
		);
		if (typeof preview !== "string" || !preview.startsWith("data:image/png;base64,")) {
			throw new TypeError("Invalid browser preview");
		}
		return preview;
	},
	controlBrowser: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.controlBrowser, validateBrowserControlInput(input));
	},
	closeBrowser: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.closeBrowser, validateCloseBrowserInput(input));
	},
	takeBrowserControl: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.takeBrowserControl, validateCloseBrowserInput(input));
	},
	resolveBrowserHandoff: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.resolveBrowserHandoff, validateResolveBrowserHandoffInput(input));
	},
	listBrowserDownloads: async () =>
		validateBrowserDownloadList(await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listBrowserDownloads)),
	controlBrowserDownload: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.controlBrowserDownload, validateBrowserDownloadControlInput(input));
	},
	listBrowserProfiles: async () =>
		validateBrowserProfileList(await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listBrowserProfiles)),
	listBrowserImportSources: async () =>
		validateBrowserImportSourceList(await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listBrowserImportSources)),
	importBrowserData: async (input) =>
		validateBrowserImportResult(
			await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.importBrowserData, validateBrowserImportInput(input)),
		),
	listBrowserHistory: async (input) =>
		validateBrowserHistoryList(
			await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listBrowserHistory, validateListBrowserHistoryInput(input)),
		),
	clearBrowserHistory: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.clearBrowserHistory, validateListBrowserHistoryInput(input));
	},
	listWorkspaceDirectory: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.listWorkspaceDirectory, validateListWorkspaceDirectoryInput(input)),
	searchWorkspaceFiles: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.searchWorkspaceFiles, validateSearchWorkspaceFilesInput(input)),
	readWorkspaceFile: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.readWorkspaceFile, validateReadWorkspaceFileInput(input)),
	writeWorkspaceFile: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.writeWorkspaceFile, validateWriteWorkspaceFileInput(input)),
	openWorkspaceFile: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openWorkspaceFile, validateOpenWorkspaceFileInput(input));
	},
	mutateWorkspaceEntry: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.mutateWorkspaceEntry, validateWorkspaceMutationInput(input)),
	getWorkspaceReview: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getWorkspaceReview, validateWorkspaceReviewInput(input)),
	getWorkspaceReviewFileDiff: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getWorkspaceReviewFileDiff, validateWorkspaceReviewFileInput(input)),
	getWorkspaceReviewFileContext: (input) =>
		ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getWorkspaceReviewFileContext, validateWorkspaceReviewFileInput(input)),
	writeClipboardText: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.writeClipboardText, validateWriteClipboardTextInput(input));
	},
	setWorkspaceEditState: async (input) => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setWorkspaceEditState, validateWorkspaceEditState(input));
	},
	getUpdateState: async () =>
		validateDesktopUpdateState(await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getUpdateState)),
	startUpdate: async () => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.startUpdate);
	},
	subscribeUpdate: (listener: (state: DesktopUpdateState) => void) => {
		if (typeof listener !== "function") throw new TypeError("Metis update listener must be a function");
		const onEvent = (_event: IpcRendererEvent, value: unknown) => {
			listener(structuredClone(validateDesktopUpdateState(value)));
		};
		ipcRenderer.on(DESKTOP_UPDATE_EVENT_CHANNEL, onEvent);
		return () => ipcRenderer.off(DESKTOP_UPDATE_EVENT_CHANNEL, onEvent);
	},
	subscribeBrowser: (listener: (event: DesktopBrowserEvent) => void) => {
		if (typeof listener !== "function") throw new TypeError("Metis browser listener must be a function");
		const onEvent = (_event: IpcRendererEvent, value: unknown) => {
			listener(structuredClone(validateDesktopBrowserEvent(value)));
		};
		ipcRenderer.on(DESKTOP_BROWSER_EVENT_CHANNEL, onEvent);
		return () => ipcRenderer.off(DESKTOP_BROWSER_EVENT_CHANNEL, onEvent);
	},
	subscribe: (listener: (event: DesktopApiEvent) => void) => {
		if (typeof listener !== "function") throw new TypeError("Metis event listener must be a function");
		const onEvent = (_event: IpcRendererEvent, value: unknown) => {
			listener(structuredClone(validateDesktopApiEvent(value)));
		};
		ipcRenderer.on(DESKTOP_EVENT_CHANNEL, onEvent);
		void ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.subscribe).catch(() => undefined);
		return () => ipcRenderer.off(DESKTOP_EVENT_CHANNEL, onEvent);
	},
	getServerState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getServerState),
	retryServer: async () => {
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.retryServer);
	},
	getThemePreference: async (): Promise<DesktopThemePreference> => {
		const value = await ipcRenderer.invoke(DESKTOP_THEME_CHANNEL, "get");
		if (value === "dark" || value === "light" || value === "system") return value;
		return "dark";
	},
	setThemePreference: async (theme: DesktopThemePreference): Promise<void> => {
		if (theme !== "dark" && theme !== "light" && theme !== "system") throw new TypeError("Invalid theme preference");
		await ipcRenderer.invoke(DESKTOP_THEME_CHANNEL, theme);
	},
} satisfies MetisDesktopApi;

const frozenApi = Object.freeze(api);
contextBridge.exposeInMainWorld("metis", frozenApi);
