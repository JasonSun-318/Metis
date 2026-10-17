import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@metis/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type HookContext = Parameters<NonNullable<AgentSession["agent"]["afterToolCall"]>>[0];
const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(mode: "code" | "chat") {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "metis-session-diffs-")));
	roots.push(cwd);
	await writeFile(join(cwd, "app.ts"), "old\n");
	const agentDir = join(cwd, "agent");
	const sessionManager = SessionManager.inMemory(cwd, { mode });
	sessionManager.setPermissionPreset("full");
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
		model: getModel("anthropic", "claude-sonnet-4-5")!,
	});
	sessions.push(session);
	return session;
}

async function execute(session: AgentSession, name: string, id: string, args: Record<string, unknown>) {
	const tool = session.agent.state.tools.find((tool) => tool.name === name)!;
	let isError = false;
	let result: HookContext["result"];
	try {
		result = await tool.execute(id, args);
	} catch (error) {
		isError = true;
		result = { content: [{ type: "text", text: String(error) }], details: {} };
	}
	const hooked = await session.agent.afterToolCall?.({
		toolCall: { type: "toolCall", id, name, arguments: args },
		args,
		result,
		isError,
		assistantMessage: {} as HookContext["assistantMessage"],
		context: {} as HookContext["context"],
	});
	return { details: hooked?.details ?? result.details, isError: hooked?.isError ?? isError };
}

describe("AgentSession Code diffs", () => {
	it("attaches actual authorized edit/write changes and net totals to finalized tool details", async () => {
		const session = await fixture("code");
		const written = await execute(session, "write", "write-1", { path: "app.ts", content: "new\n" });
		expect(written.details).toMatchObject({
			codeChanges: { files: [{ additions: 1, deletions: 1 }], turn: { additions: 1, deletions: 1 } },
		});
		const edited = await execute(session, "edit", "edit-2", {
			path: "app.ts",
			edits: [{ oldText: "new", newText: "old" }],
		});
		expect(edited.details).toMatchObject({
			patch: expect.any(String),
			codeChanges: { turn: { additions: 0, deletions: 0 } },
		});
	});

	it("keeps a failed command's error and the diff for changes made before failure", async () => {
		const session = await fixture("code");
		const failed = await execute(session, "bash", "bash-1", { command: "printf 'changed\\n' > app.ts; exit 1" });
		expect(failed.isError).toBe(true);
		expect(failed.details).toMatchObject({
			codeChanges: { files: [expect.objectContaining({ diff: expect.stringContaining("+changed") })] },
		});
	});

	it("leaves Chat mode tool results unchanged", async () => {
		const session = await fixture("chat");
		const result = await execute(session, "write", "chat-write", { path: "app.ts", content: "new\n" });
		expect(result.isError).toBe(false);
		expect(result.details?.codeChanges).toBeUndefined();
	});
});
