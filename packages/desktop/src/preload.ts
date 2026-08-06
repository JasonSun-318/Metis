import type { ClientParams, ClientRequestMethod, InteractionResponseInput } from "@arcmind/app-protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron";
import {
	type ArcMindDesktopApi,
	DESKTOP_BROWSER_EVENT_CHANNEL,
	DESKTOP_EVENT_CHANNEL,
	DESKTOP_IPC_CHANNELS,
	DESKTOP_TERMINAL_EVENT_CHANNEL,
	type DesktopApiEvent,
	type DesktopBrowserEvent,
	type DesktopTerminalEvent,
	validateBrowserControlInput,
	validateCloseBrowserInput,
	validateCloseTerminalInput,
	validateCreateBrowserInput,
	validateCreateTerminalInput,
	validateDesktopApiEvent,
	validateDesktopBrowserEvent,
	validateDesktopClientParams,
	validateDesktopTerminalEvent,
	validateInteractionResponseInput,
	validateListWorkspaceDirectoryInput,
	validateOpenWorkspaceFileInput,
	validateReadWorkspaceFileInput,
	validateResizeTerminalInput,
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

const api = {
	listSessions: (input: ClientParams<"session/list"> = {}) =>
		invoke(DESKTOP_IPC_CHANNELS.listSessions, "session/list", input) as ReturnType<ArcMindDesktopApi["listSessions"]>,
	listSkills: (input: ClientParams<"skill/list">) =>
		invoke(DESKTOP_IPC_CHANNELS.listSkills, "skill/list", input) as ReturnType<ArcMindDesktopApi["listSkills"]>,
	getProfile: () =>
		invoke(DESKTOP_IPC_CHANNELS.getProfile, "profile/get", {}) as ReturnType<ArcMindDesktopApi["getProfile"]>,
	listModels: () =>
		invoke(DESKTOP_IPC_CHANNELS.listModels, "model/list", {}) as ReturnType<ArcMindDesktopApi["listModels"]>,
	createSchedule: (input: ClientParams<"schedule/create">) =>
		invoke(DESKTOP_IPC_CHANNELS.createSchedule, "schedule/create", input) as ReturnType<
			ArcMindDesktopApi["createSchedule"]
		>,
	listSchedules: (input: ClientParams<"schedule/list"> = {}) =>
		invoke(DESKTOP_IPC_CHANNELS.listSchedules, "schedule/list", input) as ReturnType<
			ArcMindDesktopApi["listSchedules"]
		>,
	getSchedule: (input: ClientParams<"schedule/get">) =>
		invoke(DESKTOP_IPC_CHANNELS.getSchedule, "schedule/get", input) as ReturnType<ArcMindDesktopApi["getSchedule"]>,
	updateSchedule: (input: ClientParams<"schedule/update">) =>
		invoke(DESKTOP_IPC_CHANNELS.updateSchedule, "schedule/update", input) as ReturnType<
			ArcMindDesktopApi["updateSchedule"]
		>,
	pauseSchedule: (input: ClientParams<"schedule/pause">) =>
		invoke(DESKTOP_IPC_CHANNELS.pauseSchedule, "schedule/pause", input) as ReturnType<
			ArcMindDesktopApi["pauseSchedule"]
		>,
	resumeSchedule: (input: ClientParams<"schedule/resume">) =>
		invoke(DESKTOP_IPC_CHANNELS.resumeSchedule, "schedule/resume", input) as ReturnType<
			ArcMindDesktopApi["resumeSchedule"]
		>,
	deleteSchedule: (input: ClientParams<"schedule/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deleteSchedule, "schedule/delete", input) as ReturnType<
			ArcMindDesktopApi["deleteSchedule"]
		>,
	runScheduleNow: (input: ClientParams<"schedule/run-now">) =>
		invoke(DESKTOP_IPC_CHANNELS.runScheduleNow, "schedule/run-now", input) as ReturnType<
			ArcMindDesktopApi["runScheduleNow"]
		>,
	listScheduleRuns: (input: ClientParams<"schedule/run/list">) =>
		invoke(DESKTOP_IPC_CHANNELS.listScheduleRuns, "schedule/run/list", input) as ReturnType<
			ArcMindDesktopApi["listScheduleRuns"]
		>,
	getScheduleRun: (input: ClientParams<"schedule/run/get">) =>
		invoke(DESKTOP_IPC_CHANNELS.getScheduleRun, "schedule/run/get", input) as ReturnType<
			ArcMindDesktopApi["getScheduleRun"]
		>,
	markScheduleRunRead: (input: ClientParams<"schedule/run/mark-read">) =>
		invoke(DESKTOP_IPC_CHANNELS.markScheduleRunRead, "schedule/run/mark-read", input) as ReturnType<
			ArcMindDesktopApi["markScheduleRunRead"]
		>,
	subscribeSchedule: () =>
		invoke(DESKTOP_IPC_CHANNELS.subscribeSchedule, "schedule/subscribe", {}) as ReturnType<
			ArcMindDesktopApi["subscribeSchedule"]
		>,
	unsubscribeSchedule: () =>
		invoke(DESKTOP_IPC_CHANNELS.unsubscribeSchedule, "schedule/unsubscribe", {}) as ReturnType<
			ArcMindDesktopApi["unsubscribeSchedule"]
		>,
	setScheduleKeepAwake: async (enabled: boolean) => {
		if (typeof enabled !== "boolean") throw new TypeError("Keep Awake state must be a boolean");
		await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setScheduleKeepAwake, enabled);
	},
	previewProjectDelete: (input: ClientParams<"project/deletePreview">) =>
		invoke(DESKTOP_IPC_CHANNELS.previewProjectDelete, "project/deletePreview", input) as ReturnType<
			ArcMindDesktopApi["previewProjectDelete"]
		>,
	deleteProject: (input: ClientParams<"project/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deleteProject, "project/delete", input) as ReturnType<
			ArcMindDesktopApi["deleteProject"]
		>,
	createSession: (input: ClientParams<"session/create">) =>
		invoke(DESKTOP_IPC_CHANNELS.createSession, "session/create", input) as ReturnType<
			ArcMindDesktopApi["createSession"]
		>,
	renameSession: (input: ClientParams<"session/rename">) =>
		invoke(DESKTOP_IPC_CHANNELS.renameSession, "session/rename", input) as ReturnType<
			ArcMindDesktopApi["renameSession"]
		>,
	deleteSession: (input: ClientParams<"session/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deleteSession, "session/delete", input) as ReturnType<
			ArcMindDesktopApi["deleteSession"]
		>,
	openSession: (input: ClientParams<"session/open">) =>
		invoke(DESKTOP_IPC_CHANNELS.openSession, "session/open", input) as ReturnType<ArcMindDesktopApi["openSession"]>,
	markSessionRead: (input: ClientParams<"session/markRead">) =>
		invoke(DESKTOP_IPC_CHANNELS.markSessionRead, "session/markRead", input) as ReturnType<
			ArcMindDesktopApi["markSessionRead"]
		>,
	readItems: (input: ClientParams<"session/readItems">) =>
		invoke(DESKTOP_IPC_CHANNELS.readItems, "session/readItems", input) as ReturnType<ArcMindDesktopApi["readItems"]>,
	readSubagentItems: (input: ClientParams<"subagent/readItems">) =>
		invoke(DESKTOP_IPC_CHANNELS.readSubagentItems, "subagent/readItems", input) as ReturnType<
			ArcMindDesktopApi["readSubagentItems"]
		>,
	interruptSubagent: (input: ClientParams<"subagent/interrupt">) =>
		invoke(DESKTOP_IPC_CHANNELS.interruptSubagent, "subagent/interrupt", input) as ReturnType<
			ArcMindDesktopApi["interruptSubagent"]
		>,
	setThinkingSelection: (input: ClientParams<"session/setThinkingSelection">) =>
		invoke(DESKTOP_IPC_CHANNELS.setThinkingSelection, "session/setThinkingSelection", input) as ReturnType<
			ArcMindDesktopApi["setThinkingSelection"]
		>,
	setPermissionMode: (input: ClientParams<"session/setPermissionMode">) =>
		invoke(DESKTOP_IPC_CHANNELS.setPermissionMode, "session/setPermissionMode", input) as ReturnType<
			ArcMindDesktopApi["setPermissionMode"]
		>,
	setModel: (input: ClientParams<"session/setModel">) =>
		invoke(DESKTOP_IPC_CHANNELS.setModel, "session/setModel", input) as ReturnType<ArcMindDesktopApi["setModel"]>,
	startTurn: (input: ClientParams<"turn/start">) =>
		invoke(DESKTOP_IPC_CHANNELS.startTurn, "turn/start", input) as ReturnType<ArcMindDesktopApi["startTurn"]>,
	steerTurn: (input: ClientParams<"turn/steer">) =>
		invoke(DESKTOP_IPC_CHANNELS.steerTurn, "turn/steer", input) as ReturnType<ArcMindDesktopApi["steerTurn"]>,
	interruptTurn: (input: ClientParams<"turn/interrupt">) =>
		invoke(DESKTOP_IPC_CHANNELS.interruptTurn, "turn/interrupt", input) as ReturnType<
			ArcMindDesktopApi["interruptTurn"]
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
		if (typeof listener !== "function") throw new TypeError("ArcMind terminal listener must be a function");
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
	subscribeBrowser: (listener: (event: DesktopBrowserEvent) => void) => {
		if (typeof listener !== "function") throw new TypeError("ArcMind browser listener must be a function");
		const onEvent = (_event: IpcRendererEvent, value: unknown) => {
			listener(structuredClone(validateDesktopBrowserEvent(value)));
		};
		ipcRenderer.on(DESKTOP_BROWSER_EVENT_CHANNEL, onEvent);
		return () => ipcRenderer.off(DESKTOP_BROWSER_EVENT_CHANNEL, onEvent);
	},
	subscribe: (listener: (event: DesktopApiEvent) => void) => {
		if (typeof listener !== "function") throw new TypeError("ArcMind event listener must be a function");
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
} satisfies ArcMindDesktopApi;

contextBridge.exposeInMainWorld("arcMind", Object.freeze(api));
