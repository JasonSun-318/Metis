import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getModel } from "@arcmind/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { getAutoMemoryPaths } from "../src/core/auto-memory.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession auto memory", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "arcmind-session-memory-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("injects both indexes and refreshes external changes on reload", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const paths = getAutoMemoryPaths(agentDir, cwd);
		mkdirSync(dirname(paths.global.indexPath), { recursive: true });
		mkdirSync(dirname(paths.project.indexPath), { recursive: true });
		writeFileSync(paths.global.indexPath, "global-memory-v1");
		writeFileSync(paths.project.indexPath, "project-memory-v1");

		const { session } = await createAgentSession({
			agentDir,
			cwd,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "grep"]));
			expect(session.systemPrompt).toContain("global-memory-v1");
			expect(session.systemPrompt).toContain("project-memory-v1");

			writeFileSync(paths.project.indexPath, "project-memory-v2");
			expect(session.systemPrompt).not.toContain("project-memory-v2");
			await session.reload();
			expect(session.systemPrompt).toContain("project-memory-v2");
			expect(session.systemPrompt).not.toContain("project-memory-v1");
		} finally {
			session.dispose();
		}
	});

	it("shares global memory but isolates project memory by exact cwd", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(firstCwd, { recursive: true });
		mkdirSync(secondCwd, { recursive: true });
		const firstPaths = getAutoMemoryPaths(agentDir, firstCwd);
		mkdirSync(dirname(firstPaths.global.indexPath), { recursive: true });
		mkdirSync(dirname(firstPaths.project.indexPath), { recursive: true });
		writeFileSync(firstPaths.global.indexPath, "shared-global-memory");
		writeFileSync(firstPaths.project.indexPath, "first-project-memory");

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const first = await createAgentSession({ agentDir, cwd: firstCwd, model });
		const second = await createAgentSession({ agentDir, cwd: secondCwd, model });
		try {
			expect(first.session.systemPrompt).toContain("shared-global-memory");
			expect(second.session.systemPrompt).toContain("shared-global-memory");
			expect(first.session.systemPrompt).toContain("first-project-memory");
			expect(second.session.systemPrompt).not.toContain("first-project-memory");
		} finally {
			first.session.dispose();
			second.session.dispose();
		}
	});

	it("removes and restores memory from the live prompt when toggled", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const paths = getAutoMemoryPaths(agentDir, cwd);
		mkdirSync(dirname(paths.global.indexPath), { recursive: true });
		writeFileSync(paths.global.indexPath, "toggle-memory-marker");
		const settingsManager = SettingsManager.inMemory();
		const { session } = await createAgentSession({
			agentDir,
			cwd,
			settingsManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			expect(session.systemPrompt).toContain("toggle-memory-marker");
			settingsManager.setAutoMemoryEnabled(false);
			session.refreshSystemPrompt();
			expect(session.systemPrompt).not.toContain("<auto_memory>");

			settingsManager.setAutoMemoryEnabled(true);
			session.refreshSystemPrompt();
			expect(session.systemPrompt).toContain("toggle-memory-marker");
		} finally {
			session.dispose();
		}
	});
});
