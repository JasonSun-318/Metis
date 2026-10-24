import { randomUUID } from "node:crypto";
import { app } from "electron";
import { validateToolArguments } from "@metis/ai"; // boundary-allow: validate real browser tool arguments in the source integration fixture
import { type BrowserToolResult, type ServerRpcRequest, validateResponseFor } from "@metis/app-protocol";
import { browserToolCall, createBrowserToolDefinitions } from "../../app-server/src/browser-tools.ts"; // boundary-allow: connect real server browser tools to the desktop host in this integration fixture
import { BrowserManager } from "../src/main/browser-manager.ts";
import { BrowserToolHost } from "../src/main/browser-tool-host.ts";

export interface SourceBrowserApi {
	call(name: string, args: Record<string, unknown>, actorId?: string): Promise<{ ok: boolean; text: string; imageCount?: number; imageBytes?: number }>;
	takeControl(browserId: string): void;
	resolveHandoff(browserId: string, decision: "complete" | "cancel"): void;
	readonly diagnostics: string[];
	close(): void;
}

declare global {
	var metisBrowserSourceReady: Promise<SourceBrowserApi>;
}

const profile = process.env.METIS_BROWSER_SOURCE_PROFILE;
if (!profile) throw new Error("Source browser fixture requires an isolated profile");
app.setName("Metis Browser Source Test");
app.setPath("userData", profile);

globalThis.metisBrowserSourceReady = app.whenReady().then(() => {
	const manager = new BrowserManager();
	const sessionId = randomUUID();
	const serverEpoch = randomUUID();
	const diagnostics: string[] = [];
	const pending = new Map<string, { resolve(result: BrowserToolResult): void; reject(cause: Error): void }>();
	const host = new BrowserToolHost({
		browserManager: manager,
		isAvailable: () => true,
		onDiagnostic: (message) => diagnostics.push(message),
		supervisor: {
			view: () => ({ state: "ready", serverEpoch, restartAttempt: 0, failure: null }),
			respondToServerRequest(request, response) {
				validateResponseFor("server", request, response);
				const entry = pending.get(request.id);
				if (!entry) throw new Error("Unexpected source browser response");
				pending.delete(request.id);
				if ("error" in response) {
					entry.reject(Object.assign(new Error(response.error.message), {
						code: "data" in response.error ? response.error.data.name : "OPERATION_FAILED",
						context: "data" in response.error ? response.error.data : {},
					}));
				} else {
					entry.resolve((response.result as { result: BrowserToolResult }).result);
				}
			},
		},
	});
	const toolsFor = (actorId?: string) => createBrowserToolDefinitions((request) => new Promise((resolve, reject) => {
		const rpc: ServerRpcRequest<"browser/tool"> = {
			jsonrpc: "2.0", id: randomUUID(), method: "browser/tool",
			params: { serverEpoch, sessionId, ...(actorId ? { rootSessionId: sessionId, actorSessionId: actorId, agentId: actorId, taskId: `task-${actorId}` } : {}), toolCallId: request.toolCallId, call: browserToolCall(request) },
		};
		pending.set(rpc.id, { resolve, reject });
		host.handleRequest(rpc);
	}));
	return {
		diagnostics,
		close: () => manager.closeAll(),
		takeControl: (browserId) => manager.takeControl(sessionId, browserId),
		resolveHandoff: (browserId, decision) => manager.resolveHandoff(sessionId, browserId, decision),
		async call(name, args, actorId) {
			try {
				const tool = toolsFor(actorId).find((candidate) => candidate.name === name);
				if (!tool) throw new Error(`Unknown browser fixture tool: ${name}`);
				const callId = randomUUID();
				const input = validateToolArguments(tool, { type: "toolCall", id: callId, name, arguments: args });
				const result = await tool.execute(callId, input, undefined, undefined, {} as never);
				const images = result.content.filter((content) => content.type === "image");
				return {
					ok: true,
					text: result.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("\n"),
					imageCount: images.length,
					imageBytes: images.reduce((bytes, image) => bytes + Buffer.from(image.data, "base64").length, 0),
				};
			} catch (cause) {
				return { ok: false, text: cause instanceof Error ? cause.message : String(cause) };
			}
		},
	};
});
