import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getProjectConfigDir } from "../src/config.ts";
import {
	getBaseDirForScope,
	getGitInstallPath,
	getGitInstallRoot,
	getManagedNpmInstallPath,
	getNpmInstallRoot,
	type InstallPathContext,
	resolveManagedPath,
} from "../src/core/package-manager/install-paths.ts";
import type { GitSource } from "../src/utils/git.ts";

const context: InstallPathContext = {
	cwd: "/repo/project",
	agentDir: "/home/user/.metis/agent",
	assertProjectTrusted: vi.fn(),
};

const temporaryDir = (prefix: string, suffix?: string) => `/tmp/pkg-temp/${prefix}/${suffix ?? ""}`;
const npmSource = { type: "npm", spec: "pkg@1", name: "pkg", version: "1", range: undefined, pinned: true } as const;
const gitSource = {
	type: "git",
	repo: "https://github.com/acme/tools",
	host: "github.com",
	path: "acme/tools",
} as GitSource;

describe("package install paths", () => {
	it("keeps managed paths inside their root", () => {
		expect(resolveManagedPath("/root", "a", "b")).toBe(join("/root", "a", "b"));
		expect(() => resolveManagedPath("/root", "..", "escape")).toThrow(/outside package install root/);
	});

	it("resolves base dirs per scope and checks project trust", () => {
		expect(getBaseDirForScope("user", context)).toBe(context.agentDir);
		expect(getBaseDirForScope("temporary", context)).toBe(context.cwd);
		expect(getBaseDirForScope("project", context)).toBe(getProjectConfigDir(context.cwd));
		expect(context.assertProjectTrusted).toHaveBeenCalledWith("project");
	});

	it("resolves npm install roots", () => {
		expect(getNpmInstallRoot("user", false, temporaryDir, context)).toBe(join(context.agentDir, "npm"));
		expect(getNpmInstallRoot("project", false, temporaryDir, context)).toBe(
			join(getProjectConfigDir(context.cwd), "npm"),
		);
		expect(getNpmInstallRoot("temporary", true, temporaryDir, context)).toBe("/tmp/pkg-temp/npm/");
	});

	it("resolves managed npm package paths", () => {
		expect(getManagedNpmInstallPath(npmSource, "user", temporaryDir, context)).toBe(
			join(context.agentDir, "npm", "node_modules", "pkg"),
		);
		expect(getManagedNpmInstallPath(npmSource, "temporary", temporaryDir, context)).toBe(
			join("/tmp/pkg-temp/npm/", "node_modules", "pkg"),
		);
	});

	it("resolves git install roots and paths", () => {
		expect(getGitInstallRoot("temporary", context)).toBeUndefined();
		expect(getGitInstallRoot("user", context)).toBe(join(context.agentDir, "git"));
		expect(getGitInstallPath(gitSource, "temporary", temporaryDir, context)).toBe(
			"/tmp/pkg-temp/git-github.com/acme/tools",
		);
		expect(getGitInstallPath(gitSource, "user", temporaryDir, context)).toBe(
			join(context.agentDir, "git", "github.com", "acme/tools"),
		);
	});
});
