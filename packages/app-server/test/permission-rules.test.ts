import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPermissionRuleStore, SessionPermissionRuleStore } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it } from "vitest";
import {
	type OpenSessionPermissionRules,
	PermissionRulesService,
	type SessionPermissionRuleAccess,
} from "../src/permission-rules.ts";
import type { SessionCatalog } from "../src/session-catalog.ts";
import type { SessionRef } from "../src/session-runtime-host.ts";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

describe("PermissionRulesService", () => {
	const temporaryDirectories: string[] = [];
	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("uses the session-owned project and safely lists, revokes, and persists exact rules", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-permission-rules-"));
		temporaryDirectories.push(root);
		const agentDir = await realpath(root);
		const projectA = await realpath(await mkdtemp(join(root, "project-a-")));
		const projectB = await realpath(await mkdtemp(join(root, "project-b-")));
		const refs = new Map([
			["session-a", sessionRef("session-a", projectA)],
			["session-b", sessionRef("session-b", projectB)],
			["scheduled", sessionRef("scheduled", projectA, true)],
		]);
		const catalog = { get: (sessionId: string) => refs.get(sessionId)! } as SessionCatalog;
		const store = new ProjectPermissionRuleStore(agentDir);
		const rule = store.rememberAllow({
			projectPath: projectA,
			actionDigest: "a".repeat(64),
			grantDigest: "b".repeat(64),
			toolName: "bash",
			toolIdentity: "builtin:bash",
			riskLevel: "low",
			summary: [
				{ label: "Command", value: "pwd" },
				{ label: "Working directory", value: projectA },
				{ label: "Write path", value: join(projectA, "output.txt") },
				{ label: "Execution target", value: "host" },
			],
		});
		const service = new PermissionRulesService(agentDir, catalog);

		expect(await service.list({ sessionId: "session-a" })).toMatchObject({
			projectPath: projectA,
			rules: [
				{
					id: rule.id,
					decision: "allow",
					toolName: "bash",
					command: "pwd",
					paths: [join(projectA, "output.txt")],
					executionTarget: "host",
					details: [
						{ label: "Command", value: "pwd" },
						{ label: "Working directory", value: projectA },
						{ label: "Write path", value: join(projectA, "output.txt") },
						{ label: "Execution target", value: "host" },
					],
					omittedDetails: 0,
				},
			],
		});
		await expect(
			service.delete({ sessionId: "session-b", ruleId: rule.id, requestId: REQUEST_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect((await new PermissionRulesService(agentDir, catalog).list({ sessionId: "session-a" })).rules).toHaveLength(
			1,
		);
		expect((await service.delete({ sessionId: "session-a", ruleId: rule.id, requestId: REQUEST_ID })).rules).toEqual(
			[],
		);
		await expect(service.list({ sessionId: "scheduled" })).rejects.toMatchObject({ code: "READ_ONLY_SESSION" });
	});

	it("fails closed when the rule store is corrupt", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-permission-rules-corrupt-"));
		temporaryDirectories.push(root);
		const project = await realpath(await mkdtemp(join(root, "project-")));
		const catalog = { get: () => sessionRef("session-a", project) } as unknown as SessionCatalog;
		await writeFile(join(root, "permission-rules.json"), "not json", "utf8");

		await expect(new PermissionRulesService(root, catalog).list({ sessionId: "session-a" })).rejects.toMatchObject({
			code: "OPERATION_FAILED",
		});
	});

	it("defaults to project scope and keeps old request semantics", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-permission-rules-default-"));
		temporaryDirectories.push(root);
		const project = await realpath(await mkdtemp(join(root, "project-")));
		const catalog = { get: (sessionId: string) => sessionRef(sessionId, project) } as unknown as SessionCatalog;
		const store = new ProjectPermissionRuleStore(root);
		const rule = store.rememberAllow({
			projectPath: project,
			actionDigest: "a".repeat(64),
			grantDigest: "b".repeat(64),
			toolName: "bash",
			toolIdentity: "builtin:bash",
			riskLevel: "low",
			summary: [],
		});
		const service = new PermissionRulesService(root, catalog);

		expect(await service.list({ sessionId: "session-a" })).toEqual({
			projectPath: project,
			scope: "project",
			rules: [expect.objectContaining({ id: rule.id, decision: "allow" })],
		});
		expect((await service.list({ sessionId: "session-a", scope: "project" })).rules).toHaveLength(1);
	});

	it("lists, revokes, and clears session rules only for the owning live session", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-permission-rules-session-"));
		temporaryDirectories.push(root);
		const project = await realpath(await mkdtemp(join(root, "project-")));
		const catalog = { get: (sessionId: string) => sessionRef(sessionId, project) } as unknown as SessionCatalog;
		const owner = new SessionPermissionRuleStore("session-a");
		const rule = owner.rememberAllow({
			projectPath: project,
			actionDigest: "a".repeat(64),
			grantDigest: "b".repeat(64),
			toolName: "bash",
			toolIdentity: "builtin:bash",
			riskLevel: "low",
			summary: [{ label: "Command", value: "pwd" }],
		});
		const openSessions: OpenSessionPermissionRules = {
			async withOpenSessionPermissionRules(sessionId, operation) {
				if (sessionId !== "session-a") return { open: false };
				const access: SessionPermissionRuleAccess = {
					listSessionPermissionRules: (projectPath) => owner.list(projectPath),
					deleteSessionPermissionRule: (projectPath, ruleId) => owner.delete(projectPath, ruleId),
					clearSessionPermissionRules: (projectPath) => owner.clear(projectPath),
				};
				return { open: true, result: await operation(access) };
			},
		};
		const service = new PermissionRulesService(root, catalog);

		expect(await service.list({ sessionId: "session-a", scope: "session" }, openSessions)).toEqual({
			projectPath: project,
			scope: "session",
			sessionId: "session-a",
			rules: [expect.objectContaining({ id: rule.id, decision: "allow", command: "pwd" })],
		});
		await expect(service.list({ sessionId: "session-b", scope: "session" }, openSessions)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			service.delete(
				{ sessionId: "session-b", ruleId: rule.id, requestId: REQUEST_ID, scope: "session" },
				openSessions,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(owner.list(project)).toHaveLength(1);

		const deleted = await service.delete(
			{ sessionId: "session-a", ruleId: rule.id, requestId: REQUEST_ID, scope: "session" },
			openSessions,
		);
		expect(deleted).toMatchObject({ scope: "session", sessionId: "session-a", rules: [] });
		expect(owner.list(project)).toEqual([]);

		const cleared = await service.clear(
			{ sessionId: "session-a", requestId: REQUEST_ID, scope: "session" },
			openSessions,
		);
		expect(cleared).toMatchObject({ scope: "session", sessionId: "session-a", rules: [] });
	});

	it("fails session scope closed without a live-session accessor", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-permission-rules-cold-"));
		temporaryDirectories.push(root);
		const project = await realpath(await mkdtemp(join(root, "project-")));
		const catalog = { get: (sessionId: string) => sessionRef(sessionId, project) } as unknown as SessionCatalog;
		const service = new PermissionRulesService(root, catalog);

		await expect(service.list({ sessionId: "session-a", scope: "session" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			service.delete({ sessionId: "session-a", ruleId: "c".repeat(64), requestId: REQUEST_ID, scope: "session" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			service.clear({ sessionId: "session-a", requestId: REQUEST_ID, scope: "session" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// The project store must stay untouched by session-scope attempts.
		expect(new ProjectPermissionRuleStore(root).list(project)).toEqual([]);
	});
});

function sessionRef(sessionId: string, cwd: string, scheduled = false): SessionRef {
	return {
		path: join(cwd, `${sessionId}.jsonl`),
		relativePath: `${sessionId}.jsonl`,
		summary: {
			sessionId,
			mode: "code",
			cwdOrigin: "user-selected",
			cwd,
			createdAt: "2026-08-11T00:00:00.000Z",
			updatedAt: "2026-08-11T00:00:00.000Z",
			state: "idle",
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		},
		...(scheduled ? { scheduled: { taskId: "task-1", runId: "run-1" } } : {}),
	};
}
