import { describe, expect, test } from "vitest";
import { AUTO_MEMORY_MAX_BYTES, AUTO_MEMORY_MAX_LINES, type AutoMemorySnapshot } from "../src/core/auto-memory.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt, buildSystemPromptWithParts } from "../src/core/system-prompt.ts";

const autoMemory: AutoMemorySnapshot = {
	global: {
		directory: "/agent/memory",
		indexPath: "/agent/memory/MEMORY.md",
		content: "- [preferences.md](preferences.md) — global fact",
		exists: true,
		truncated: false,
	},
	project: {
		directory: "/agent/memory/projects/--workspace--",
		indexPath: "/agent/memory/projects/--workspace--/project.md",
		content: "- [architecture.md](architecture.md) — project fact",
		exists: true,
		truncated: false,
	},
};

describe("system prompt memory engines", () => {
	describe("index engine", () => {
		test("injects catalog indexes and forbids writing the memory directory", () => {
			const prompt = buildSystemPrompt({
				cwd: "/workspace",
				autoMemory,
				autoMemoryEngine: "index",
			});

			expect(prompt).toContain("<global_memory_index>");
			expect(prompt).toContain("<project_memory_index>");
			expect(prompt).toContain("global fact");
			expect(prompt).toContain("project fact");
			expect(prompt).toMatch(/do not write\/edit the memory directory/i);
			expect(prompt).toMatch(/maintained in the background/i);
			expect(prompt).not.toContain("Proactively maintain memory during normal work");
			expect(prompt).not.toMatch(/use write or edit to (add|update|maintain)/i);
		});

		test("defaults to index behavior when engine is omitted", () => {
			const prompt = buildSystemPrompt({ cwd: "/workspace", autoMemory });
			expect(prompt).toContain("<global_memory_index>");
			expect(prompt).not.toContain("Proactively maintain memory during normal work");
		});

		test("tells the model to grep a truncated index instead of reading it whole", () => {
			const prompt = buildSystemPrompt({
				cwd: "/workspace",
				autoMemoryEngine: "index",
				autoMemory: {
					global: { ...autoMemory.global, truncated: true },
					project: autoMemory.project,
				},
			});
			expect(prompt).toContain(autoMemory.global.indexPath);
			expect(prompt).toMatch(/grep this file; do not read the entire file/i);
			expect(prompt).toContain(
				`Index truncated: only the first ${AUTO_MEMORY_MAX_LINES} lines or ${AUTO_MEMORY_MAX_BYTES / 1024}KB`,
			);
		});
	});

	describe("extract engine", () => {
		test("injects retrieved fact bullets instead of dumping indexes", () => {
			const prompt = buildSystemPrompt({
				cwd: "/workspace",
				autoMemory,
				autoMemoryEngine: "extract",
				autoMemoryRetrieved: [
					{ scope: "global", text: "User prefers Chinese replies" },
					{ scope: "project", text: "Project uses SQLite for memory" },
				],
			});

			expect(prompt).toContain("User prefers Chinese replies");
			expect(prompt).toContain("Project uses SQLite for memory");
			expect(prompt).toMatch(/- \[global\]/);
			expect(prompt).toMatch(/- \[project\]/);
			expect(prompt).not.toContain("<global_memory_index>");
			expect(prompt).not.toContain("<project_memory_index>");
			expect(prompt).not.toContain("global fact");
			expect(prompt).not.toContain("project fact");
			expect(prompt).toMatch(/do not read the memory directory unless the user asks what is stored/i);
			expect(prompt).not.toContain("Proactively maintain memory during normal work");
		});

		test("shows an English zero-hit message when nothing was retrieved", () => {
			const prompt = buildSystemPrompt({
				cwd: "/workspace",
				autoMemory,
				autoMemoryEngine: "extract",
				autoMemoryRetrieved: [],
			});
			expect(prompt).toContain("No relevant long-term memory for this turn.");
			expect(prompt).not.toContain("<global_memory_index>");
			expect(prompt).not.toContain("global fact");
		});

		test("does not dump indexes even when a snapshot is loaded", () => {
			const prompt = buildSystemPrompt({
				cwd: "/workspace",
				autoMemory,
				autoMemoryEngine: "extract",
				autoMemoryRetrieved: [{ scope: "global", text: "only this fact" }],
			});
			expect(prompt).toContain("only this fact");
			expect(prompt).not.toContain(autoMemory.global.content);
			expect(prompt).not.toContain(autoMemory.project.content);
		});

		test("places memory after skills and project context so they win budgeting", () => {
			const skillPath = "/skills/demo/SKILL.md";
			const skill: Skill = {
				name: "demo-skill",
				description: "Demo",
				filePath: skillPath,
				baseDir: "/skills/demo",
				disableModelInvocation: false,
				sourceInfo: createSyntheticSourceInfo(skillPath, {
					source: "user",
					scope: "user",
					origin: "top-level",
					baseDir: "/skills/demo",
				}),
			};
			const built = buildSystemPromptWithParts({
				cwd: "/workspace",
				contextFiles: [{ path: "AGENTS.md", content: "CONTEXT_RULE" }],
				skills: [skill],
				autoMemory,
				autoMemoryEngine: "extract",
				autoMemoryRetrieved: [{ scope: "project", text: "MEMORY_FACT" }],
			});
			const text = built.text;
			const contextAt = text.indexOf("CONTEXT_RULE");
			const skillsAt = text.indexOf("demo-skill");
			const memoryAt = text.indexOf("MEMORY_FACT");
			expect(contextAt).toBeGreaterThan(-1);
			expect(skillsAt).toBeGreaterThan(-1);
			expect(memoryAt).toBeGreaterThan(-1);
			expect(memoryAt).toBeGreaterThan(contextAt);
			expect(memoryAt).toBeGreaterThan(skillsAt);
			expect(text).toMatch(/skills|context.*win over memory|prefer skills and project context/i);
		});
	});
});
