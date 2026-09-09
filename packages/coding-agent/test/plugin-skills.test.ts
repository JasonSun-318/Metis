import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type NormalizedComponent,
	type NormalizedPluginPackage,
	withPluginRegistryLock,
} from "../src/core/plugins/registry.ts";
import type { PluginRecord, PluginRegistry } from "../src/core/plugins/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { formatSkillsForPrompt } from "../src/core/skills.ts";

describe("plugin skills integration", () => {
	let agentDir: string;
	let workspaceDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "metis-plugin-skills-agent-"));
		workspaceDir = mkdtempSync(join(tmpdir(), "metis-plugin-skills-ws-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	function installPluginFixture(
		agentDir: string,
		options: {
			pluginId: string;
			name: string;
			displayName: string;
			commit: string;
			skills: Array<{
				name: string;
				originalName: string;
				subpath: string;
				content: string;
				disableModelInvocation?: boolean;
			}>;
		},
	): void {
		const pkgDir = join(agentDir, "plugins", "packages", options.pluginId, options.commit);
		mkdirSync(pkgDir, { recursive: true });

		const components: NormalizedComponent[] = [];

		for (const skill of options.skills) {
			const skillFilePath = join(pkgDir, skill.subpath);
			mkdirSync(join(pkgDir, skill.subpath, ".."), { recursive: true });
			writeFileSync(skillFilePath, skill.content, "utf8");

			components.push({
				kind: "skill",
				componentId: `skill-${skill.originalName}`,
				name: skill.name,
				originalName: skill.originalName,
				relativeEntryPath: skill.subpath,
				relativeBaseDir: join(skill.subpath, ".."),
				disableModelInvocation: skill.disableModelInvocation,
			});
		}

		const normalized: NormalizedPluginPackage = {
			pluginId: options.pluginId,
			commit: options.commit,
			format: "claude",
			name: options.name,
			displayName: options.displayName,
			description: options.name,
			components,
			issues: [],
		};

		writeFileSync(join(pkgDir, "normalized.json"), JSON.stringify(normalized, null, 2), "utf8");

		const record: PluginRecord = {
			id: options.pluginId,
			name: options.name,
			displayName: options.displayName,
			format: "claude",
			repository: `https://github.com/example/${options.name}`,
			subdir: "",
			commit: options.commit,
			sourceId: "official-market",
			enabled: true,
			installedAt: new Date().toISOString(),
			issues: [],
		};

		withPluginRegistryLock(agentDir, (current) => {
			const nextInstalled = [...current.installed.filter((p) => p.id !== options.pluginId), record];
			const next: PluginRegistry = {
				...current,
				revision: current.revision + 1,
				installed: nextInstalled,
			};
			return { next, result: undefined };
		});
	}

	it("loads user skill and two plugin skills with the same original name simultaneously without collision", async () => {
		// 1. Create a user skill named 'review'
		const userSkillsDir = join(agentDir, "skills", "review");
		mkdirSync(userSkillsDir, { recursive: true });
		writeFileSync(
			join(userSkillsDir, "SKILL.md"),
			"---\nname: review\ndescription: User code review skill\n---\n# User Review",
			"utf8",
		);

		// 2. Install Plugin 1 with 'review' skill
		const plugin1Id = "1111111111111111222222222222222233333333333333334444444444444444";
		const plugin1CallingName = "p-1111111111111111-review";
		installPluginFixture(agentDir, {
			pluginId: plugin1Id,
			name: "plugin-alpha",
			displayName: "Plugin Alpha",
			commit: "c111111111111111111111111111111111111111",
			skills: [
				{
					name: plugin1CallingName,
					originalName: "review",
					subpath: "skills/review/SKILL.md",
					content: "---\nname: review\ndescription: Alpha plugin review skill\n---\n# Alpha Review",
				},
			],
		});

		// 3. Install Plugin 2 with 'review' skill
		const plugin2Id = "5555555555555555666666666666666677777777777777778888888888888888";
		const plugin2CallingName = "p-5555555555555555-review";
		installPluginFixture(agentDir, {
			pluginId: plugin2Id,
			name: "plugin-beta",
			displayName: "Plugin Beta",
			commit: "c22222222222222222222222222222222222222",
			skills: [
				{
					name: plugin2CallingName,
					originalName: "review",
					subpath: "skills/review/SKILL.md",
					content: "---\nname: review\ndescription: Beta plugin review skill\n---\n# Beta Review",
				},
			],
		});

		const loader = new DefaultResourceLoader({
			cwd: workspaceDir,
			agentDir,
		});

		await loader.reload();

		const loaded = loader.getSkills().skills;
		const pluginSkills = loaded.filter((s) => s.pluginOwner);

		// All skills must have unique calling names
		expect(new Set(loaded.map((s) => s.name)).size).toBe(loaded.length);
		expect(pluginSkills).toHaveLength(2);

		// Check user skill
		const userSkill = loaded.find((s) => s.name === "review")!;
		expect(userSkill).toBeDefined();
		expect(userSkill.pluginOwner).toBeUndefined();
		expect(userSkill.description).toBe("User code review skill");

		// Check plugin 1 skill
		const p1Skill = loaded.find((s) => s.name === plugin1CallingName)!;
		expect(p1Skill).toBeDefined();
		expect(p1Skill.originalName).toBe("review");
		expect(p1Skill.pluginOwner?.displayName).toBe("Plugin Alpha");
		expect(p1Skill.filePath).toContain("/plugins/packages/");
		expect(p1Skill.filePath).toContain("c111111111111111111111111111111111111111");

		// Check plugin 2 skill
		const p2Skill = loaded.find((s) => s.name === plugin2CallingName)!;
		expect(p2Skill).toBeDefined();
		expect(p2Skill.originalName).toBe("review");
		expect(p2Skill.pluginOwner?.displayName).toBe("Plugin Beta");
		expect(p2Skill.filePath).toContain("c22222222222222222222222222222222222222");
	});

	it("removes disabled plugin skills on reload and reloadSkills, and restores them when re-enabled", async () => {
		const pluginId = "aaaaaaaabbbbbbbbccccccccdddddddd11111111222222223333333344444444";
		const callingName = "p-aaaaaaaabbbbbbbb-helper";
		installPluginFixture(agentDir, {
			pluginId,
			name: "toggle-plugin",
			displayName: "Toggle Plugin",
			commit: "c33333333333333333333333333333333333333",
			skills: [
				{
					name: callingName,
					originalName: "helper",
					subpath: "skills/helper/SKILL.md",
					content: "---\nname: helper\ndescription: Helper skill\n---\n# Helper",
				},
			],
		});

		const loader = new DefaultResourceLoader({
			cwd: workspaceDir,
			agentDir,
		});

		await loader.reload();
		expect(loader.getSkills().skills.some((s) => s.name === callingName)).toBe(true);

		// Disable plugin in registry
		withPluginRegistryLock(agentDir, (current) => {
			const nextInstalled = current.installed.map((p) => (p.id === pluginId ? { ...p, enabled: false } : p));
			return { next: { ...current, revision: current.revision + 1, installed: nextInstalled }, result: undefined };
		});

		// reloadSkills() should reflect the disabled state immediately
		await loader.reloadSkills();
		expect(loader.getSkills().skills.some((s) => s.name === callingName)).toBe(false);

		// reload() should also reflect disabled state
		await loader.reload();
		expect(loader.getSkills().skills.some((s) => s.name === callingName)).toBe(false);

		// Re-enable plugin
		withPluginRegistryLock(agentDir, (current) => {
			const nextInstalled = current.installed.map((p) => (p.id === pluginId ? { ...p, enabled: true } : p));
			return { next: { ...current, revision: current.revision + 1, installed: nextInstalled }, result: undefined };
		});

		await loader.reloadSkills();
		const restored = loader.getSkills().skills.filter((s) => s.name === callingName);
		expect(restored).toHaveLength(1);
	});

	it("preserves baseDir with spaces and non-ASCII characters and preserves disableModelInvocation", async () => {
		const pluginId = "9999999988888888777777776666666655555555444444443333333322222222";
		const callingName = "p-9999999988888888-chinese-dir";

		installPluginFixture(agentDir, {
			pluginId,
			name: "unicode-plugin",
			displayName: "Unicode Plugin",
			commit: "c44444444444444444444444444444444444444",
			skills: [
				{
					name: callingName,
					originalName: "chinese-dir",
					subpath: "插件 目录/技能 测试/SKILL.md",
					content:
						"---\nname: chinese-dir\ndescription: Skill in unicode path\ndisable-model-invocation: true\n---\n# Unicode Skill",
					disableModelInvocation: true,
				},
			],
		});

		const loader = new DefaultResourceLoader({
			cwd: workspaceDir,
			agentDir,
		});

		await loader.reload();

		const skills = loader.getSkills().skills;
		const skill = skills.find((s) => s.name === callingName);
		expect(skill).toBeDefined();
		expect(skill?.disableModelInvocation).toBe(true);
		expect(skill?.baseDir).toContain("插件 目录/技能 测试");

		// formatSkillsForPrompt should exclude skills with disableModelInvocation: true
		const prompt = formatSkillsForPrompt(skills);
		expect(prompt).not.toContain(callingName);
		expect(prompt).not.toContain("Skill in unicode path");
	});
});
