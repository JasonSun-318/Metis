import type { ClientParams, ClientRequestMethod, InteractionResponseInput } from "@arcmind/app-protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import {
	type ArcMindDesktopApi,
	DESKTOP_EVENT_CHANNEL,
	DESKTOP_IPC_CHANNELS,
	type DesktopApiEvent,
	validateDesktopApiEvent,
	validateDesktopClientParams,
	validateInteractionResponseInput,
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
	createSession: (input: ClientParams<"session/create">) =>
		invoke(DESKTOP_IPC_CHANNELS.createSession, "session/create", input) as ReturnType<
			ArcMindDesktopApi["createSession"]
		>,
	openSession: (input: ClientParams<"session/open">) =>
		invoke(DESKTOP_IPC_CHANNELS.openSession, "session/open", input) as ReturnType<ArcMindDesktopApi["openSession"]>,
	readItems: (input: ClientParams<"session/readItems">) =>
		invoke(DESKTOP_IPC_CHANNELS.readItems, "session/readItems", input) as ReturnType<ArcMindDesktopApi["readItems"]>,
	readSubagentItems: (input: ClientParams<"subagent/readItems">) =>
		invoke(DESKTOP_IPC_CHANNELS.readSubagentItems, "subagent/readItems", input) as ReturnType<
			ArcMindDesktopApi["readSubagentItems"]
		>,
	setThinkingSelection: (input: ClientParams<"session/setThinkingSelection">) =>
		invoke(DESKTOP_IPC_CHANNELS.setThinkingSelection, "session/setThinkingSelection", input) as ReturnType<
			ArcMindDesktopApi["setThinkingSelection"]
		>,
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
