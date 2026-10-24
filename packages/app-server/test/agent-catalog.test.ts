import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { SessionSummary } from "@metis/app-protocol";
import { AgentStore, SessionManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it } from "vitest";
import { listAgentCatalog, readAgentCatalogItems } from "../src/agent-catalog.ts";
import { AppServerError, type SessionRef } from "../src/session-runtime-host.ts";

const ROOT_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_ROOT_ID = "00000000-0000-4000-8000-000000000020";
const CHAT_AGENT_ID = "00000000-0000-4000-8000-000000000101";
const CHAT_TASK_ID = "00000000-0000-4000-8000-000000000102";
const UNKNOWN_TASK_ID = "00000000-0000-4000-8000-000000000103";
const PAGED_AGENT_IDS = [
	"00000000-0000-4000-8000-000000000201",
	"00000000-0000-4000-8000-000000000202",
	"00000000-0000-4000-8000-000000000203",
	"00000000-0000-4000-8000-000000000204",
	"00000000-0000-4000-8000-000000000205",
] as const;
const ARCHIVED_AGENT_ID = PAGED_AGENT_IDS[3];
const OWNED_AGENT_ID = "00000000-0000-4000-8000-000000000301";
const FOREIGN_AGENT_ID = "00000000-0000-4000-8000-000000000302";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type AgentConfig = Parameters<AgentStore["create"]>[0];
type RoleSnapshot = NonNullable<AgentConfig["roleSnapshot"]>;

interface Fixture {
	readonly root: string;
	readonly projectDir: string;
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly manager: SessionManager;
	readonly store: AgentStore;
}

interface CreateAgentInput {
	readonly id: string;
	readonly name: string;
	readonly taskId: string;
	readonly rootId?: string;
	readonly parentId?: string;
	readonly agentPath?: readonly string[];
	readonly mode?: "chat" | "code";
	readonly roleSnapshot?: RoleSnapshot;
	readonly archived?: boolean;
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "metis-agent-catalog-"));
	temporaryRoots.push(root);
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(projectDir);
	mkdirSync(agentDir);
	const sessionsRoot = join(agentDir, "sessions");
	const manager = SessionManager.create(projectDir, sessionsRoot, {
		id: ROOT_ID,
		mode: "code",
		permissionPreset: "full",
	});
	return { root, projectDir, agentDir, sessionsRoot, manager, store: new AgentStore(manager, agentDir) };
}

function createAgent(store: AgentStore, projectDir: string, input: CreateAgentInput): ReturnType<AgentStore["create"]> {
	const rootId = input.rootId ?? ROOT_ID;
	const config: AgentConfig = {
		agentId: input.id,
		name: input.name,
		agentType: "worker",
		initialTask: `Task for ${input.name}`,
		tools: ["read"],
		writePolicy: "inherit",
		permissionPreset: "full",
		model: { provider: "fixture", modelId: "fixture-model" },
		thinkingLevel: "off",
		cwd: projectDir,
		forkTurns: 0,
		timeoutSeconds: 60,
		mayDelegate: false,
		parentSessionId: input.parentId ?? rootId,
		rootSessionId: rootId,
		agentPath: input.agentPath ?? [input.id],
		...(input.mode ? { mode: input.mode } : {}),
		...(input.roleSnapshot ? { roleSnapshot: input.roleSnapshot } : {}),
	};
	const record = store.create(config, [], input.taskId);
	if (input.archived) store.setArchived(input.id, true);
	return record;
}

function sessionRef(fixture: Fixture, path: string, sessionId: string, createdAt: string): SessionRef {
	const summary: SessionSummary = {
		sessionId,
		mode: "code",
		cwdOrigin: "user-selected",
		cwd: fixture.projectDir,
		createdAt,
		updatedAt: createdAt,
		state: "idle",
		archived: false,
		unread: false,
		useMemory: true,
		contributeMemory: true,
	};
	return {
		path,
		relativePath: relative(fixture.sessionsRoot, path).split(sep).join("/"),
		summary,
	};
}

function rootRef(fixture: Fixture, manager = fixture.manager): SessionRef {
	const path = manager.getSessionFile();
	const header = manager.getHeader();
	if (!path || !header) throw new Error("Fixture session must be persisted");
	return sessionRef(fixture, path, header.id, header.timestamp);
}

function walk(directory: string, visit: (path: string, isDirectory: boolean) => void): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		visit(path, entry.isDirectory());
		if (entry.isDirectory() && !entry.name.endsWith(".lease")) walk(path, visit);
	}
}

function digestTree(root: string): Map<string, string> {
	const files = new Map<string, string>();
	walk(root, (path, isDirectory) => {
		if (isDirectory) return;
		files.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
	});
	return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}

function leaseArtifacts(root: string): string[] {
	const artifacts: string[] = [];
	walk(root, (path, isDirectory) => {
		const name = path.split(sep).at(-1) ?? "";
		if (name.endsWith(".lease") || name.includes(".write.lock")) artifacts.push(path);
		if (isDirectory && name.endsWith(".lease")) return;
	});
	return artifacts.sort();
}

function expectAppError(run: () => unknown, code: "NOT_FOUND" | "INVALID_CURSOR"): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(AppServerError);
	expect((caught as AppServerError).code).toBe(code);
}

function appendChatHistory(path: string): { readonly userId: string; readonly assistantId: string } {
	const manager = SessionManager.open(path);
	try {
		const userId = manager.appendMessage({
			role: "user",
			content: "child-owned-history",
			timestamp: Date.now(),
		});
		const assistantId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "child-owned-answer" }],
			api: "openai-completions",
			provider: "fixture",
			model: "fixture-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		return { userId, assistantId };
	} finally {
		manager.close();
	}
}

describe("agent catalog", () => {
	it("reports a corrupt child without hiding readable siblings or mutating the broken journal", () => {
		const fixture = createFixture();
		const valid = createAgent(fixture.store, fixture.projectDir, {
			id: CHAT_AGENT_ID,
			name: "Valid",
			taskId: CHAT_TASK_ID,
		});
		const broken = join(dirname(valid.path), "broken.jsonl");
		writeFileSync(broken, '{"type":"session","version":15}\ninvalid\n');
		const ref = rootRef(fixture);
		fixture.manager.close();
		const before = digestTree(fixture.root);
		const result = listAgentCatalog(ref, fixture.agentDir, { sessionId: ROOT_ID });
		expect(result.agents.map((agent) => agent.agentId)).toEqual([CHAT_AGENT_ID]);
		expect(result.unreadableAgentCount).toBe(1);
		expect(() =>
			readAgentCatalogItems(ref, fixture.agentDir, { sessionId: ROOT_ID, agentId: CHAT_AGENT_ID, limit: 10 }),
		).not.toThrow();
		expect(digestTree(fixture.root)).toEqual(before);
	});
	it("reads a cold chat subtree and its history without writing or taking a writer lease", () => {
		const fixture = createFixture();
		const roleSnapshot: RoleSnapshot = {
			version: 1,
			agentType: "worker",
			displayName: "Chat worker",
			purpose: "Handle a user conversation in chat mode.",
			systemPrompt: "Stay in chat mode and answer the user.",
			revision: "a".repeat(64),
			source: "created",
		};
		const chat = createAgent(fixture.store, fixture.projectDir, {
			id: CHAT_AGENT_ID,
			name: "Chat worker",
			taskId: CHAT_TASK_ID,
			mode: "chat",
			roleSnapshot,
		});
		fixture.store.appendTaskState(CHAT_AGENT_ID, { taskId: CHAT_TASK_ID, status: "running" });
		appendChatHistory(chat.path);
		const ref = rootRef(fixture);
		fixture.manager.close();

		const before = digestTree(fixture.root);
		expect(leaseArtifacts(fixture.root)).toEqual([]);

		const listed = listAgentCatalog(ref, fixture.agentDir, {
			sessionId: ROOT_ID,
			includeArchived: true,
			limit: 100,
		});
		expect(listed.agents).toHaveLength(1);
		expect(listed.agents[0]).toMatchObject({
			agentId: CHAT_AGENT_ID,
			mode: "chat",
			roleRevision: roleSnapshot.revision,
			status: "running",
			depth: 1,
		});
		expect(listed.nextAfterAgentId).toBeNull();

		const history = readAgentCatalogItems(ref, fixture.agentDir, {
			sessionId: ROOT_ID,
			agentId: CHAT_AGENT_ID,
			limit: 100,
		});
		expect(history.items.map((item) => item.role)).toEqual(expect.arrayContaining(["user", "assistant"]));
		expect(history.items.every((item) => item.sessionId === CHAT_AGENT_ID)).toBe(true);
		expect(JSON.stringify(history.items)).toContain("child-owned-history");
		expect(JSON.stringify(history.items)).toContain("child-owned-answer");

		const latest = readAgentCatalogItems(ref, fixture.agentDir, {
			sessionId: ROOT_ID,
			agentId: CHAT_AGENT_ID,
			limit: 1,
		});
		expect(latest.items).toHaveLength(1);
		expect(latest.nextBeforeItemId).not.toBeNull();
		const earlier = readAgentCatalogItems(ref, fixture.agentDir, {
			sessionId: ROOT_ID,
			agentId: CHAT_AGENT_ID,
			beforeItemId: latest.nextBeforeItemId,
			limit: 1,
		});
		expect(earlier.items).toHaveLength(1);
		expect(earlier.items[0]?.itemId).not.toBe(latest.items[0]?.itemId);
		expect(earlier.nextBeforeItemId).toBeNull();

		const scoped = readAgentCatalogItems(ref, fixture.agentDir, {
			sessionId: ROOT_ID,
			agentId: CHAT_AGENT_ID,
			taskId: CHAT_TASK_ID,
			limit: 100,
		});
		expect(JSON.stringify(scoped.items)).toContain("child-owned-history");
		expectAppError(
			() =>
				readAgentCatalogItems(ref, fixture.agentDir, {
					sessionId: ROOT_ID,
					agentId: CHAT_AGENT_ID,
					taskId: UNKNOWN_TASK_ID,
					limit: 100,
				}),
			"NOT_FOUND",
		);

		expect(digestTree(fixture.root)).toEqual(before);
		expect(leaseArtifacts(fixture.root)).toEqual([]);

		// A real writer lease on the child must not block catalog or history reads.
		const holder = SessionManager.open(chat.path);
		try {
			expect(existsSync(`${chat.path}.lease`)).toBe(true);
			const heldList = listAgentCatalog(ref, fixture.agentDir, {
				sessionId: ROOT_ID,
				includeArchived: true,
				limit: 100,
			});
			const heldHistory = readAgentCatalogItems(ref, fixture.agentDir, {
				sessionId: ROOT_ID,
				agentId: CHAT_AGENT_ID,
				limit: 100,
			});
			expect(heldList.agents.map((agent) => agent.agentId)).toEqual([CHAT_AGENT_ID]);
			expect(JSON.stringify(heldHistory.items)).toContain("child-owned-history");
			expect(existsSync(`${chat.path}.lease`)).toBe(true);
		} finally {
			holder.close();
		}
		expect(leaseArtifacts(fixture.root)).toEqual([]);
	});

	it("pages all subagents, filters archived ones, and rejects unknown cursors", () => {
		const fixture = createFixture();
		for (const [index, agentId] of PAGED_AGENT_IDS.entries()) {
			if (index === 3) continue;
			createAgent(fixture.store, fixture.projectDir, {
				id: agentId,
				name: `Worker ${String(index + 1).padStart(2, "0")}`,
				taskId: `00000000-0000-4000-8000-0000000004${String(index).padStart(2, "0")}`,
			});
		}
		createAgent(fixture.store, fixture.projectDir, {
			id: ARCHIVED_AGENT_ID,
			name: "Archived worker",
			taskId: "00000000-0000-4000-8000-000000000499",
			archived: true,
		});
		const ref = rootRef(fixture);
		fixture.manager.close();

		const fullActive = listAgentCatalog(ref, fixture.agentDir, {
			sessionId: ROOT_ID,
			includeArchived: false,
			limit: 100,
		});
		const activeIds = fullActive.agents.map((agent) => agent.agentId);
		expect(new Set(activeIds)).toEqual(new Set(PAGED_AGENT_IDS.filter((agentId) => agentId !== ARCHIVED_AGENT_ID)));
		const pages: string[][] = [];
		let cursor: string | null = null;
		for (;;) {
			const page = listAgentCatalog(ref, fixture.agentDir, {
				sessionId: ROOT_ID,
				includeArchived: false,
				...(cursor === null ? {} : { afterAgentId: cursor }),
				limit: 2,
			});
			expect(page.agents.length).toBeLessThanOrEqual(2);
			expect(page.agents.every((agent) => !agent.archived)).toBe(true);
			pages.push(page.agents.map((agent) => agent.agentId));
			cursor = page.nextAfterAgentId;
			if (cursor === null) break;
		}
		expect(pages.map((page) => page.length)).toEqual([2, 2]);
		expect(pages.flat()).toEqual(activeIds);

		const all = listAgentCatalog(ref, fixture.agentDir, {
			sessionId: ROOT_ID,
			includeArchived: true,
			limit: 100,
		});
		expect(new Set(all.agents.map((agent) => agent.agentId))).toEqual(new Set(PAGED_AGENT_IDS));
		expect(all.agents.find((agent) => agent.agentId === ARCHIVED_AGENT_ID)?.archived).toBe(true);
		expect(all.nextAfterAgentId).toBeNull();

		expectAppError(
			() =>
				listAgentCatalog(ref, fixture.agentDir, {
					sessionId: ROOT_ID,
					includeArchived: true,
					afterAgentId: "00000000-0000-4000-8000-000000000999",
					limit: 2,
				}),
			"INVALID_CURSOR",
		);
		expectAppError(
			() =>
				listAgentCatalog(ref, fixture.agentDir, {
					sessionId: ROOT_ID,
					includeArchived: false,
					afterAgentId: ARCHIVED_AGENT_ID,
					limit: 2,
				}),
			"INVALID_CURSOR",
		);
	});

	it("rejects reading an agent from another root tree or through a child session ref", () => {
		const fixture = createFixture();
		const owned = createAgent(fixture.store, fixture.projectDir, {
			id: OWNED_AGENT_ID,
			name: "Owned worker",
			taskId: "00000000-0000-4000-8000-000000000401",
		});
		const otherManager = SessionManager.create(fixture.projectDir, fixture.sessionsRoot, {
			id: OTHER_ROOT_ID,
			mode: "code",
			permissionPreset: "full",
		});
		const otherStore = new AgentStore(otherManager, fixture.agentDir);
		createAgent(otherStore, fixture.projectDir, {
			id: FOREIGN_AGENT_ID,
			name: "Foreign worker",
			taskId: "00000000-0000-4000-8000-000000000402",
			rootId: OTHER_ROOT_ID,
		});
		const ownedRef = rootRef(fixture);
		const otherRef = rootRef(fixture, otherManager);
		const childRef = sessionRef(
			fixture,
			owned.path,
			owned.agentId,
			owned.tasks[0]?.createdAt ?? new Date(0).toISOString(),
		);
		fixture.manager.close();
		otherManager.close();

		expect(
			listAgentCatalog(otherRef, fixture.agentDir, {
				sessionId: OTHER_ROOT_ID,
				includeArchived: true,
				limit: 10,
			}).agents.map((agent) => agent.agentId),
		).toEqual([FOREIGN_AGENT_ID]);
		expectAppError(
			() =>
				readAgentCatalogItems(ownedRef, fixture.agentDir, {
					sessionId: ROOT_ID,
					agentId: FOREIGN_AGENT_ID,
					limit: 10,
				}),
			"NOT_FOUND",
		);
		expectAppError(
			() =>
				readAgentCatalogItems(childRef, fixture.agentDir, {
					sessionId: owned.agentId,
					agentId: OWNED_AGENT_ID,
					limit: 10,
				}),
			"NOT_FOUND",
		);
		const mismatchedRef: SessionRef = {
			...otherRef,
			summary: { ...otherRef.summary, sessionId: ROOT_ID },
		};
		expectAppError(
			() =>
				listAgentCatalog(mismatchedRef, fixture.agentDir, {
					sessionId: ROOT_ID,
					includeArchived: true,
					limit: 10,
				}),
			"NOT_FOUND",
		);
	});
});
