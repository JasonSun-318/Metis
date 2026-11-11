import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArchivedConversationView, PROTOCOL_VERSION } from "@metis/app-protocol";
import { AgentStore, SessionManager } from "@metis/coding-agent/host";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";
import { AppServer } from "../src/app-server.ts";
import { ArchivedConversationCatalog } from "../src/archived-conversations.ts";
import type { SessionRuntimeHost } from "../src/session-runtime-host.ts";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "metis-archived-conversations-"));
	const agentDir = join(directory, "agent");
	const sessionsRoot = join(agentDir, "sessions");
	const cwd = join(directory, "project");
	mkdirSync(cwd, { recursive: true });
	const roots: SessionManager[] = [];
	onTestFinished(() => {
		vi.restoreAllMocks();
		for (const root of roots) root.close();
		rmSync(directory, { recursive: true, force: true });
	});
	function root(name: string) {
		const manager = SessionManager.create(cwd, sessionsRoot, { id: randomUUID() });
		manager.appendSessionInfo(name);
		roots.push(manager);
		return { manager, store: new AgentStore(manager, agentDir) };
	}
	function child(owner: ReturnType<typeof root>, name: string, parentPath: readonly string[] = []) {
		const agentId = randomUUID();
		const taskId = randomUUID();
		const record = owner.store.create(
			{
				agentId,
				name,
				agentType: "default",
				initialTask: "Review",
				tools: ["read"],
				writePolicy: "inherit",
				permissionPreset: "ask",
				model: { provider: "test", modelId: "test" },
				thinkingLevel: "off",
				cwd,
				forkTurns: 0,
				timeoutSeconds: 60,
				mayDelegate: true,
				parentSessionId: parentPath.at(-1) ?? owner.manager.getSessionId(),
				rootSessionId: owner.manager.getSessionId(),
				agentPath: [...parentPath, agentId],
			},
			[],
			taskId,
		);
		owner.store.appendTaskState(agentId, { taskId, status: "stopped" });
		return record;
	}
	async function server(
		runtimeHost: SessionRuntimeHost = {
			open: vi.fn(async () => {
				throw new Error("Unexpected model runtime");
			}),
		},
	) {
		for (const root of roots) root.close();
		const app = await AppServer.create({
			agentDir,
			sessionsRoot,
			runtimeHost,
			titleGenerator: { generate: async () => undefined },
		});
		const connection = app.connect();
		await connection.handle({
			jsonrpc: "2.0",
			id: "init",
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				client: { name: "archive-test", version: "1" },
				capabilities: [],
			},
		});
		return {
			app,
			runtimeHost,
			call: (method: string, params: Record<string, unknown>) =>
				connection.handle({ jsonrpc: "2.0", id: randomUUID(), method, params }),
		};
	}
	return { directory, agentDir, root, child, server };
}

async function stop(app: AppServer) {
	app.beginShutdown();
	await app.waitForShutdown();
}

describe("archived conversations", () => {
	it("lists archived roots and hidden child subtrees with metadata-only, cached reads and stable pagination", async () => {
		const f = fixture();
		const archived = f.root("Archived root");
		const child = f.child(archived, "Child inside archived root");
		const live = f.root("Active root");
		const hidden = f.child(live, "Archived child");
		const nested = f.child(live, "Nested hidden child", [hidden.agentId]);
		const visible = f.child(live, "Visible child");
		live.store.setArchived(hidden.agentId, true);
		live.store.setName(hidden.agentId, "Renamed archived child");
		const writer = SessionManager.open(child.path);
		writer.appendMessage({ role: "user", content: "secret-history".repeat(10000), timestamp: Date.now() });
		writer.close();
		const { app, runtimeHost, call } = await f.server();
		try {
			expect(
				await call("session/archive", { sessionId: archived.manager.getSessionId(), requestId: randomUUID() }),
			).toHaveProperty("result.session.archived", true);
			const readOnly = vi.spyOn(SessionManager, "openReadOnly");
			const writerOpen = vi.spyOn(SessionManager, "open");
			const headerReads = vi.spyOn(SessionManager, "readHeaderReadOnly");
			const conversations: ArchivedConversationView[] = [];
			let cursor: string | undefined;
			do {
				const response = await call("session/archived/list", { limit: 2, ...(cursor ? { cursor } : {}) });
				expect(response).not.toHaveProperty("error");
				const page = (
					response as { result: { conversations: ArchivedConversationView[]; nextCursor: string | null } }
				).result;
				expect(page.conversations.length).toBeLessThanOrEqual(2);
				conversations.push(...page.conversations);
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
			expect(conversations).toHaveLength(4);
			expect(
				conversations.filter((entry) => entry.kind === "session").map((entry) => entry.session.sessionId),
			).toEqual([archived.manager.getSessionId()]);
			expect(new Set(conversations.flatMap((entry) => (entry.kind === "agent" ? [entry.agentId] : [])))).toEqual(
				new Set([child.agentId, hidden.agentId, nested.agentId]),
			);
			expect(
				conversations.find((entry) => entry.kind === "agent" && entry.agentId === hidden.agentId),
			).toMatchObject({ name: "Renamed archived child" });
			expect(JSON.stringify(conversations)).not.toContain("secret-history");
			expect(JSON.stringify(conversations)).not.toContain(visible.agentId);
			expect(readOnly).not.toHaveBeenCalled();
			expect(writerOpen).not.toHaveBeenCalled();
			expect(runtimeHost.open).not.toHaveBeenCalled();
			expect(headerReads.mock.calls.filter(([path]) => path === child.path)).toHaveLength(1);
			writerOpen.mockRestore();
			readOnly.mockRestore();
			live.store.setName(hidden.agentId, "Updated after cached read");
			const refreshed = await call("session/archived/list", {});
			expect(JSON.stringify(refreshed)).toContain("Updated after cached read");
			const invalid = await call("session/archived/list", { cursor: "invalid" });
			expect(invalid).toHaveProperty("error.data.name", "INVALID_CURSOR");
		} finally {
			await stop(app);
		}
	});

	it("restores a root to its original location and list, keeping independent child archives and history after restart", async () => {
		const f = fixture();
		const root = f.root("Original root");
		const child = f.child(root, "Visible child");
		const hidden = f.child(root, "Independently archived child");
		root.store.setArchived(hidden.agentId, true);
		const childHistory = readFileSync(child.path, "utf8");
		const hiddenHistory = readFileSync(hidden.path, "utf8");
		const sessionId = root.manager.getSessionId();
		const originalPath = root.manager.getSessionFile()!;
		const server = await f.server();
		const originalSummary = structuredClone(server.app.catalog.get(sessionId).summary);
		try {
			expect(await server.call("session/archive", { sessionId, requestId: randomUUID() })).toHaveProperty(
				"result.session.archived",
				true,
			);
			expect(await server.call("session/unarchive", { sessionId, requestId: randomUUID() })).toHaveProperty(
				"result.session.archived",
				false,
			);
			expect(server.app.catalog.get(sessionId).path).toBe(originalPath);
			expect(server.app.catalog.get(sessionId).summary).toMatchObject({
				name: "Original root",
				cwd: originalSummary.cwd,
			});
			const archive = await server.call("session/archived/list", {});
			expect(archive).toMatchObject({ result: { conversations: [{ kind: "agent", agentId: hidden.agentId }] } });
			const visible = await server.call("agent/list", { sessionId });
			expect(visible).toMatchObject({ result: { agents: [{ agentId: child.agentId, archived: false }] } });
			expect(readFileSync(child.path, "utf8")).toBe(childHistory);
			expect(readFileSync(hidden.path, "utf8")).toBe(hiddenHistory);
			expect(server.runtimeHost.open).not.toHaveBeenCalled();
		} finally {
			await stop(server.app);
		}
		const restarted = await f.server();
		try {
			expect(restarted.app.catalog.get(sessionId).summary.archived).toBe(false);
			expect(await restarted.call("session/archived/list", {})).toMatchObject({
				result: { conversations: [{ kind: "agent", agentId: hidden.agentId }] },
			});
		} finally {
			await stop(restarted.app);
		}
	});

	it("deletes an archived root's child subtree without opening or restoring its parent, including retries after restart", async () => {
		const f = fixture();
		const root = f.root("Root stays archived");
		const parent = f.child(root, "Delete subtree");
		const nested = f.child(root, "Nested", [parent.agentId]);
		const sibling = f.child(root, "Keep sibling");
		let server = await f.server();
		const sessionId = root.manager.getSessionId();
		try {
			expect(await server.call("session/archive", { sessionId, requestId: randomUUID() })).toHaveProperty(
				"result.session.archived",
				true,
			);
			const archivedPath = server.app.catalog.get(sessionId).path;
			const input = { sessionId, agentId: parent.agentId, requestId: randomUUID() };
			expect(await server.call("agent/delete", input)).toHaveProperty("result.status", "deleted");
			expect(await server.call("agent/delete", input)).toHaveProperty("result.status", "deleted");
			expect(existsSync(parent.path)).toBe(false);
			expect(existsSync(nested.path)).toBe(false);
			expect(existsSync(sibling.path)).toBe(true);
			expect(existsSync(archivedPath)).toBe(true);
			expect(server.app.catalog.get(sessionId).summary.archived).toBe(true);
			expect(server.runtimeHost.open).not.toHaveBeenCalled();
			await stop(server.app);
			server = await f.server();
			expect(await server.call("agent/delete", { ...input, requestId: randomUUID() })).toHaveProperty(
				"result.status",
				"deleted",
			);
			const list = await server.call("session/archived/list", {});
			expect(JSON.stringify(list)).toContain(sibling.agentId);
			expect(JSON.stringify(list)).not.toContain(parent.agentId);
			expect(server.app.catalog.get(sessionId).summary.archived).toBe(true);
			expect(
				await server.call("agent/delete", { sessionId, agentId: randomUUID(), requestId: randomUUID() }),
			).toHaveProperty("error.data.name", "NOT_FOUND");
			expect(server.runtimeHost.open).not.toHaveBeenCalled();
		} finally {
			await stop(server.app);
		}
	});

	it.skipIf(process.platform !== "linux")(
		"reports a fixed operation failure when an archived child cannot be moved to the trash",
		async () => {
			const f = fixture();
			const root = f.root("Root stays archived");
			const child = f.child(root, "Cannot trash");
			const blocker = join(f.directory, "xdg-data-home");
			writeFileSync(blocker, "not a directory");
			const previous = process.env.XDG_DATA_HOME;
			process.env.XDG_DATA_HOME = blocker;
			const server = await f.server();
			try {
				const sessionId = root.manager.getSessionId();
				expect(await server.call("session/archive", { sessionId, requestId: randomUUID() })).toHaveProperty(
					"result.session.archived",
					true,
				);
				const response = await server.call("agent/delete", {
					sessionId,
					agentId: child.agentId,
					requestId: randomUUID(),
				});
				expect(response).toMatchObject({
					error: { message: "Operation failed", data: { name: "OPERATION_FAILED" } },
				});
				const wire = JSON.stringify(response);
				expect(wire).not.toContain(blocker);
				expect(wire).not.toContain("ENOTDIR");
				expect(wire).not.toContain(child.path);
				expect(existsSync(child.path)).toBe(true);
			} finally {
				if (previous === undefined) delete process.env.XDG_DATA_HOME;
				else process.env.XDG_DATA_HOME = previous;
				await stop(server.app);
			}
		},
	);

	it("renames a persisted child through the dispatcher/runtime bridge and retains the result after reopening", async () => {
		const f = fixture();
		const root = f.root("Root");
		const child = f.child(root, "Original child");
		const server = await f.server(new AgentSessionRuntimeHost({ agentDir: f.agentDir }));
		try {
			const params = {
				sessionId: root.manager.getSessionId(),
				agentId: child.agentId,
				name: "New child name",
				requestId: randomUUID(),
			};
			expect(await server.call("agent/rename", params)).toHaveProperty("result.agent.name", params.name);
			expect(await server.call("agent/rename", params)).toHaveProperty("result.agent.name", params.name);
			await server.app.registry.close(params.sessionId);
			const list = await server.call("agent/list", { sessionId: params.sessionId });
			expect(list).toHaveProperty("result.agents.0.name", params.name);
			expect(root.store.load(child.agentId).name).toBe(params.name);
		} finally {
			await stop(server.app);
		}
	}, 30_000);

	it("returns an empty page without opening a runtime and rejects malformed cursors", async () => {
		const f = fixture();
		const catalog = new ArchivedConversationCatalog(f.agentDir);
		await expect(catalog.list([], {})).resolves.toEqual({ conversations: [], nextCursor: null });
		await expect(catalog.list([], { cursor: "e30" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
	});
});
