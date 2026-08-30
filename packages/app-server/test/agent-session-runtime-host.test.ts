import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ServerRequestMethod, ServerResult, ServerRpcRequest } from "@metis/app-protocol";
import { AgentSession, BROWSER_TOOL_NAMES, SessionManager } from "@metis/coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";
import { InteractionBroker, type InteractionPeer } from "../src/interactions.ts";
import type { OpenedSessionRuntime, SessionRef } from "../src/session-runtime-host.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "00000000-0000-4000-8000-000000000201";

class BrowserPeer implements InteractionPeer {
	readonly requests: ServerRpcRequest<"browser/tool">[] = [];

	async request(request: ServerRpcRequest): Promise<ServerResult<ServerRequestMethod>> {
		if (request.method !== "browser/tool") throw new Error("Expected a browser tool request");
		const browserRequest = request as ServerRpcRequest<"browser/tool">;
		this.requests.push(browserRequest);
		return {
			toolCallId: browserRequest.params.toolCallId,
			result: { tool: "browser_tabs", details: { profiles: [], tabs: [] } },
		};
	}
}

describe("AgentSessionRuntimeHost browser tools", () => {
	const temporaryRoots: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("keeps one browser tool registry across owner attach, release, and reconnect", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-browser-runtime-host-"));
		temporaryRoots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sessionsRoot = join(agentDir, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: "http://127.0.0.1:9/v1",
						apiKey: "test-key",
						api: "openai-completions",
						models: [
							{
								id: "runtime-host-test",
								name: "Runtime Host Test",
								contextWindow: 32_000,
								maxTokens: 1_024,
								reasoning: false,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "local", defaultModel: "runtime-host-test", retry: { enabled: false } }),
		);

		const manager = SessionManager.create(cwd, sessionsRoot, {
			id: SESSION_ID,
			mode: "code",
			permissionMode: "full",
		});
		const sessionFile = manager.getSessionFile()!;
		manager.close();
		const ref: SessionRef = {
			path: sessionFile,
			relativePath: basename(sessionFile),
			summary: {
				sessionId: SESSION_ID,
				mode: "code",
				cwdOrigin: "user-selected",
				cwd,
				createdAt: "2026-08-30T00:00:00.000Z",
				updatedAt: "2026-08-30T00:00:00.000Z",
				state: "idle",
				archived: false,
				unread: false,
			},
		};

		const broker = new InteractionBroker({ serverEpoch: EPOCH });
		let installedSession: AgentSession | undefined;
		const originalInstall = AgentSession.prototype.installHostTools;
		vi.spyOn(AgentSession.prototype, "installHostTools").mockImplementation(function (
			this: AgentSession,
			definitions,
			options,
		) {
			installedSession = this;
			return originalInstall.call(this, definitions, options);
		});

		let opened: OpenedSessionRuntime | undefined;
		try {
			opened = await new AgentSessionRuntimeHost({ agentDir, interactions: broker }).open(ref);
			const session = installedSession as AgentSession | undefined;
			const browserTabs = session?.getToolDefinition("browser_tabs");
			expect(browserTabs).toBeDefined();
			expect(session?.getActiveToolNames()).toEqual(expect.arrayContaining([...BROWSER_TOOL_NAMES]));

			await expect(
				browserTabs!.execute("call-detached", { action: "list" }, undefined, undefined, {} as never),
			).rejects.toThrow("No interactive desktop owner");

			const firstPeer = new BrowserPeer();
			broker.assign(SESSION_ID, firstPeer);
			await expect(
				browserTabs!.execute("call-first-owner", { action: "list" }, undefined, undefined, {} as never),
			).resolves.toMatchObject({ content: [{ type: "text" }] });

			broker.release(SESSION_ID, firstPeer);
			await expect(
				browserTabs!.execute("call-released", { action: "list" }, undefined, undefined, {} as never),
			).rejects.toThrow("No interactive desktop owner");

			const replacementPeer = new BrowserPeer();
			broker.assign(SESSION_ID, replacementPeer);
			await expect(
				browserTabs!.execute("call-reconnected", { action: "list" }, undefined, undefined, {} as never),
			).resolves.toMatchObject({ content: [{ type: "text" }] });

			expect(session?.getToolDefinition("browser_tabs")).toBe(browserTabs);
			expect(firstPeer.requests).toHaveLength(1);
			expect(replacementPeer.requests).toHaveLength(1);
		} finally {
			await opened?.close();
		}
	}, 30_000);
});
