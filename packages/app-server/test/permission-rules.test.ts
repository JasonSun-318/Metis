import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPermissionRuleStore } from "@metis/coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionRulesService } from "../src/permission-rules.ts";
import type { SessionCatalog } from "../src/session-catalog.ts";
import { AppServerError, type SessionRef } from "../src/session-runtime-host.ts";

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

		expect(service.list({ sessionId: "session-a" })).toMatchObject({
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
		expect(() => service.delete({ sessionId: "session-b", ruleId: rule.id, requestId: REQUEST_ID })).toThrowError(
			expect.objectContaining({ code: "NOT_FOUND" }),
		);
		expect(new PermissionRulesService(agentDir, catalog).list({ sessionId: "session-a" }).rules).toHaveLength(1);
		expect(service.delete({ sessionId: "session-a", ruleId: rule.id, requestId: REQUEST_ID }).rules).toEqual([]);
		expect(() => service.list({ sessionId: "scheduled" })).toThrowError(
			expect.objectContaining({ code: "READ_ONLY_SESSION" }),
		);
	});

	it("fails closed when the rule store is corrupt", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-permission-rules-corrupt-"));
		temporaryDirectories.push(root);
		const project = await realpath(await mkdtemp(join(root, "project-")));
		const catalog = { get: () => sessionRef("session-a", project) } as unknown as SessionCatalog;
		await writeFile(join(root, "permission-rules.json"), "not json", "utf8");

		try {
			new PermissionRulesService(root, catalog).list({ sessionId: "session-a" });
			expect.fail("corrupt stores must fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(AppServerError);
			expect((error as AppServerError).code).toBe("OPERATION_FAILED");
		}
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
		},
		...(scheduled ? { scheduled: { taskId: "task-1", runId: "run-1" } } : {}),
	};
}
