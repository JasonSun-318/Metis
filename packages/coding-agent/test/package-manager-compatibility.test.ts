import type { ChildProcess, SpawnOptions, SpawnSyncReturns } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, type ProgressEvent, type ResolvedResource } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import * as childProcess from "../src/utils/child-process.ts";

class FakeChildProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	kill = vi.fn(() => true);
}

interface SpawnCall {
	command: string;
	args: string[];
	options: SpawnOptions;
	child: FakeChildProcess;
}

function mockSpawn(respond: (call: SpawnCall) => void): SpawnCall[] {
	const calls: SpawnCall[] = [];
	const implementation = ((command: string, args: string[], options: SpawnOptions) => {
		const child = new FakeChildProcess();
		const call = { command, args, options, child };
		calls.push(call);
		// Queue the response so the manager has installed its listeners first.
		queueMicrotask(() => respond(call));
		return child as unknown as ChildProcess;
	}) as typeof childProcess.spawnProcess;
	vi.spyOn(childProcess, "spawnProcess").mockImplementation(implementation);
	return calls;
}

function mockSyncSuccess(stdout: string): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, stdout, ""],
		stdout,
		stderr: "",
		status: 0,
		signal: null,
	};
}

function mockSyncFailure(message = "legacy probe unavailable"): void {
	vi.spyOn(childProcess, "spawnProcessSync").mockReturnValue({
		error: new Error(message),
		status: null,
		signal: "SIGKILL",
		stdout: "",
		stderr: "",
		pid: 0,
		output: [],
	});
}

function writeFixture(path: string, content = "// fixture"): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function findResource(resources: ResolvedResource[], path: string): ResolvedResource | undefined {
	return resources.find((resource) => resource.path === path);
}

type GitSourceForTest = {
	type: "git";
	repo: string;
	host: string;
	path: string;
	pinned: boolean;
	ref?: string;
};

interface PackageManagerPathInternals {
	parseSource(source: string): GitSourceForTest;
	getGitInstallPath(source: GitSourceForTest, scope: "temporary"): string;
}

describe("package manager compatibility regressions", () => {
	let tempDir: string;
	let agentDir: string;
	let homeDir: string;
	let settingsManager: SettingsManager;
	let manager: DefaultPackageManager;
	let previousHome: string | undefined;
	let previousOffline: string | undefined;

	beforeEach(() => {
		previousHome = process.env.HOME;
		previousOffline = process.env.METIS_OFFLINE;
		delete process.env.METIS_OFFLINE;

		tempDir = join(tmpdir(), `pm-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		homeDir = join(tempDir, "home");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(homeDir, { recursive: true });
		process.env.HOME = homeDir;

		settingsManager = SettingsManager.inMemory();
		manager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousOffline === undefined) delete process.env.METIS_OFFLINE;
		else process.env.METIS_OFFLINE = previousOffline;

		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("C2 install/remove persistence and progress", () => {
		it("persists once after install completes and reads settings changed during the operation", async () => {
			settingsManager.setPackages(["npm:existing"]);
			const save = vi.spyOn(settingsManager, "setPackages");
			const calls = mockSpawn(() => {});
			const snapshots: Array<{ type: ProgressEvent["type"]; packages: unknown }> = [];
			manager.setProgressCallback((event) => {
				snapshots.push({ type: event.type, packages: settingsManager.getGlobalSettings().packages });
			});

			const installing = manager.installAndPersist("npm:added");
			expect(calls).toHaveLength(1);
			expect(save).not.toHaveBeenCalled();
			expect(settingsManager.getGlobalSettings().packages).toEqual(["npm:existing"]);
			settingsManager.setPackages(["npm:existing", "npm:concurrent"]);
			save.mockClear();
			calls[0]!.child.emit("exit", 0);
			await installing;

			expect(snapshots).toEqual([
				{ type: "start", packages: ["npm:existing"] },
				{ type: "complete", packages: ["npm:existing", "npm:concurrent"] },
			]);
			expect(save).toHaveBeenCalledExactlyOnceWith(["npm:existing", "npm:concurrent", "npm:added"]);
		});

		it("C2 keeps settings unchanged and rethrows the original error when installAndPersist fails", async () => {
			settingsManager.setPackages(["npm:existing"]);
			const failure = new Error("install exploded");
			mockSpawn(({ child }) => child.emit("error", failure));
			const events: ProgressEvent[] = [];
			manager.setProgressCallback((event) => events.push(event));

			await expect(manager.installAndPersist("npm:new-pkg")).rejects.toBe(failure);

			expect(settingsManager.getGlobalSettings().packages).toEqual(["npm:existing"]);
			expect(events).toEqual([
				{
					type: "start",
					action: "install",
					source: "npm:new-pkg",
					message: "Installing npm:new-pkg...",
				},
				{ type: "error", action: "install", source: "npm:new-pkg", message: "install exploded" },
			]);
		});

		it("C2 persists a successful local install after completion and preserves replacement filters", async () => {
			const localPath = join(tempDir, "extensions", "local.ts");
			writeFixture(localPath, "export default function() {}");
			settingsManager.setProjectPackages([
				{
					source: localPath,
					autoload: false,
					extensions: ["extensions/keep.ts"],
					skills: ["skills/keep"],
				},
			]);
			const events: ProgressEvent[] = [];
			manager.setProgressCallback((event) => events.push(event));

			await manager.installAndPersist("extensions/local.ts", { local: true });

			const normalizedSource = relative(join(tempDir, ".metis"), localPath);
			expect(settingsManager.getProjectSettings().packages).toEqual([
				{
					source: normalizedSource,
					autoload: false,
					extensions: ["extensions/keep.ts"],
					skills: ["skills/keep"],
				},
			]);
			expect(settingsManager.getGlobalSettings().packages).toBeUndefined();
			expect(events).toEqual([
				{
					type: "start",
					action: "install",
					source: "extensions/local.ts",
					message: "Installing extensions/local.ts...",
				},
				{ type: "complete", action: "install", source: "extensions/local.ts" },
			]);
		});

		it("C2 keeps settings unchanged and rethrows the original error when removeAndPersist fails", async () => {
			mkdirSync(join(agentDir, "npm"), { recursive: true });
			settingsManager.setPackages(["npm:keep", "npm:remove"]);
			const failure = new Error("remove exploded");
			mockSpawn(({ child }) => child.emit("error", failure));
			const events: ProgressEvent[] = [];
			manager.setProgressCallback((event) => events.push(event));

			await expect(manager.removeAndPersist("npm:remove")).rejects.toBe(failure);

			expect(settingsManager.getGlobalSettings().packages).toEqual(["npm:keep", "npm:remove"]);
			expect(events).toEqual([
				{
					type: "start",
					action: "remove",
					source: "npm:remove",
					message: "Removing npm:remove...",
				},
				{ type: "error", action: "remove", source: "npm:remove", message: "remove exploded" },
			]);
		});

		it("C2 removes settings only after a successful remove and emits exact completion progress", async () => {
			mkdirSync(join(agentDir, "npm"), { recursive: true });
			settingsManager.setPackages(["npm:keep", "npm:remove"]);
			mockSpawn(({ child }) => child.emit("exit", 0));
			const events: ProgressEvent[] = [];
			manager.setProgressCallback((event) => events.push(event));

			await expect(manager.removeAndPersist("npm:remove")).resolves.toBe(true);

			expect(settingsManager.getGlobalSettings().packages).toEqual(["npm:keep"]);
			expect(events).toEqual([
				{
					type: "start",
					action: "remove",
					source: "npm:remove",
					message: "Removing npm:remove...",
				},
				{ type: "complete", action: "remove", source: "npm:remove" },
			]);
		});

		it("C2 reads the current progress callback for completion and tolerates clearing it mid-operation", async () => {
			const calls = mockSpawn(() => {});
			const events: Array<{ handler: string; event: ProgressEvent }> = [];
			manager.setProgressCallback((event) => events.push({ handler: "first", event }));

			const installing = manager.install("npm:demo");
			expect(calls).toHaveLength(1);
			manager.setProgressCallback((event) => events.push({ handler: "second", event }));
			calls[0]!.child.emit("exit", 0);
			await installing;

			expect(events).toEqual([
				{
					handler: "first",
					event: {
						type: "start",
						action: "install",
						source: "npm:demo",
						message: "Installing npm:demo...",
					},
				},
				{ handler: "second", event: { type: "complete", action: "install", source: "npm:demo" } },
			]);

			const removing = manager.remove("npm:demo");
			expect(calls).toHaveLength(2);
			manager.setProgressCallback(undefined);
			calls[1]!.child.emit("exit", 0);
			await removing;

			expect(events).toHaveLength(3);
			expect(events[2]).toEqual({
				handler: "second",
				event: {
					type: "start",
					action: "remove",
					source: "npm:demo",
					message: "Removing npm:demo...",
				},
			});
		});
	});

	describe("C3 npm/pnpm probe caching", () => {
		it("C3 does not probe for a managed path and caches pnpm probes per instance", () => {
			settingsManager.setNpmCommand(["pnpm"]);
			const managedPath = join(agentDir, "npm", "node_modules", "managed");
			mkdirSync(managedPath, { recursive: true });
			const firstPath = join(tempDir, "pnpm-first");
			const secondPath = join(tempDir, "pnpm-second");
			mkdirSync(firstPath);
			mkdirSync(secondPath);
			const probe = vi
				.spyOn(childProcess, "spawnProcessSync")
				.mockReturnValue(
					mockSyncSuccess(
						JSON.stringify([{ dependencies: { first: { path: firstPath }, second: { path: secondPath } } }]),
					),
				);

			expect(manager.getInstalledPath("npm:managed", "user")).toBe(managedPath);
			expect(probe).not.toHaveBeenCalled();

			expect(manager.getInstalledPath("npm:first", "user")).toBe(firstPath);
			expect(manager.getInstalledPath("npm:second", "user")).toBe(secondPath);
			expect(probe).toHaveBeenCalledTimes(1);
			expect(probe).toHaveBeenCalledWith(
				"pnpm",
				["list", "-g", "--depth", "0", "--json"],
				expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL" }),
			);

			const otherManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
			expect(otherManager.getInstalledPath("npm:first", "user")).toBe(firstPath);
			expect(probe).toHaveBeenCalledTimes(2);
		});

		it("C3 caches pnpm probe failures per instance and isolates separate instances", () => {
			settingsManager.setNpmCommand(["pnpm"]);
			const probe = vi.spyOn(childProcess, "spawnProcessSync").mockReturnValue({
				error: new Error("probe timed out"),
				status: null,
				signal: "SIGKILL",
				stdout: "",
				stderr: "",
				pid: 0,
				output: [],
			});

			expect(manager.getInstalledPath("npm:first", "user")).toBeUndefined();
			expect(manager.getInstalledPath("npm:second", "user")).toBeUndefined();
			expect(probe).toHaveBeenCalledTimes(1);

			const otherManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
			expect(otherManager.getInstalledPath("npm:first", "user")).toBeUndefined();
			expect(probe).toHaveBeenCalledTimes(2);
		});

		it("C3 reprobes after command argv changes and after an async npm command fails", async () => {
			settingsManager.setNpmCommand(["pnpm"]);
			const packagePath = join(tempDir, "pnpm-global", "first");
			mkdirSync(packagePath, { recursive: true });
			const probe = vi
				.spyOn(childProcess, "spawnProcessSync")
				.mockReturnValue(mockSyncSuccess(JSON.stringify([{ dependencies: { first: { path: packagePath } } }])));

			expect(manager.getInstalledPath("npm:first", "user")).toBe(packagePath);
			expect(probe).toHaveBeenCalledTimes(1);

			settingsManager.setNpmCommand(["mise", "exec", "--", "pnpm"]);
			expect(manager.getInstalledPath("npm:first", "user")).toBe(packagePath);
			expect(probe).toHaveBeenCalledTimes(2);
			expect(probe).toHaveBeenLastCalledWith(
				"mise",
				["exec", "--", "pnpm", "list", "-g", "--depth", "0", "--json"],
				expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL" }),
			);

			const failure = new Error("npm install failed");
			mockSpawn(({ child }) => child.emit("error", failure));
			await expect(manager.install("npm:first")).rejects.toBe(failure);

			expect(manager.getInstalledPath("npm:first", "user")).toBe(packagePath);
			const pnpmProbes = probe.mock.calls
				.filter(([, args]) => args.includes("list"))
				.map(([command, args]) => ({ command, args }));
			expect(pnpmProbes).toEqual([
				{ command: "pnpm", args: ["list", "-g", "--depth", "0", "--json"] },
				{ command: "mise", args: ["exec", "--", "pnpm", "list", "-g", "--depth", "0", "--json"] },
				{ command: "mise", args: ["exec", "--", "pnpm", "list", "-g", "--depth", "0", "--json"] },
			]);
		});
	});

	describe("C4 ordered resolution and stable identity", () => {
		it("C4 resolves all four resource types in documented rank order with exact metadata", async () => {
			const projectBase = join(tempDir, ".metis");
			const packageDir = join(tempDir, "package");
			mkdirSync(join(tempDir, ".git"), { recursive: true });

			const projectExplicitA = join(projectBase, "explicit", "a.ts");
			const projectExplicitB = join(projectBase, "explicit", "b.ts");
			const projectAutoExtension = join(projectBase, "extensions", "auto.ts");
			const userExplicitExtension = join(agentDir, "explicit", "user.ts");
			const userAliasExtension = join(agentDir, "explicit", "alias.ts");
			const userAutoExtension = join(agentDir, "extensions", "auto.ts");
			const packageExtension = join(packageDir, "extensions", "package.ts");
			writeFixture(projectExplicitA);
			writeFixture(projectExplicitB);
			writeFixture(projectAutoExtension);
			writeFixture(userExplicitExtension);
			writeFixture(userAutoExtension);
			writeFixture(packageExtension);
			symlinkSync(projectExplicitA, userAliasExtension);

			const projectExplicitSkill = join(projectBase, "explicit", "skill.md");
			const projectAutoSkill = join(projectBase, "skills", "project-skill", "SKILL.md");
			const userExplicitSkill = join(agentDir, "explicit", "skill.md");
			const userAutoSkill = join(agentDir, "skills", "user-skill", "SKILL.md");
			const packageSkill = join(packageDir, "skills", "package-skill", "SKILL.md");
			writeFixture(projectExplicitSkill, "# Project explicit\n");
			writeFixture(projectAutoSkill, "# Project auto\n");
			writeFixture(userExplicitSkill, "# User explicit\n");
			writeFixture(userAutoSkill, "# User auto\n");
			writeFixture(packageSkill, "# Package\n");

			const projectExplicitPrompt = join(projectBase, "explicit", "prompt.md");
			const projectAutoPrompt = join(projectBase, "prompts", "auto.md");
			const userExplicitPrompt = join(agentDir, "explicit", "prompt.md");
			const userAutoPrompt = join(agentDir, "prompts", "auto.md");
			const packagePrompt = join(packageDir, "prompts", "package.md");
			writeFixture(projectExplicitPrompt, "project explicit");
			writeFixture(projectAutoPrompt, "project auto");
			writeFixture(userExplicitPrompt, "user explicit");
			writeFixture(userAutoPrompt, "user auto");
			writeFixture(packagePrompt, "package");

			const projectExplicitTheme = join(projectBase, "explicit", "theme.json");
			const projectAutoTheme = join(projectBase, "themes", "auto.json");
			const userExplicitTheme = join(agentDir, "explicit", "theme.json");
			const userAutoTheme = join(agentDir, "themes", "auto.json");
			const packageTheme = join(packageDir, "themes", "package.json");
			writeFixture(projectExplicitTheme, "{}");
			writeFixture(projectAutoTheme, "{}");
			writeFixture(userExplicitTheme, "{}");
			writeFixture(userAutoTheme, "{}");
			writeFixture(packageTheme, "{}");

			settingsManager.setProjectExtensionPaths(["explicit/a.ts", "explicit/b.ts", "!extensions/auto.ts"]);
			settingsManager.setExtensionPaths(["explicit/user.ts", "explicit/alias.ts", "!extensions/auto.ts"]);
			settingsManager.setProjectSkillPaths(["explicit/skill.md", "!skills/project-skill"]);
			settingsManager.setSkillPaths(["explicit/skill.md", "!skills/user-skill"]);
			settingsManager.setProjectPromptTemplatePaths(["explicit/prompt.md", "!prompts/auto.md"]);
			settingsManager.setPromptTemplatePaths(["explicit/prompt.md", "!prompts/auto.md"]);
			settingsManager.setProjectThemePaths(["explicit/theme.json", "!themes/auto.json"]);
			settingsManager.setThemePaths(["explicit/theme.json", "!themes/auto.json"]);
			settingsManager.setPackages([packageDir]);

			const projectLocal = { source: "local", scope: "project", origin: "top-level" } as const;
			const userLocal = { source: "local", scope: "user", origin: "top-level" } as const;
			const projectAuto = {
				source: "auto",
				scope: "project",
				origin: "top-level",
				baseDir: projectBase,
			} as const;
			const userAuto = { source: "auto", scope: "user", origin: "top-level", baseDir: agentDir } as const;
			const packageMetadata = {
				source: packageDir,
				scope: "user",
				origin: "package",
				baseDir: packageDir,
			} as const;

			const result = await manager.resolve();

			expect(result.extensions).toEqual([
				{ path: projectExplicitA, enabled: true, metadata: projectLocal },
				{ path: projectExplicitB, enabled: true, metadata: projectLocal },
				{ path: projectAutoExtension, enabled: false, metadata: projectAuto },
				{ path: userExplicitExtension, enabled: true, metadata: userLocal },
				{ path: userAutoExtension, enabled: false, metadata: userAuto },
				{ path: packageExtension, enabled: true, metadata: packageMetadata },
			]);
			expect(result.skills).toEqual([
				{ path: projectExplicitSkill, enabled: true, metadata: projectLocal },
				{ path: projectAutoSkill, enabled: false, metadata: projectAuto },
				{ path: userExplicitSkill, enabled: true, metadata: userLocal },
				{ path: userAutoSkill, enabled: false, metadata: userAuto },
				{ path: packageSkill, enabled: true, metadata: packageMetadata },
			]);
			expect(result.prompts).toEqual([
				{ path: projectExplicitPrompt, enabled: true, metadata: projectLocal },
				{ path: projectAutoPrompt, enabled: false, metadata: projectAuto },
				{ path: userExplicitPrompt, enabled: true, metadata: userLocal },
				{ path: userAutoPrompt, enabled: false, metadata: userAuto },
				{ path: packagePrompt, enabled: true, metadata: packageMetadata },
			]);
			expect(result.themes).toEqual([
				{ path: projectExplicitTheme, enabled: true, metadata: projectLocal },
				{ path: projectAutoTheme, enabled: false, metadata: projectAuto },
				{ path: userExplicitTheme, enabled: true, metadata: userLocal },
				{ path: userAutoTheme, enabled: false, metadata: userAuto },
				{ path: packageTheme, enabled: true, metadata: packageMetadata },
			]);

			const lateAutoExtension = join(projectBase, "extensions", "late.ts");
			const lateExplicitExtension = join(projectBase, "explicit", "late.ts");
			writeFixture(lateAutoExtension);
			writeFixture(lateExplicitExtension);
			settingsManager.setProjectExtensionPaths(["explicit/a.ts", "explicit/b.ts", "explicit/late.ts"]);

			const second = await manager.resolve();

			expect(findResource(second.extensions, projectAutoExtension)?.enabled).toBe(true);
			expect(findResource(second.extensions, lateAutoExtension)?.metadata).toEqual(projectAuto);
			expect(findResource(second.extensions, lateExplicitExtension)?.metadata).toEqual(projectLocal);
		});

		it("C4 keeps a project autoload=false delta over the user package with ordered metadata", async () => {
			const packageDir = join(agentDir, "npm", "node_modules", "delta-tool");
			const foo = join(packageDir, "extensions", "foo.ts");
			const bar = join(packageDir, "extensions", "bar.ts");
			writeFixture(join(packageDir, "package.json"), JSON.stringify({ name: "delta-tool", version: "1.0.0" }));
			writeFixture(foo);
			writeFixture(bar);
			settingsManager.setPackages(["npm:delta-tool"]);
			settingsManager.setProjectPackages([
				{ source: "npm:delta-tool", autoload: false, extensions: ["-extensions/foo.ts"] },
			]);

			const result = await manager.resolve();

			expect(result.extensions).toEqual([
				{
					path: foo,
					enabled: false,
					metadata: {
						source: "npm:delta-tool",
						scope: "project",
						origin: "package",
						baseDir: packageDir,
					},
				},
				{
					path: bar,
					enabled: true,
					metadata: {
						source: "npm:delta-tool",
						scope: "user",
						origin: "package",
						baseDir: packageDir,
					},
				},
			]);
		});
	});

	describe("C5 filtering semantics", () => {
		it("C5 distinguishes empty manifest, empty package filter and empty autoload delta", async () => {
			const packageDir = join(tempDir, "manifest-empty");
			const visible = join(packageDir, "extensions", "visible.ts");
			writeFixture(join(packageDir, "package.json"), JSON.stringify({ metis: { extensions: [] } }));
			writeFixture(visible);

			settingsManager.setPackages([packageDir]);
			expect((await manager.resolve()).extensions).toEqual([]);

			settingsManager.setPackages([{ source: packageDir, extensions: [] }]);
			expect((await manager.resolve()).extensions).toEqual([
				{
					path: visible,
					enabled: false,
					metadata: { source: packageDir, scope: "user", origin: "package", baseDir: packageDir },
				},
			]);

			const managedDir = join(agentDir, "npm", "node_modules", "delta-tool");
			const foo = join(managedDir, "extensions", "foo.ts");
			const bar = join(managedDir, "extensions", "bar.ts");
			writeFixture(join(managedDir, "package.json"), JSON.stringify({ name: "delta-tool", version: "1.0.0" }));
			writeFixture(foo);
			writeFixture(bar);
			settingsManager.setPackages(["npm:delta-tool"]);
			settingsManager.setProjectPackages([{ source: "npm:delta-tool", autoload: false, extensions: [] }]);

			const delta = await manager.resolve();
			expect(delta.extensions).toHaveLength(2);
			expect(delta.extensions).toEqual(
				expect.arrayContaining([
					{
						path: foo,
						enabled: true,
						metadata: {
							source: "npm:delta-tool",
							scope: "user",
							origin: "package",
							baseDir: managedDir,
						},
					},
					{
						path: bar,
						enabled: true,
						metadata: {
							source: "npm:delta-tool",
							scope: "user",
							origin: "package",
							baseDir: managedDir,
						},
					},
				]),
			);
		});

		it("C5 shows ordinary filtering versus ordered autoload-delta overrides", async () => {
			const packageDir = join(tempDir, "ordered-filter-package");
			const foo = join(packageDir, "extensions", "foo.ts");
			const bar = join(packageDir, "extensions", "bar.ts");
			writeFixture(foo);
			writeFixture(bar);
			const orderedPatterns = ["-extensions/foo.ts", "+extensions/foo.ts"];

			settingsManager.setPackages([{ source: packageDir, extensions: orderedPatterns }]);
			const ordinary = await manager.resolve();
			expect(findResource(ordinary.extensions, foo)?.enabled).toBe(false);
			expect(findResource(ordinary.extensions, bar)?.enabled).toBe(true);

			settingsManager.setPackages([packageDir]);
			settingsManager.setProjectPackages([{ source: packageDir, autoload: false, extensions: orderedPatterns }]);
			const delta = await manager.resolve();
			expect(findResource(delta.extensions, foo)?.enabled).toBe(true);
			expect(findResource(delta.extensions, bar)?.enabled).toBe(true);
		});

		it("C5 force-includes and force-excludes SKILL.md through its exact parent path", async () => {
			const packageDir = join(tempDir, "skill-pattern-package");
			const demo = join(packageDir, "skills", "demo", "SKILL.md");
			const other = join(packageDir, "skills", "other", "SKILL.md");
			writeFixture(demo, "# Demo\n");
			writeFixture(other, "# Other\n");

			settingsManager.setPackages([{ source: packageDir, skills: ["!**", "+skills/demo"] }]);
			const included = await manager.resolve();
			expect(findResource(included.skills, demo)?.enabled).toBe(true);
			expect(findResource(included.skills, other)?.enabled).toBe(false);

			settingsManager.setPackages([{ source: packageDir, skills: ["!**", "+skills/demo", "-skills/demo"] }]);
			const excluded = await manager.resolve();
			expect(findResource(excluded.skills, demo)?.enabled).toBe(false);
			expect(findResource(excluded.skills, other)?.enabled).toBe(false);
		});
	});

	describe("C6 missing sources, automatic install and temporary refresh", () => {
		it("C6 auto-installs a missing package without persisting settings or starting progress", async () => {
			mockSyncFailure();
			const packageName = "auto-pkg";
			const packageDir = join(agentDir, "npm", "node_modules", packageName);
			const extension = join(packageDir, "extensions", "index.ts");
			const calls = mockSpawn(({ command, args, child }) => {
				expect(command).toBe("npm");
				expect(args[0]).toBe("install");
				writeFixture(join(packageDir, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0" }));
				writeFixture(extension, "export default function() {}");
				child.emit("exit", 0);
			});
			settingsManager.setPackages([`npm:${packageName}`]);
			const events: ProgressEvent[] = [];
			manager.setProgressCallback((event) => events.push(event));

			const result = await manager.resolve();

			expect(findResource(result.extensions, extension)?.enabled).toBe(true);
			expect(settingsManager.getGlobalSettings().packages).toEqual([`npm:${packageName}`]);
			expect(settingsManager.getProjectSettings().packages).toBeUndefined();
			expect(events).toEqual([]);
			expect(calls).toHaveLength(1);
		});

		it("C6 honors onMissing install/skip/error and never calls the callback offline", async () => {
			mockSyncFailure();
			const installName = "callback-install";
			const installDir = join(agentDir, "npm", "node_modules", installName);
			const installedExtension = join(installDir, "extensions", "index.ts");
			const calls = mockSpawn(({ command, args, child }) => {
				expect(command).toBe("npm");
				expect(args[0]).toBe("install");
				writeFixture(join(installDir, "package.json"), JSON.stringify({ name: installName, version: "1.0.0" }));
				writeFixture(installedExtension, "export default function() {}");
				child.emit("exit", 0);
			});

			settingsManager.setPackages(["npm:skip-me"]);
			const skip = vi.fn(async () => "skip" as const);
			expect((await manager.resolve(skip)).extensions).toEqual([]);
			expect(skip).toHaveBeenCalledOnce();
			expect(calls).toHaveLength(0);

			settingsManager.setPackages(["npm:error-me"]);
			const fail = vi.fn(async () => "error" as const);
			await expect(manager.resolve(fail)).rejects.toThrow("Missing source: npm:error-me");
			expect(fail).toHaveBeenCalledOnce();
			expect(calls).toHaveLength(0);

			process.env.METIS_OFFLINE = "1";
			settingsManager.setPackages(["npm:offline-me"]);
			const offline = vi.fn(async () => "install" as const);
			expect((await manager.resolve(offline)).extensions).toEqual([]);
			expect(offline).not.toHaveBeenCalled();
			expect(calls).toHaveLength(0);

			delete process.env.METIS_OFFLINE;
			settingsManager.setPackages([`npm:${installName}`]);
			const install = vi.fn(async () => "install" as const);
			const result = await manager.resolve(install);
			expect(install).toHaveBeenCalledWith(`npm:${installName}`);
			expect(findResource(result.extensions, installedExtension)?.enabled).toBe(true);
			expect(calls).toHaveLength(1);
		});

		it("C6 keeps cached temporary git resources when an unpinned refresh fails", async () => {
			const source = "git:github.com/local/repo";
			const paths = manager as unknown as PackageManagerPathInternals;
			const cachedDir = paths.getGitInstallPath(paths.parseSource(source), "temporary");
			const cachedExtension = join(cachedDir, "metis-extensions", "session-breakdown.ts");
			writeFixture(
				join(cachedDir, "package.json"),
				JSON.stringify({ metis: { extensions: ["./metis-extensions"] } }),
			);
			writeFixture(cachedExtension, "// cached");
			const fetchArgs = ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
			mockSpawn(({ command, args, child }) => {
				expect(command).toBe("git");
				if (args[0] === "rev-parse") {
					child.stdout.write(args.includes("--abbrev-ref") ? "origin/main\n" : "remote-head\n");
					child.stdout.end();
					child.emit("close", 0, null);
					return;
				}
				if (args[0] === "fetch") {
					expect(args).toEqual(fetchArgs);
					child.emit("exit", 1);
					return;
				}
				throw new Error(`unexpected git command: ${args.join(" ")}`);
			});
			const events: ProgressEvent[] = [];
			manager.setProgressCallback((event) => events.push(event));

			const result = await manager.resolveExtensionSources([source], { temporary: true });

			expect(findResource(result.extensions, cachedExtension)?.enabled).toBe(true);
			expect(events).toEqual([
				{ type: "start", action: "pull", source, message: `Refreshing ${source}...` },
				{
					type: "error",
					action: "pull",
					source,
					message: `git ${fetchArgs.join(" ")} failed with code 1`,
				},
			]);
		});
	});
});
