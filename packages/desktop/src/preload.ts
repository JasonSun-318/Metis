import type { ClientParams, ClientRequestMethod, InteractionResponseInput } from "@metis/app-protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron";
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
		invoke(DESKTOP_IPC_CHANNELS.listSessions, "session/list", input) as ReturnType<MetisDesktopApi["listSessions"]>,
	listSkills: (input: ClientParams<"skill/list">) =>
		invoke(DESKTOP_IPC_CHANNELS.listSkills, "skill/list", input) as ReturnType<MetisDesktopApi["listSkills"]>,
	getSkill: (input: ClientParams<"skill/get">) =>
		invoke(DESKTOP_IPC_CHANNELS.getSkill, "skill/get", input) as ReturnType<MetisDesktopApi["getSkill"]>,
	upsertSkill: (input: ClientParams<"skill/upsert">) =>
		invoke(DESKTOP_IPC_CHANNELS.upsertSkill, "skill/upsert", input) as ReturnType<MetisDesktopApi["upsertSkill"]>,
	removeSkill: (input: ClientParams<"skill/remove">) =>
		invoke(DESKTOP_IPC_CHANNELS.removeSkill, "skill/remove", input) as ReturnType<MetisDesktopApi["removeSkill"]>,
	inspectSkillImport: (input: ClientParams<"skill/import/inspect">) =>
		invoke(DESKTOP_IPC_CHANNELS.inspectSkillImport, "skill/import/inspect", input) as ReturnType<
			MetisDesktopApi["inspectSkillImport"]
		>,
	importSkills: (input: ClientParams<"skill/import">) =>
		invoke(DESKTOP_IPC_CHANNELS.importSkills, "skill/import", input) as ReturnType<MetisDesktopApi["importSkills"]>,
	openSkillFolder: async (input: ClientParams<"skill/get">) => {
		await invoke(DESKTOP_IPC_CHANNELS.openSkillFolder, "skill/get", input);
	},
	listMcpServers: (input: ClientParams<"mcp/list">) =>
		invoke(DESKTOP_IPC_CHANNELS.listMcpServers, "mcp/list", input) as ReturnType<MetisDesktopApi["listMcpServers"]>,
	inspectMcpImport: (input: ClientParams<"mcp/import/inspect">) =>
		invoke(DESKTOP_IPC_CHANNELS.inspectMcpImport, "mcp/import/inspect", input) as ReturnType<
			MetisDesktopApi["inspectMcpImport"]
		>,
	importMcpServers: (input: ClientParams<"mcp/import">) =>
		invoke(DESKTOP_IPC_CHANNELS.importMcpServers, "mcp/import", input) as ReturnType<
			MetisDesktopApi["importMcpServers"]
		>,
	getMcpServer: (input: ClientParams<"mcp/get">) =>
		invoke(DESKTOP_IPC_CHANNELS.getMcpServer, "mcp/get", input) as ReturnType<MetisDesktopApi["getMcpServer"]>,
	getMcpCatalogItem: (input: ClientParams<"mcp/catalog/get">) =>
		invoke(DESKTOP_IPC_CHANNELS.getMcpCatalogItem, "mcp/catalog/get", input) as ReturnType<
			MetisDesktopApi["getMcpCatalogItem"]
		>,
	upsertMcpServer: (input: ClientParams<"mcp/upsert">) =>
		invoke(DESKTOP_IPC_CHANNELS.upsertMcpServer, "mcp/upsert", input) as ReturnType<
			MetisDesktopApi["upsertMcpServer"]
		>,
	removeMcpServer: (input: ClientParams<"mcp/remove">) =>
		invoke(DESKTOP_IPC_CHANNELS.removeMcpServer, "mcp/remove", input) as ReturnType<
			MetisDesktopApi["removeMcpServer"]
		>,
	restartMcpServer: (input: ClientParams<"mcp/restart">) =>
		invoke(DESKTOP_IPC_CHANNELS.restartMcpServer, "mcp/restart", input) as ReturnType<
			MetisDesktopApi["restartMcpServer"]
		>,
	setMcpCredential: (input: ClientParams<"mcp/credential/set">) =>
		invoke(DESKTOP_IPC_CHANNELS.setMcpCredential, "mcp/credential/set", input) as ReturnType<
			MetisDesktopApi["setMcpCredential"]
		>,
	clearMcpCredential: (input: ClientParams<"mcp/credential/clear">) =>
		invoke(DESKTOP_IPC_CHANNELS.clearMcpCredential, "mcp/credential/clear", input) as ReturnType<
			MetisDesktopApi["clearMcpCredential"]
		>,
	getProfile: () =>
		invoke(DESKTOP_IPC_CHANNELS.getProfile, "profile/get", {}) as ReturnType<MetisDesktopApi["getProfile"]>,
	listModels: () =>
		invoke(DESKTOP_IPC_CHANNELS.listModels, "model/list", {}) as ReturnType<MetisDesktopApi["listModels"]>,
	getModelSettings: () =>
		invoke(DESKTOP_IPC_CHANNELS.getModelSettings, "model/settings/get", {}) as ReturnType<
			MetisDesktopApi["getModelSettings"]
		>,
	updateModelSettings: (input: ClientParams<"model/settings/update">) =>
		invoke(DESKTOP_IPC_CHANNELS.updateModelSettings, "model/settings/update", input) as ReturnType<
			MetisDesktopApi["updateModelSettings"]
		>,
	testModelConnection: (input: ClientParams<"model/testConnection">) =>
		invoke(DESKTOP_IPC_CHANNELS.testModelConnection, "model/testConnection", input) as ReturnType<
			MetisDesktopApi["testModelConnection"]
		>,
	getUsage: (input: ClientParams<"usage/get">) =>
		invoke(DESKTOP_IPC_CHANNELS.getUsage, "usage/get", input) as ReturnType<MetisDesktopApi["getUsage"]>,
	createSchedule: (input: ClientParams<"schedule/create">) =>
		invoke(DESKTOP_IPC_CHANNELS.createSchedule, "schedule/create", input) as ReturnType<
			MetisDesktopApi["createSchedule"]
		>,
	listSchedules: (input: ClientParams<"schedule/list"> = {}) =>
		invoke(DESKTOP_IPC_CHANNELS.listSchedules, "schedule/list", input) as ReturnType<
			MetisDesktopApi["listSchedules"]
		>,
	getSchedule: (input: ClientParams<"schedule/get">) =>
		invoke(DESKTOP_IPC_CHANNELS.getSchedule, "schedule/get", input) as ReturnType<MetisDesktopApi["getSchedule"]>,
	updateSchedule: (input: ClientParams<"schedule/update">) =>
		invoke(DESKTOP_IPC_CHANNELS.updateSchedule, "schedule/update", input) as ReturnType<
			MetisDesktopApi["updateSchedule"]
		>,
	pauseSchedule: (input: ClientParams<"schedule/pause">) =>
		invoke(DESKTOP_IPC_CHANNELS.pauseSchedule, "schedule/pause", input) as ReturnType<
			MetisDesktopApi["pauseSchedule"]
		>,
	resumeSchedule: (input: ClientParams<"schedule/resume">) =>
		invoke(DESKTOP_IPC_CHANNELS.resumeSchedule, "schedule/resume", input) as ReturnType<
			MetisDesktopApi["resumeSchedule"]
		>,
	deleteSchedule: (input: ClientParams<"schedule/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deleteSchedule, "schedule/delete", input) as ReturnType<
			MetisDesktopApi["deleteSchedule"]
		>,
	runScheduleNow: (input: ClientParams<"schedule/run-now">) =>
		invoke(DESKTOP_IPC_CHANNELS.runScheduleNow, "schedule/run-now", input) as ReturnType<
			MetisDesktopApi["runScheduleNow"]
		>,
	listScheduleRuns: (input: ClientParams<"schedule/run/list">) =>
		invoke(DESKTOP_IPC_CHANNELS.listScheduleRuns, "schedule/run/list", input) as ReturnType<
			MetisDesktopApi["listScheduleRuns"]
		>,
	getScheduleRun: (input: ClientParams<"schedule/run/get">) =>
		invoke(DESKTOP_IPC_CHANNELS.getScheduleRun, "schedule/run/get", input) as ReturnType<
			MetisDesktopApi["getScheduleRun"]
		>,
	markScheduleRunRead: (input: ClientParams<"schedule/run/mark-read">) =>
		invoke(DESKTOP_IPC_CHANNELS.markScheduleRunRead, "schedule/run/mark-read", input) as ReturnType<
			MetisDesktopApi["markScheduleRunRead"]
		>,
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
	createSession: (input: ClientParams<"session/create">) =>
		invoke(DESKTOP_IPC_CHANNELS.createSession, "session/create", input) as ReturnType<
			MetisDesktopApi["createSession"]
		>,
	renameSession: (input: ClientParams<"session/rename">) =>
		invoke(DESKTOP_IPC_CHANNELS.renameSession, "session/rename", input) as ReturnType<
			MetisDesktopApi["renameSession"]
		>,
	deleteSession: (input: ClientParams<"session/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deleteSession, "session/delete", input) as ReturnType<
			MetisDesktopApi["deleteSession"]
		>,
	openSession: (input: ClientParams<"session/open">) =>
		invoke(DESKTOP_IPC_CHANNELS.openSession, "session/open", input) as ReturnType<MetisDesktopApi["openSession"]>,
	markSessionRead: (input: ClientParams<"session/markRead">) =>
		invoke(DESKTOP_IPC_CHANNELS.markSessionRead, "session/markRead", input) as ReturnType<
			MetisDesktopApi["markSessionRead"]
		>,
	readItems: (input: ClientParams<"session/readItems">) =>
		invoke(DESKTOP_IPC_CHANNELS.readItems, "session/readItems", input) as ReturnType<MetisDesktopApi["readItems"]>,
	getSessionStatus: (input: ClientParams<"session/status">) =>
		invoke(DESKTOP_IPC_CHANNELS.getSessionStatus, "session/status", input) as ReturnType<
			MetisDesktopApi["getSessionStatus"]
		>,
	compactSession: (input: ClientParams<"session/compact">) =>
		invoke(DESKTOP_IPC_CHANNELS.compactSession, "session/compact", input) as ReturnType<
			MetisDesktopApi["compactSession"]
		>,
	readSubagentItems: (input: ClientParams<"subagent/readItems">) =>
		invoke(DESKTOP_IPC_CHANNELS.readSubagentItems, "subagent/readItems", input) as ReturnType<
			MetisDesktopApi["readSubagentItems"]
		>,
	interruptSubagent: (input: ClientParams<"subagent/interrupt">) =>
		invoke(DESKTOP_IPC_CHANNELS.interruptSubagent, "subagent/interrupt", input) as ReturnType<
			MetisDesktopApi["interruptSubagent"]
		>,
	setThinkingSelection: (input: ClientParams<"session/setThinkingSelection">) =>
		invoke(DESKTOP_IPC_CHANNELS.setThinkingSelection, "session/setThinkingSelection", input) as ReturnType<
			MetisDesktopApi["setThinkingSelection"]
		>,
	setPermissionMode: (input: ClientParams<"session/setPermissionMode">) =>
		invoke(DESKTOP_IPC_CHANNELS.setPermissionMode, "session/setPermissionMode", input) as ReturnType<
			MetisDesktopApi["setPermissionMode"]
		>,
	listPermissionRules: (input: ClientParams<"permission/rules/list">) =>
		invoke(DESKTOP_IPC_CHANNELS.listPermissionRules, "permission/rules/list", input) as ReturnType<
			MetisDesktopApi["listPermissionRules"]
		>,
	deletePermissionRule: (input: ClientParams<"permission/rules/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deletePermissionRule, "permission/rules/delete", input) as ReturnType<
			MetisDesktopApi["deletePermissionRule"]
		>,
	clearPermissionRules: (input: ClientParams<"permission/rules/clear">) =>
		invoke(DESKTOP_IPC_CHANNELS.clearPermissionRules, "permission/rules/clear", input) as ReturnType<
			MetisDesktopApi["clearPermissionRules"]
		>,
	setModel: (input: ClientParams<"session/setModel">) =>
		invoke(DESKTOP_IPC_CHANNELS.setModel, "session/setModel", input) as ReturnType<MetisDesktopApi["setModel"]>,
	startTurn: (input: ClientParams<"turn/start">) =>
		invoke(DESKTOP_IPC_CHANNELS.startTurn, "turn/start", input) as ReturnType<MetisDesktopApi["startTurn"]>,
	steerTurn: (input: ClientParams<"turn/steer">) =>
		invoke(DESKTOP_IPC_CHANNELS.steerTurn, "turn/steer", input) as ReturnType<MetisDesktopApi["steerTurn"]>,
	queueTurn: (input: ClientParams<"turn/queue">) =>
		invoke(DESKTOP_IPC_CHANNELS.queueTurn, "turn/queue", input) as ReturnType<MetisDesktopApi["queueTurn"]>,
	updateQueuedTurn: (input: ClientParams<"turn/queue/update">) =>
		invoke(DESKTOP_IPC_CHANNELS.updateQueuedTurn, "turn/queue/update", input) as ReturnType<
			MetisDesktopApi["updateQueuedTurn"]
		>,
	deleteQueuedTurn: (input: ClientParams<"turn/queue/delete">) =>
		invoke(DESKTOP_IPC_CHANNELS.deleteQueuedTurn, "turn/queue/delete", input) as ReturnType<
			MetisDesktopApi["deleteQueuedTurn"]
		>,
	sendQueuedTurn: (input: ClientParams<"turn/queue/send">) =>
		invoke(DESKTOP_IPC_CHANNELS.sendQueuedTurn, "turn/queue/send", input) as ReturnType<
			MetisDesktopApi["sendQueuedTurn"]
		>,
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
