import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { readThreadGoal, writeThreadGoal } from "../src/core/goal/store.ts";
import {
	createCreateGoalToolDefinition,
	createGetGoalToolDefinition,
	createUpdateGoalToolDefinition,
} from "../src/core/goal/tools.ts";
import { classifyAction } from "../src/core/permission-policy.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function manager(): SessionManager {
	const dir = mkdtempSync(join(tmpdir(), "metis-goal-tools-"));
	return SessionManager.create(dir, dir);
}

describe("goal tools", () => {
	it("get_goal returns null when no goal exists", async () => {
		const session = manager();
		const tool = createGetGoalToolDefinition({ getSession: () => session });
		expect(Object.keys(tool.parameters.properties)).toEqual([]);
		const result = await tool.execute("g1", {}, undefined, undefined, {} as never);
		expect(result.details).toEqual({ goal: null, ok: true });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ goal: null });
	});

	it("create_goal creates an active goal and rejects unfinished replacements", async () => {
		const session = manager();
		const changes: unknown[] = [];
		const tool = createCreateGoalToolDefinition({
			getSession: () => session,
			onChange: (goal) => changes.push(goal),
		});
		expect(Value.Check(tool.parameters, { objective: "ship it", token_budget: 1 })).toBe(false);

		const created = await tool.execute("c1", { objective: "  ship the review  " }, undefined, undefined, {} as never);
		expect(created.details.goal?.status).toBe("active");
		expect(created.details.goal?.objective).toBe("ship the review");
		expect(changes).toHaveLength(1);

		const beforeRejectedCreate = session.getEntries();
		await expect(tool.execute("c2", { objective: "another" }, undefined, undefined, {} as never)).rejects.toThrow(
			/unfinished/,
		);
		expect(session.getEntries()).toEqual(beforeRejectedCreate);

		writeThreadGoal(session, { ...created.details.goal!, status: "complete" });
		const next = await tool.execute("c3", { objective: "next goal" }, undefined, undefined, {} as never);
		expect(next.details.goal?.goalId).not.toBe(created.details.goal?.goalId);
		expect(next.details.goal?.objective).toBe("next goal");
	});

	it("update_goal only accepts complete or blocked and requires an existing goal", async () => {
		const session = manager();
		const tool = createUpdateGoalToolDefinition({ getSession: () => session });
		expect(Value.Check(tool.parameters, { status: "paused" })).toBe(false);
		expect(Value.Check(tool.parameters, { status: "complete" })).toBe(true);

		await expect(tool.execute("u0", { status: "complete" }, undefined, undefined, {} as never)).rejects.toThrow(
			/no goal/,
		);

		writeThreadGoal(session, { objective: "finish", status: "active" });
		const completed = await tool.execute("u1", { status: "complete" }, undefined, undefined, {} as never);
		expect(completed.details.goal?.status).toBe("complete");
		expect(readThreadGoal(session)?.status).toBe("complete");

		writeThreadGoal(session, { objective: "finish", status: "active" });
		const blocked = await tool.execute("u2", { status: "blocked" }, undefined, undefined, {} as never);
		expect(blocked.details.goal?.status).toBe("blocked");
	});

	it("classifies goal tools as ordinary-read", () => {
		for (const toolName of ["get_goal", "create_goal", "update_goal"] as const) {
			const action = classifyAction({
				actionId: `${toolName}-1`,
				toolName,
				provenance: "builtin",
				args: {},
				cwd: process.cwd(),
				workspaceRoots: [process.cwd()],
			});
			expect(action.risks).toEqual(["ordinary-read"]);
		}
	});
});
