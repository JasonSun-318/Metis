import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@metis/ai"; // boundary-allow: Offline provider at the external model boundary.
import { type DomainEvent, PROTOCOL_VERSION, type SessionSnapshot } from "@metis/app-protocol";
import { type AgentSessionRuntime, SessionManager } from "@metis/coding-agent/host";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";
import { AppServer } from "../src/app-server.ts";

afterEach(() => vi.restoreAllMocks());

it.each(["extension", "mcp"])(
	"retains the production runtime when %s owns session state",
	async (owner) => {
		const root = mkdtempSync(join(tmpdir(), "metis-pinned-runtime-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		if (owner === "extension") {
			mkdirSync(join(agentDir, "extensions"));
			writeFileSync(
				join(agentDir, "extensions", "state.ts"),
				'export default function(api) { let starts = 0; api.on("session_start", () => { starts++; }); }',
			);
		} else {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ mcpServers: { offline: { command: "node", args: ["--version"], enabled: false } } }),
			);
		}
		const manager = SessionManager.create(cwd, join(agentDir, "sessions"), {
			mode: "code",
			permissionPreset: "full",
		});
		const header = manager.getHeader()!;
		const path = manager.getSessionFile()!;
		manager.close();
		const opened = await new AgentSessionRuntimeHost({ agentDir }).open({
			path,
			relativePath: basename(path),
			summary: {
				sessionId: header.id,
				mode: "code",
				cwdOrigin: "user-selected",
				cwd,
				createdAt: header.timestamp,
				updatedAt: header.timestamp,
				state: "idle",
				archived: false,
				unread: false,
				useMemory: true,
				contributeMemory: true,
			},
		});
		try {
			const runtime = (opened as unknown as { runtime: AgentSessionRuntime }).runtime;
			if (owner === "extension") expect(runtime.services.resourceLoader.getExtensions().extensions).toHaveLength(1);
			else expect(runtime.session.mcp?.getServerConfigs()).toHaveLength(1);
			expect(opened.isActive()).toBe(false);
			expect(opened.canEvictWhenIdle?.()).toBe(false);
		} finally {
			await opened.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);

it("reclaims an unsubscribed production runtime, restores its complete history and runs a turn after resubscribe", async () => {
	const root = mkdtempSync(join(tmpdir(), "metis-idle-runtime-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const sessionId = "00000000-0000-4000-8000-000000000901";
	const manager = SessionManager.create(cwd, join(agentDir, "sessions"), {
		id: sessionId,
		mode: "code",
		permissionPreset: "full",
	});
	const ids = Array.from({ length: 450 }, (_, index) =>
		manager.appendMessage({ role: "user", content: `历史 ${index}`, timestamp: index + 1 }),
	);
	manager.appendCompaction("Preserve earlier work", ids[430], 100_000, undefined, undefined, {
		version: 1,
		messages: [],
	});
	const context = manager.buildSessionContext();
	const header = manager.getHeader()!;
	const path = manager.getSessionFile()!;
	manager.close();
	const ref = {
		path,
		relativePath: basename(path),
		summary: {
			sessionId,
			mode: "code" as const,
			cwdOrigin: "user-selected" as const,
			cwd,
			createdAt: header.timestamp,
			updatedAt: header.timestamp,
			state: "idle" as const,
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		},
	};
	const server = await AppServer.create({ agentDir, maxIdleRuntimes: 0, idleRuntimeGraceMs: 60_000 });
	try {
		const connection = server.connect();
		const events: DomainEvent[] = [];
		connection.onMessage((message) => {
			if ("method" in message && message.method === "connection/events") events.push(...message.params.events);
		});
		await connection.handle({
			jsonrpc: "2.0",
			id: "init",
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				client: { name: "idle-runtime-test", version: "1" },
				capabilities: [],
			},
		});
		const subscribe = async () => {
			const response = await connection.handle({
				jsonrpc: "2.0",
				id: "subscribe",
				method: "session/subscribe",
				params: { sessionId },
			});
			expect(response).toHaveProperty("result.snapshot");
			return (response as { result: { snapshot: SessionSnapshot } }).result.snapshot;
		};
		const first = await subscribe();
		const original = await server.registry.open(ref);
		expect(original.canEvictWhenIdle?.()).toBe(true);
		const close = vi.spyOn(original, "close");
		const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
		await server.registry.pruneIdleRuntimes();
		expect(close).not.toHaveBeenCalled();
		expect(server.subscriptions.hasSubscribers(sessionId)).toBe(true);
		await connection.handle({
			jsonrpc: "2.0",
			id: "unsubscribe",
			method: "session/unsubscribe",
			params: { sessionId },
		});
		await server.registry.pruneIdleRuntimes();
		expect(close).toHaveBeenCalledOnce();
		expect(server.registry.has(sessionId)).toBe(false);
		const restored = await subscribe();
		expect(restored.recentItems).toEqual(first.recentItems);
		expect(restored.permissionPreset).toEqual(first.permissionPreset);
		expect(restored.nextBeforeItemId).toEqual(first.nextBeforeItemId);
		const reopened = await server.registry.open(ref);
		expect(reopened).not.toBe(original);
		const runtime = (reopened as unknown as { runtime: AgentSessionRuntime }).runtime;
		expect(runtime.session.sessionManager.buildSessionContext()).toEqual(context);
		const all = [...restored.recentItems];
		let beforeItemId = restored.nextBeforeItemId;
		while (beforeItemId) {
			const page = await reopened.readItems({ sessionId, beforeItemId, limit: 100 });
			all.unshift(...page.items);
			beforeItemId = page.nextBeforeItemId;
		}
		expect(all.filter((item) => ids.includes(item.itemId)).map((item) => item.itemId)).toEqual(ids);
		time.mockRestore();
		const session = runtime.session;
		const provider = fauxProvider();
		session.agent.state.model = provider.getModel();
		runtime.services.authStorage.setRuntimeApiKey(provider.getModel().provider, "offline-test");
		const seenContexts: unknown[] = [];
		session.agent.streamFn = (_model, request) => {
			seenContexts.push(request.messages);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("restored response") }),
			);
			return stream;
		};
		await server.registry.run(ref, (opened) =>
			opened.startTurn({
				sessionId,
				requestId: "00000000-0000-4000-8000-000000000902",
				text: "continue after restore",
			}),
		);
		await vi.waitFor(() => expect(events.some((event) => event.type === "turn/completed")).toBe(true));
		expect(seenContexts).toHaveLength(1);
		expect(JSON.stringify(seenContexts[0])).toContain("continue after restore");
		expect(JSON.stringify(seenContexts[0])).toContain("Preserve earlier work");
		const completed = events.filter(
			(event) =>
				event.type === "item/completed" &&
				event.item.content.some((block) => block.type === "text" && block.text === "restored response"),
		);
		expect(completed).toHaveLength(1);
		// Keep live usage calibration and its compaction decisions until explicitly closed.
		expect(reopened.canEvictWhenIdle?.()).toBe(false);
	} finally {
		server.beginShutdown();
		await server.waitForShutdown();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
