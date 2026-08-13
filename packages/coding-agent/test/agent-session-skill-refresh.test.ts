import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getModel } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type AfterToolCallContext = Parameters<NonNullable<AgentSession["agent"]["afterToolCall"]>>[0];

function toolContext(name: string, path: string, isError = false): AfterToolCallContext {
	return {
		assistantMessage: {} as AfterToolCallContext["assistantMessage"],
		toolCall: { type: "toolCall", id: `${name}-1`, name, arguments: { path } },
		args: { path },
		result: { content: [{ type: "text", text: isError ? "failed" : "written" }], details: {} },
		isError,
		context: {} as AfterToolCallContext["context"],
	};
}

describe("AgentSession Skill refresh", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createSession(
		projectTrusted = true,
	): Promise<{ session: AgentSession; cwd: string; agentDir: string }> {
		const root = mkdtempSync(join(tmpdir(), "metis-skill-refresh-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		const created = await createAgentSession({
			agentDir,
			cwd,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }),
		});
		sessions.push(created.session);
		return { session: created.session, cwd, agentDir };
	}

	it("reloads a successfully written project SKILL.md and updates the current prompt", async () => {
		const { session, cwd } = await createSession();
		const skillPath = join(cwd, ".metis", "skills", "fresh-skill", "SKILL.md");
		mkdirSync(dirname(skillPath), { recursive: true });
		writeFileSync(
			skillPath,
			"---\nname: fresh-skill\ndescription: Use when a fresh Skill is requested.\n---\n\n# Fresh Skill\n",
		);
		const reload = vi.spyOn(session.resourceLoader, "reload");
		const extendResources = vi.spyOn(session.resourceLoader, "extendResources");

		const result = await session.agent.afterToolCall?.(toolContext("write", skillPath));

		expect(result?.isError).toBe(false);
		expect(result?.content?.at(-1)).toEqual(
			expect.objectContaining({ text: expect.stringContaining('Loaded project Skill "fresh-skill"') }),
		);
		expect(session.systemPrompt).toContain("fresh-skill");
		expect(extendResources).toHaveBeenCalledOnce();
		expect(reload).not.toHaveBeenCalled();
	});

	it("reports invalid Skill content without converting the successful edit to an error", async () => {
		const { session, agentDir } = await createSession();
		const skillPath = join(agentDir, "skills", "broken-skill", "SKILL.md");
		mkdirSync(dirname(skillPath), { recursive: true });
		writeFileSync(skillPath, "---\nname: broken-skill\n---\n\nMissing description.\n");

		const result = await session.agent.afterToolCall?.(toolContext("edit", skillPath));

		expect(result?.isError).toBe(false);
		expect(result?.content?.at(-1)).toEqual(
			expect.objectContaining({ text: expect.stringContaining("was not loaded") }),
		);
		expect(result?.content?.at(-1)).toEqual(
			expect.objectContaining({ text: expect.stringContaining("description") }),
		);
		expect(session.systemPrompt).not.toContain("broken-skill");
	});

	it("loads manual-only user Skills without exposing them for automatic invocation", async () => {
		const { session, agentDir } = await createSession();
		const skillPath = join(agentDir, "skills", "manual-skill", "SKILL.md");
		mkdirSync(dirname(skillPath), { recursive: true });
		writeFileSync(
			skillPath,
			"---\nname: manual-skill\ndescription: Run only when explicitly selected.\ndisable-model-invocation: true\n---\n",
		);

		const result = await session.agent.afterToolCall?.(toolContext("write", skillPath));

		expect(result?.content?.at(-1)).toEqual(
			expect.objectContaining({ text: expect.stringContaining('Loaded user Skill "manual-skill" (manual only)') }),
		);
		expect(session.resourceLoader.getSkills().skills.some((skill) => skill.name === "manual-skill")).toBe(true);
		expect(session.systemPrompt).not.toContain("manual-skill");
	});

	it("does not load project Skills when the project is untrusted", async () => {
		const { session, cwd } = await createSession(false);
		const skillPath = join(cwd, ".metis", "skills", "untrusted-skill", "SKILL.md");
		mkdirSync(dirname(skillPath), { recursive: true });
		writeFileSync(skillPath, "---\nname: untrusted-skill\ndescription: Must remain unloaded\n---\n");
		const extendResources = vi.spyOn(session.resourceLoader, "extendResources");

		const result = await session.agent.afterToolCall?.(toolContext("write", skillPath));

		expect(result?.content?.at(-1)).toEqual(
			expect.objectContaining({ text: expect.stringContaining("not loaded because the project is not trusted") }),
		);
		expect(extendResources).not.toHaveBeenCalled();
		expect(session.systemPrompt).not.toContain("untrusted-skill");
	});

	it("restores normal precedence when a new project Skill overrides a bundled Skill", async () => {
		const { session, cwd } = await createSession();
		const skillPath = join(cwd, ".metis", "skills", "pdf", "SKILL.md");
		mkdirSync(dirname(skillPath), { recursive: true });
		writeFileSync(skillPath, "---\nname: pdf\ndescription: Project PDF workflow\n---\n\n# Project PDF\n");

		const result = await session.agent.afterToolCall?.(toolContext("write", skillPath));

		expect(result?.content?.at(-1)).toEqual(
			expect.objectContaining({ text: expect.stringContaining('Loaded project Skill "pdf"') }),
		);
		expect(session.resourceLoader.getSkills().skills.find((skill) => skill.name === "pdf")?.filePath).toBe(
			realpathSync(skillPath),
		);
	});

	it("leaves failed, unrelated, and supporting-file writes unchanged", async () => {
		const { session, cwd } = await createSession();
		const reload = vi.spyOn(session.resourceLoader, "reload");
		const hook = session.agent.afterToolCall!;

		expect(await hook(toolContext("write", join(cwd, "notes.md")))).toBeUndefined();
		expect(
			await hook(toolContext("write", join(cwd, ".metis", "skills", "sample", "scripts", "run.ts"))),
		).toBeUndefined();
		expect(
			await hook(toolContext("write", join(cwd, ".metis", "skills", "sample", "SKILL.md"), true)),
		).toBeUndefined();
		expect(reload).not.toHaveBeenCalled();
	});

	it("coalesces simultaneous refresh requests", async () => {
		const { session } = await createSession();
		const reloadSkills = vi.spyOn(
			session.resourceLoader as typeof session.resourceLoader & { reloadSkills(): Promise<void> },
			"reloadSkills",
		);

		await Promise.all([session.refreshSkills(), session.refreshSkills()]);

		expect(reloadSkills).toHaveBeenCalledOnce();
	});
});
