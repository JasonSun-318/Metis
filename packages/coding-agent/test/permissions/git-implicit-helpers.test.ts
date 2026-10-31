import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gitImplicitExecutionReasons } from "../../src/core/permissions/git-implicit-config.ts";
import { analyzeShellCommand } from "../../src/core/permissions/shell-analysis.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";

beforeAll(async () => {
	await initializeShellAnalysis();
});

let isolatedHome: string;
beforeEach(() => {
	isolatedHome = mkdtempSync(join(tmpdir(), "metis-git-config-home-"));
	vi.stubEnv("HOME", isolatedHome);
	vi.stubEnv("GIT_CONFIG_GLOBAL", join(isolatedHome, "global.gitconfig"));
	vi.stubEnv("GIT_CONFIG_SYSTEM", join(isolatedHome, "system.gitconfig"));
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(isolatedHome, { recursive: true, force: true });
});

interface RepoFixture {
	readonly root: string;
	readonly repo: string;
	readonly markerLog: string;
}

const fixtures: RepoFixture[] = [];

function createRepo(config: (marker: string) => readonly (readonly string[])[] = () => []): RepoFixture {
	const root = mkdtempSync(join(tmpdir(), "metis-git-implicit-"));
	const markerLog = join(root, "marker.log");
	const marker = join(root, "marker.sh");
	// Harmless marker: it only appends inside its own temp directory.
	writeFileSync(marker, `#!/bin/sh\necho invoked >> '${markerLog}'\n`);
	chmodSync(marker, 0o755);
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	writeFileSync(join(repo, "file.txt"), "content\n");
	execFileSync("git", ["-C", repo, "add", "file.txt"]);
	execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]);
	for (const entry of config(marker)) execFileSync("git", ["-C", repo, "config", ...entry]);
	const fixture = { root, repo, markerLog };
	fixtures.push(fixture);
	return fixture;
}

afterAll(() => {
	for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true });
});

describe("git implicit helper execution", () => {
	it("confirms a configured fsmonitor helper really executes on a read-only status", () => {
		const { repo, markerLog } = createRepo((marker) => [["core.fsmonitor", marker]]);
		// Observe only the status invocation inside this isolated fixture.
		rmSync(markerLog, { force: true });
		execFileSync("git", ["-C", repo, "status", "--short"]);
		expect(existsSync(markerLog)).toBe(true);
	});

	it("reports fsmonitor and textconv configuration for the repo being analyzed", () => {
		const { repo } = createRepo(() => [
			["core.fsmonitor", "/tmp/never-called"],
			["diff.probe.textconv", "/tmp/never-called"],
		]);
		for (const command of ["git status --short", "git diff HEAD", "git show HEAD", "git log -n 1"]) {
			const result = analyzeShellCommand({ command, cwd: repo, workspaceRoots: [repo], shellPath: "/bin/bash" });
			expect(result.disposition, command).toBe("user");
			expect(result.complete, command).toBe(false);
			expect(result.effects).toContain("unknown");
		}
	});

	it("routes the execution risk without letting a clean prefix hide it", () => {
		const { repo } = createRepo(() => [["diff.external", "/tmp/never-called"]]);
		const result = analyzeShellCommand({
			command: "pwd && git status --short",
			cwd: repo,
			workspaceRoots: [repo],
			shellPath: "/bin/bash",
		});
		expect(result.disposition).toBe("user");
		expect(result.complete).toBe(false);
	});

	it("keeps a clean repository readable by the static analysis", () => {
		const { repo } = createRepo();
		const result = analyzeShellCommand({
			command: "git status --short && git diff --stat && git show HEAD --stat && git log -n 1 --oneline",
			cwd: repo,
			workspaceRoots: [repo],
			shellPath: "/bin/bash",
		});
		expect(result).toMatchObject({ complete: true, disposition: "safe", effects: [] });
	});

	it("follows cd into a configured repository", () => {
		const { root, repo } = createRepo(() => [["core.fsmonitor", "/tmp/never-called"]]);
		const result = analyzeShellCommand({
			command: `cd ${JSON.stringify(repo)} && git status --short`,
			cwd: root,
			workspaceRoots: [root, repo],
			shellPath: "/bin/bash",
		});
		expect(result.disposition).toBe("user");
		expect(result.complete).toBe(false);
	});

	it("detects the risk through the standalone config reader", () => {
		const { repo } = createRepo(() => [["interactive.diffFilter", "/tmp/never-called"]]);
		expect(gitImplicitExecutionReasons(repo)).toEqual([expect.stringMatching(/interactive\.difffilter/iu)]);
	});

	it("never treats an include directive as clean even when the base config is clean", () => {
		const { root, repo } = createRepo();
		// The included file is never read by this analyzer; the directive alone
		// must fail closed. The included config carries a harmless marker path.
		const included = join(root, "included.gitconfig");
		writeFileSync(included, "[core]\n\tfsmonitor = /tmp/never-called\n");
		writeFileSync(
			join(repo, ".git", "config"),
			`${readFileSync(join(repo, ".git", "config"), "utf8")}\n[include]\n\tpath = ${included}\n`,
		);
		const reasons = gitImplicitExecutionReasons(repo);
		expect(reasons).toContainEqual(expect.stringMatching(/include/iu));
		expect(
			analyzeShellCommand({
				command: "git status --short",
				cwd: repo,
				workspaceRoots: [repo],
				shellPath: "/bin/bash",
			}),
		).toMatchObject({
			disposition: "user",
			complete: false,
		});
	});

	it("does not count unrecognized configuration syntax as clean", () => {
		const { repo } = createRepo();
		writeFileSync(join(repo, ".git", "config"), "this is not valid git config at all\n");
		const reasons = gitImplicitExecutionReasons(repo);
		expect(reasons).toContainEqual(expect.stringMatching(/unrecognized/iu));
		expect(
			analyzeShellCommand({
				command: "git status --short",
				cwd: repo,
				workspaceRoots: [repo],
				shellPath: "/bin/bash",
			}),
		).toMatchObject({
			disposition: "user",
			complete: false,
		});
	});

	it("fails closed while git environment variables override configuration sources", () => {
		const { repo } = createRepo();
		const overrides: Record<string, string> = {
			GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/tmp/never-called'",
			GIT_EXTERNAL_DIFF: "/tmp/never-called",
			GIT_EXEC_PATH: "/tmp/never-called",
			GIT_DIR: repo,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.fsmonitor",
		};
		for (const [name, value] of Object.entries(overrides)) {
			process.env[name] = value;
			try {
				const reasons = gitImplicitExecutionReasons(repo);
				expect(reasons, name).toContainEqual(expect.stringMatching(new RegExp(name, "iu")));
				expect(
					analyzeShellCommand({
						command: "git status --short",
						cwd: repo,
						workspaceRoots: [repo],
						shellPath: "/bin/bash",
					}),
					name,
				).toMatchObject({ disposition: "user", complete: false });
			} finally {
				delete process.env[name];
			}
		}
	});

	it("fails closed while XDG_CONFIG_HOME or GIT_CONFIG_GLOBAL move the global source", () => {
		const { repo, root } = createRepo();
		const moved = join(root, "moved.gitconfig");
		writeFileSync(moved, '[diff "probe"]\n\ttextconv = /tmp/never-called\n');
		process.env.GIT_CONFIG_GLOBAL = moved;
		try {
			expect(gitImplicitExecutionReasons(repo)).toContainEqual(expect.stringMatching(/textconv/iu));
			expect(
				analyzeShellCommand({
					command: "git show HEAD --stat",
					cwd: repo,
					workspaceRoots: [repo],
					shellPath: "/bin/bash",
				}),
			).toMatchObject({ disposition: "user", complete: false });
		} finally {
			delete process.env.GIT_CONFIG_GLOBAL;
		}
		process.env.XDG_CONFIG_HOME = root;
		try {
			// No config under the moved XDG root: the source is still resolved, not ignored.
			expect(gitImplicitExecutionReasons(repo)).toEqual([]);
		} finally {
			delete process.env.XDG_CONFIG_HOME;
		}
	});
});
