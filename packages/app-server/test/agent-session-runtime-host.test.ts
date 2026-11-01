import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	compileSchema,
	type DomainEvent,
	DomainEventSchema,
	type ServerRequestMethod,
	type ServerResult,
	type ServerRpcRequest,
	SessionSnapshotSchema,
} from "@metis/app-protocol";
import { AgentSession, importSessionAttachments, SessionManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";
import { BROWSER_TOOL_NAMES } from "../src/browser-tools.ts";
import { InteractionBroker, type InteractionPeer } from "../src/interactions.ts";
import { opaqueId } from "../src/item-projection.ts";
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

	it.each(["startTurn", "steer", "queueTurn"] as const)(
		"cleans only newly imported attachments when %s fails",
		async (method) => {
			const root = mkdtempSync(join(tmpdir(), "metis-failed-attachments-"));
			temporaryRoots.push(root);
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			mkdirSync(agentDir);
			mkdirSync(cwd);
			const source = join(cwd, "report.txt");
			writeFileSync(source, "retain original");
			const manager = SessionManager.create(cwd, join(agentDir, "sessions"), {
				id: SESSION_ID,
				mode: "code",
				permissionPreset: "full",
			});
			const path = manager.getSessionFile()!;
			manager.close();
			const opened = await new AgentSessionRuntimeHost({ agentDir }).open({
				path,
				relativePath: basename(path),
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
					useMemory: true,
					contributeMemory: true,
				},
			});
			try {
				const runtime = (
					opened as unknown as { runtime: { submitPrompt(): Promise<never>; enqueueQueuedTurn(): never } }
				).runtime;
				vi.spyOn(runtime, "submitPrompt").mockRejectedValue(new Error("submission rejected"));
				vi.spyOn(runtime, "enqueueQueuedTurn").mockImplementation(() => {
					throw new Error("submission rejected");
				});
				const requestId = "00000000-0000-4000-8000-000000000301";
				const input = {
					sessionId: SESSION_ID,
					requestId,
					text: "read report",
					attachments: [{ path: source, name: "report.txt" }],
					delivery: "steer" as const,
				};
				await expect(opened[method](input)).rejects.toThrow();
				const attachmentDir = join(agentDir, "attachments", SESSION_ID);
				expect(readdirSync(attachmentDir).filter((name) => name.endsWith(".txt"))).toEqual([]);
				const [existing] = importSessionAttachments({
					agentDir,
					sessionId: SESSION_ID,
					cwd,
					attachments: input.attachments,
					key: requestId,
				});
				await expect(opened[method](input)).rejects.toThrow();
				expect(existsSync(existing.path)).toBe(true);
				expect(readFileSync(existing.path, "utf8")).toBe("retain original");
				expect(readFileSync(source, "utf8")).toBe("retain original");
			} finally {
				await opened.close();
			}
		},
	);

	it.each(["queued", "reading"] as const)("stops %s receipt refreshes before disposing the runtime", async (phase) => {
		const root = mkdtempSync(join(tmpdir(), "metis-receipt-close-"));
		temporaryRoots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const manager = SessionManager.create(cwd, join(agentDir, "sessions"), {
			id: SESSION_ID,
			mode: "code",
			permissionPreset: "full",
		});
		const path = manager.getSessionFile()!;
		manager.close();
		const ref: SessionRef = {
			path,
			relativePath: basename(path),
			summary: {
				sessionId: SESSION_ID,
				mode: "code",
				cwdOrigin: "user-selected",
				cwd,
				createdAt: "2026-11-01T00:00:00.000Z",
				updatedAt: "2026-11-01T00:00:00.000Z",
				state: "idle",
				archived: false,
				unread: false,
				useMemory: true,
				contributeMemory: true,
			},
		};
		const opened = await new AgentSessionRuntimeHost({ agentDir }).open(ref);
		const internal = opened as unknown as {
			runtime: { subagentManager: { readJournal(): Promise<unknown[]> } };
			refreshAgentReceipts(agentId: string): Promise<void>;
		};
		let readStarted!: () => void;
		let finishRead!: () => void;
		const started = new Promise<void>((resolve) => {
			readStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finishRead = resolve;
		});
		const read = vi.spyOn(internal.runtime.subagentManager, "readJournal").mockImplementation(async () => {
			readStarted();
			await gate;
			return [];
		});
		const events: DomainEvent[] = [];
		opened.subscribe((event) => events.push(event));
		const refreshed = internal.refreshAgentReceipts("child").then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			if (phase === "reading") await started;
			const closing = opened.close();
			finishRead();
			expect(await refreshed).toBeUndefined();
			await closing;
			expect(read).toHaveBeenCalledTimes(phase === "reading" ? 1 : 0);
			expect(events.filter((event) => event.type === "interaction/notify")).toEqual([]);
		} finally {
			finishRead();
			await refreshed;
			await opened.close();
		}
	});

	it("projects the same provider approval ID into live events and reconnect snapshots", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-review-identity-"));
		temporaryRoots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const manager = SessionManager.create(cwd, join(agentDir, "sessions"), {
			id: SESSION_ID,
			mode: "code",
			permissionPreset: "ask",
		});
		const path = manager.getSessionFile()!;
		manager.close();
		const opened = await new AgentSessionRuntimeHost({ agentDir }).open({
			path,
			relativePath: basename(path),
			summary: {
				sessionId: SESSION_ID,
				mode: "code",
				cwdOrigin: "user-selected",
				cwd,
				createdAt: "2026-10-22T00:00:00.000Z",
				updatedAt: "2026-10-22T00:00:00.000Z",
				state: "idle",
				archived: false,
				unread: false,
				useMemory: true,
				contributeMemory: true,
			},
		});
		try {
			const internal = opened as unknown as { session: AgentSession; onAgentEvent(event: unknown): void };
			const events: DomainEvent[] = [];
			opened.subscribe((event) => events.push(event));
			const original = internal.session.permissionView;
			const view = vi.spyOn(internal.session, "permissionView", "get");
			for (const actionId of ["call_01|fc_02", `call_${"x".repeat(150)}`]) {
				const activeReview = { actionId, reviewer: "user" as const, riskLevel: "medium" as const };
				view.mockReturnValue({ ...original, activeReview });
				internal.onAgentEvent({ type: "permission_review_started", ...activeReview });
				const snapshot = await opened.snapshot(EPOCH, () => 1);
				expect(compileSchema(SessionSnapshotSchema).Check(snapshot)).toBe(true);
				expect(snapshot.activeReview?.actionId).toBe(opaqueId(actionId, "tool"));
				internal.onAgentEvent({ type: "permission_review_completed", ...activeReview, outcome: "deny" });
				const reviewEvents = events
					.filter(
						(event) =>
							event.type === "session/permissionReviewStarted" ||
							event.type === "session/permissionReviewCompleted",
					)
					.slice(-2);
				expect(reviewEvents).toHaveLength(2);
				for (const event of reviewEvents) {
					expect(compileSchema(DomainEventSchema).Check(event)).toBe(true);
					expect(event).toMatchObject({ actionId: snapshot.activeReview?.actionId });
				}
				expect(internal.session.permissionView.activeReview?.actionId).toBe(actionId);
			}
		} finally {
			await opened.close();
		}
	}, 30_000);

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
			permissionPreset: "full",
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
				useMemory: true,
				contributeMemory: true,
			},
		};

		const broker = new InteractionBroker({ serverEpoch: EPOCH });
		let installedSession: AgentSession | undefined;
		let interactiveHostToolOptions: Parameters<AgentSession["installHostTools"]>[1];
		const appendAudit = vi.spyOn(AgentSession.prototype, "appendPermissionAuditEvent");
		const originalInstall = AgentSession.prototype.installHostTools;
		vi.spyOn(AgentSession.prototype, "installHostTools").mockImplementation(function (
			this: AgentSession,
			definitions,
			options,
		) {
			installedSession = this;
			if (definitions.some(({ name }) => name === "deliver_file")) interactiveHostToolOptions = options;
			return originalInstall.call(this, definitions, options);
		});

		let opened: OpenedSessionRuntime | undefined;
		try {
			opened = await new AgentSessionRuntimeHost({ agentDir, interactions: broker }).open(ref);
			const session = installedSession as AgentSession | undefined;
			const browserTabs = session?.getToolDefinition("browser_tabs");
			expect(browserTabs).toBeDefined();
			expect(session?.getActiveToolNames()).toEqual(expect.arrayContaining([...BROWSER_TOOL_NAMES]));
			expect(interactiveHostToolOptions?.automaticPermissionToolNames).toEqual(["ask_user", ...BROWSER_TOOL_NAMES]);
			expect(interactiveHostToolOptions?.automaticPermissionToolNames).not.toContain("deliver_file");

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
			expect(appendAudit.mock.calls.map(([event]) => [event.toolName, event.stage, event.outcome])).toContainEqual([
				"browser_tabs",
				"execution",
				"success",
			]);

			const message = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "persisted live reply" }],
				api: "openai-completions" as const,
				provider: "local",
				model: "runtime-host-test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			const persistedEntryId = session!.sessionManager.appendMessage(message);
			const internal = opened as unknown as {
				onAgentEvent(event: unknown): void;
				liveMessagesByItemId: Map<string, object>;
				durableEntryIdsByLiveItemId: Map<string, string>;
			};
			internal.onAgentEvent({ type: "message_start", message });
			internal.onAgentEvent({ type: "message_end", message });
			const [liveItemId] = internal.liveMessagesByItemId.keys();
			expect(liveItemId).toBeDefined();
			internal.onAgentEvent({ type: "agent_end", messages: [message] });
			expect(internal.liveMessagesByItemId).toHaveLength(0);
			expect(internal.durableEntryIdsByLiveItemId.get(liveItemId!)).toBe(persistedEntryId);
			await expect(
				opened.fork({
					entryId: liveItemId!,
					name: "Live fork",
					requestId: "22222222-2222-4222-8222-222222222222",
					targetSessionId: "33333333-3333-4333-8333-333333333333",
				}),
			).resolves.toBe("33333333-3333-4333-8333-333333333333");
		} finally {
			await opened?.close();
		}
	}, 30_000);
});
