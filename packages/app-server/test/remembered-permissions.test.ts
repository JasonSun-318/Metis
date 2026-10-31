import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPermissionRuleStore, SessionPermissionRuleStore } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it } from "vitest";
import { type OpenPermissionRuleCatalog, PermissionRulesService } from "../src/permission-rules.ts";
import type { SessionCatalog } from "../src/session-catalog.ts";
import type { SessionRef } from "../src/session-runtime-host.ts";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "metis-remembered-permissions-")));
	roots.push(root);
	const projectA = await realpath(await mkdtemp(join(root, "project-a-")));
	const projectB = await realpath(await mkdtemp(join(root, "project-b-")));
	const refs = [projectA, projectB].map(
		(cwd, index): SessionRef => ({
			path: join(root, `session-${index}.jsonl`),
			relativePath: `session-${index}.jsonl`,
			summary: {
				sessionId: `session-${index}`,
				name: index === 0 ? "Research task" : "Project B",
				mode: "chat",
				cwdOrigin: index === 0 ? "managed" : "user-selected",
				cwd,
				createdAt: "2026-10-29T00:00:00.000Z",
				updatedAt: "2026-10-29T00:00:00.000Z",
				state: "idle",
				archived: false,
				unread: false,
				useMemory: true,
				contributeMemory: true,
			},
		}),
	);
	const catalog = {
		get: (id: string) => refs.find((ref) => ref.summary.sessionId === id)!,
		list: () => ({ sessions: refs.map((ref) => ref.summary), nextAfterSessionId: null }),
	} as unknown as SessionCatalog;
	const live = new Map<string, SessionPermissionRuleStore>();
	const openSessions: OpenPermissionRuleCatalog = {
		listOpenPermissionSessionIds: () => [...live.keys()],
		async withOpenSessionPermissionRules(sessionId, operation) {
			const store = live.get(sessionId);
			if (!store) return { open: false };
			return {
				open: true,
				result: await operation({
					listSessionPermissionRules: (project) => store.list(project),
					deleteSessionPermissionRule: (project, id) => store.delete(project, id),
					clearSessionPermissionRules: (project) => store.clear(project),
				}),
			};
		},
	};
	const input = (projectPath: string) => ({
		projectPath,
		actionDigest: "a".repeat(64),
		grantDigest: "b".repeat(64),
		toolName: "bash",
		toolIdentity: "builtin:bash",
		riskLevel: "low" as const,
		summary: [{ label: "Command", value: "pwd" }],
	});
	return {
		root,
		projectA,
		projectB,
		refs,
		live,
		input,
		openSessions,
		store: new ProjectPermissionRuleStore(root),
		service: new PermissionRulesService(root, catalog),
	};
}

describe("global remembered permission management", () => {
	it("lists persisted grants across projects with no active chat and includes orphaned project grants", async () => {
		const { projectA, projectB, store, service, openSessions, input } = await setup();
		const a = store.rememberAllow(input(projectA));
		const b = store.rememberDeny(input(projectB));
		await rm(projectB, { recursive: true });
		const result = await service.listRemembered(openSessions);
		expect(result.groups).toEqual([
			expect.objectContaining({
				projectPath: projectA,
				projectName: "Research task",
				scope: "project",
				rules: [expect.objectContaining({ id: a.id, decision: "allow" })],
			}),
			expect.objectContaining({
				projectPath: projectB,
				scope: "project",
				rules: [expect.objectContaining({ id: b.id, decision: "deny" })],
			}),
		]);
	});

	it("keeps persisted grants readable when a live session disappears from the catalog", async () => {
		const { projectA, projectB, store, service, openSessions, input, live, refs } = await setup();
		store.rememberAllow(input(projectA));
		store.rememberAllow(input(projectB));
		live.set("session-1", new SessionPermissionRuleStore("session-1"));
		refs.splice(1, 1);

		const result = await service.listRemembered(openSessions);
		expect(result.groups.map((group) => group.projectPath)).toEqual([projectA, projectB]);
	});

	it("revokes only the addressed project and persists the result even if its directory is gone", async () => {
		const { root, projectA, projectB, store, service, openSessions, input } = await setup();
		const a = store.rememberAllow(input(projectA));
		const b = store.rememberAllow(input(projectB));
		await expect(
			service.revokeRemembered(
				{ requestId: REQUEST_ID, scope: "project", projectPath: projectB, ruleId: a.id },
				openSessions,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(store.listAll()).toHaveLength(2);
		await rm(projectA, { recursive: true });
		expect(
			await service.revokeRemembered(
				{ requestId: REQUEST_ID, scope: "project", projectPath: projectA, ruleId: a.id },
				openSessions,
			),
		).toEqual({ deleted: true });
		expect(new ProjectPermissionRuleStore(root).listAll().map((rule) => rule.id)).toEqual([b.id]);
	});

	it("lists only live session grants and keeps project and session revocation isolated", async () => {
		const { projectA, store, service, openSessions, input, live } = await setup();
		const projectRule = store.rememberAllow(input(projectA));
		const session = new SessionPermissionRuleStore("session-0");
		const sessionRule = session.rememberAllow(input(projectA));
		live.set("session-0", session);
		expect((await service.listRemembered(openSessions)).groups).toEqual([
			expect.objectContaining({ scope: "project" }),
			expect.objectContaining({
				scope: "session",
				sessionId: "session-0",
				sessionTitle: "Research task",
				rules: [expect.objectContaining({ id: sessionRule.id })],
			}),
		]);
		await expect(
			service.revokeRemembered(
				{ requestId: REQUEST_ID, scope: "session", sessionId: "session-1", ruleId: sessionRule.id },
				openSessions,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(session.list(projectA)).toHaveLength(1);
		await service.revokeRemembered(
			{ requestId: REQUEST_ID, scope: "session", sessionId: "session-0", ruleId: sessionRule.id },
			openSessions,
		);
		expect(session.list(projectA)).toEqual([]);
		expect(store.list(projectA).map((rule) => rule.id)).toEqual([projectRule.id]);
		session.rememberAllow(input(projectA));
		live.clear();
		expect((await service.listRemembered(openSessions)).groups.map((group) => group.scope)).toEqual(["project"]);
	});

	it("reports corrupt persistent storage instead of presenting an empty success", async () => {
		const { root, service, openSessions } = await setup();
		await writeFile(join(root, "permission-rules.json"), "not-json");
		await expect(service.listRemembered(openSessions)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
	});
});
