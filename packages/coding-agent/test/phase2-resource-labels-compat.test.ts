import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceInfo } from "../src/core/source-info.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});

const homedirMock = vi.mocked(os.homedir);
const defaultHome = path.join(os.tmpdir(), "metis-phase2-default-home");

beforeEach(() => {
	homedirMock.mockReset();
	homedirMock.mockReturnValue(defaultHome);
});

// Pure string fixtures use explicit forward slashes because production index
// regexes only strip "/index.ts" and "/index.js". Cases that reach
// path.resolve/path.relative build native paths and native expectations.

type ResourceLabelMethods = {
	formatDisplayPath(resourcePath: string): string;
	formatExtensionDisplayPath(resourcePath: string): string;
	formatContextPath(resourcePath: string): string;
	getShortPath(resourcePath: string, sourceInfo?: SourceInfo): string;
	getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string;
	getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[];
	getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	};
	getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path";
};

type TestMode = ResourceLabelMethods & { setCwd(cwd: string): void };

function createMode(cwd: string): TestMode {
	const mode = Object.create(InteractiveMode.prototype) as TestMode;
	let currentCwd = cwd;
	Object.defineProperty(mode, "sessionManager", {
		configurable: true,
		value: { getCwd: () => currentCwd },
	});
	mode.setCwd = (next) => {
		currentCwd = next;
	};
	return mode;
}

type SourceInfoInput = Pick<SourceInfo, "source"> & Partial<Pick<SourceInfo, "path" | "scope" | "origin" | "baseDir">>;

function sourceInfo(overrides: SourceInfoInput): SourceInfo {
	return {
		path: overrides.path ?? "",
		source: overrides.source,
		scope: overrides.scope ?? "project",
		origin: overrides.origin ?? "top-level",
		...(overrides.baseDir === undefined ? {} : { baseDir: overrides.baseDir }),
	};
}

describe("InteractiveMode resource display path compatibility", () => {
	it("prefixes the raw home string without a separator-boundary check", () => {
		const home = path.join(os.tmpdir(), "metis-phase2-home-prefix");
		homedirMock.mockReturnValue(home);
		const mode = createMode("/tmp/project");

		const inside = path.join(home, "projects", "app.ts");
		expect(mode.formatDisplayPath(inside)).toBe(`~${inside.slice(home.length)}`);
		expect(mode.formatDisplayPath(home)).toBe("~");

		const sibling = `${home}-sibling${path.sep}app.ts`;
		expect(mode.formatDisplayPath(sibling)).toBe(`~-sibling${path.sep}app.ts`);
		expect(mode.formatDisplayPath("relative/path.ts")).toBe("relative/path.ts");
		expect(homedirMock).toHaveBeenCalledTimes(4);
	});

	it("reads the home directory on every call instead of caching it", () => {
		const firstHome = path.join(os.tmpdir(), "metis-phase2-home-first");
		const secondHome = path.join(os.tmpdir(), "metis-phase2-home-second");
		homedirMock.mockReturnValueOnce(firstHome).mockReturnValueOnce(secondHome);
		const mode = createMode("/tmp/project");
		const firstPath = path.join(firstHome, "a.ts");
		const secondPath = path.join(secondHome, "b.ts");

		expect(mode.formatDisplayPath(firstPath)).toBe(`~${firstPath.slice(firstHome.length)}`);
		expect(homedirMock).toHaveBeenCalledTimes(1);
		expect(mode.formatDisplayPath(secondPath)).toBe(`~${secondPath.slice(secondHome.length)}`);
		expect(homedirMock).toHaveBeenCalledTimes(2);
		expect(mode.formatDisplayPath(firstPath)).toBe(firstPath);
		expect(homedirMock).toHaveBeenCalledTimes(3);
	});

	it("uses a trailing-separator home literally", () => {
		const homeWithSeparator = path.join(os.tmpdir(), "metis-phase2-home-slash") + path.sep;
		homedirMock.mockReturnValue(homeWithSeparator);
		const mode = createMode("/tmp/project");

		expect(mode.formatDisplayPath(`${homeWithSeparator}app.ts`)).toBe("~app.ts");
		expect(homedirMock).toHaveBeenCalledTimes(1);
	});

	it("strips only terminal slash-index.ts and slash-index.js extension paths", () => {
		homedirMock.mockReturnValue(path.join(os.tmpdir(), "metis-phase2-home-ext"));
		const mode = createMode("/tmp/project");

		expect(mode.formatExtensionDisplayPath("/tmp/extensions/plan-mode/index.ts")).toBe("/tmp/extensions/plan-mode");
		expect(mode.formatExtensionDisplayPath("/tmp/extensions/plan-mode/index.js")).toBe("/tmp/extensions/plan-mode");
		expect(mode.formatExtensionDisplayPath("/tmp/extensions/plan-mode/index.tsx")).toBe(
			"/tmp/extensions/plan-mode/index.tsx",
		);
		expect(mode.formatExtensionDisplayPath("/tmp/extensions/myindex.ts")).toBe("/tmp/extensions/myindex.ts");
		expect(mode.formatExtensionDisplayPath("index.ts")).toBe("index.ts");
		expect(mode.formatExtensionDisplayPath("/tmp/extensions/plan-mode/index.ts/")).toBe(
			"/tmp/extensions/plan-mode/index.ts/",
		);
	});

	it("strips a forward-slash index suffix after a literal home prefix", () => {
		const home = "/virtual/metis-home";
		homedirMock.mockReturnValue(home);
		const mode = createMode("/tmp/project");

		expect(mode.formatExtensionDisplayPath(`${home}/extensions/plan-mode/index.ts`)).toBe("~/extensions/plan-mode");
		expect(homedirMock).toHaveBeenCalledTimes(1);
	});

	it("resolves absolute and relative context paths against the session cwd", () => {
		const cwd = path.join(os.tmpdir(), "metis-phase2-context-cwd");
		const mode = createMode(cwd);

		expect(mode.formatContextPath(path.join(cwd, "notes", "a.md"))).toBe(path.join("notes", "a.md"));
		expect(mode.formatContextPath(path.join("docs", "b.md"))).toBe(path.join("docs", "b.md"));
		expect(mode.formatContextPath(path.join(cwd, "sub", "..", "a.md"))).toBe("a.md");
		expect(mode.formatContextPath(cwd)).toBe(".");
		expect(mode.formatContextPath(".")).toBe(".");
	});

	it("falls back to home-relative or absolute display paths outside the cwd", () => {
		const home = path.join(os.tmpdir(), "metis-phase2-context-home");
		const cwd = path.join(os.tmpdir(), "metis-phase2-context-project");
		const insideHome = path.join(home, "other", "x.md");
		const elsewhere = path.join(os.tmpdir(), "metis-phase2-context-elsewhere", "y.md");
		homedirMock.mockReturnValue(home);

		const mode = createMode(cwd);
		expect(mode.formatContextPath(insideHome)).toBe(`~${insideHome.slice(home.length)}`);
		expect(mode.formatContextPath(elsewhere)).toBe(elsewhere);
	});

	it("reads the session cwd on every call, including relative cwd values", () => {
		const project = path.join(os.tmpdir(), "metis-phase2-context-project-moving");
		const subdirectory = path.join(project, "sub");
		const target = path.join(subdirectory, "a.md");
		const mode = createMode(subdirectory);

		expect(mode.formatContextPath(target)).toBe("a.md");

		mode.setCwd(project);
		expect(mode.formatContextPath(target)).toBe(path.join("sub", "a.md"));

		mode.setCwd(path.relative(process.cwd(), project));
		expect(mode.formatContextPath(target)).toBe(path.join("sub", "a.md"));
		expect(mode.formatContextPath(path.join(subdirectory, "b.md"))).toBe(path.join("sub", "b.md"));
	});
});

describe("InteractiveMode package short-path compatibility", () => {
	it("prefers package baseDir containment for npm and git package sources", () => {
		const mode = createMode("/tmp/project");
		const npmRoot = "/repo/node_modules/metis-markdown-preview";
		const gitRoot = "/repo/.metis/git/github.com/HazAT/metis-interactive-subagents";

		expect(
			mode.getShortPath(
				`${npmRoot}/extensions/index.ts`,
				sourceInfo({ source: "npm:metis-markdown-preview", origin: "package", baseDir: npmRoot }),
			),
		).toBe("extensions/index.ts");
		expect(
			mode.getShortPath(
				`${gitRoot}/extensions/subagents/main.ts`,
				sourceInfo({
					source: "git:github.com/HazAT/metis-interactive-subagents",
					origin: "package",
					baseDir: gitRoot,
				}),
			),
		).toBe("extensions/subagents/main.ts");
	});

	it("keeps the historical npm and git fallback regexes when baseDir is absent or not a container", () => {
		const mode = createMode("/tmp/project");

		expect(mode.getShortPath("/repo/node_modules/pkg/extensions/index.ts", sourceInfo({ source: "npm:pkg" }))).toBe(
			"index.ts",
		);
		expect(
			mode.getShortPath(
				"/repo/node_modules/@scope/pkg/extensions/index.ts",
				sourceInfo({ source: "npm:@scope/pkg" }),
			),
		).toBe("extensions/index.ts");
		expect(mode.getShortPath("/repo/node_modules/pkg/src/a.ts", sourceInfo({ source: "npm:pkg" }))).toBe("a.ts");
		expect(
			mode.getShortPath(
				"/repo/node_modules/pkg-other/extensions/index.ts",
				sourceInfo({ source: "npm:pkg", baseDir: "/repo/node_modules/pkg" }),
			),
		).toBe("index.ts");
		expect(
			mode.getShortPath(
				"/repo/.metis/git/github.com/HazAT/repo/extensions/index.ts",
				sourceInfo({ source: "git:github.com/HazAT/repo" }),
			),
		).toBe("repo/extensions/index.ts");
	});

	it("only applies baseDir containment to package sources", () => {
		const home = path.join(os.tmpdir(), "metis-phase2-home-short");
		homedirMock.mockReturnValue(home);
		const mode = createMode("/tmp/project");
		const localPath = path.join(home, "extensions", "answer.ts");
		const baseDir = path.join(home, "extensions");
		const expected = `~${localPath.slice(home.length)}`;

		expect(mode.getShortPath(localPath, sourceInfo({ source: "local", baseDir }))).toBe(expected);
		expect(mode.getShortPath(localPath, sourceInfo({ source: "cli", scope: "temporary", baseDir }))).toBe(expected);
		expect(mode.getShortPath(localPath, sourceInfo({ source: "custom:thing", baseDir }))).toBe(expected);
		expect(mode.getShortPath(localPath, sourceInfo({ source: "npm:pkg" }))).toBe(expected);
		expect(mode.getShortPath(localPath)).toBe(expected);
	});
});

describe("InteractiveMode compact label compatibility", () => {
	it("derives compact path labels from the final normalized segment", () => {
		const mode = createMode("/tmp/project");
		const npmRoot = "/repo/node_modules/metis-markdown-preview";
		const npmSource = sourceInfo({ source: "npm:metis-markdown-preview", origin: "package", baseDir: npmRoot });

		expect(mode.getCompactPathLabel(`${npmRoot}/extensions/index.ts`, npmSource)).toBe("index.ts");
		expect(mode.getCompactPathLabel("/tmp/extensions/answer.ts")).toBe("answer.ts");
		expect(mode.getCompactPathLabel("/tmp/extensions/nested/answer.ts")).toBe("answer.ts");
		expect(mode.getCompactPathLabel(String.raw`C:\extensions\nested\answer.ts`)).toBe("answer.ts");
		expect(mode.getCompactPathLabel("/tmp/extensions/")).toBe("extensions");
		expect(mode.getCompactPathLabel("~")).toBe("~");
		expect(mode.getCompactPathLabel("/")).toBe("/");
		expect(mode.getCompactPathLabel("")).toBe("");
	});

	it("formats compact package source labels through the aggregate entry point", () => {
		const mode = createMode("/tmp/project");
		const npmRoot = "/repo/node_modules/metis-markdown-preview";
		const gitRoot = "/repo/.metis/git/github.com/HazAT/metis-interactive-subagents";
		const label = (resourcePath: string, info?: SourceInfo): string =>
			mode.getCompactExtensionLabels([{ path: resourcePath, sourceInfo: info }])[0]!;

		expect(
			label(
				`${npmRoot}/extensions/index.ts`,
				sourceInfo({ source: "npm:metis-markdown-preview", origin: "package", baseDir: npmRoot }),
			),
		).toBe("metis-markdown-preview");
		expect(
			label(
				"/repo/node_modules/pkg/extensions/index.ts",
				sourceInfo({ source: "npm:", origin: "package", baseDir: "/repo/node_modules/pkg" }),
			),
		).toBe("npm:");
		expect(
			label(
				`${gitRoot}/extensions/index.ts`,
				sourceInfo({
					source: "git:https://github.com/HazAT/metis-interactive-subagents.git",
					origin: "package",
					baseDir: gitRoot,
				}),
			),
		).toBe("HazAT/metis-interactive-subagents");
		expect(
			label(
				`${gitRoot}/extensions/index.ts`,
				sourceInfo({
					source: "git:github.com/HazAT/metis-interactive-subagents",
					origin: "package",
					baseDir: gitRoot,
				}),
			),
		).toBe("HazAT/metis-interactive-subagents");
		expect(label("/tmp/extensions/answer.ts", sourceInfo({ source: "local" }))).toBe("answer.ts");
		expect(label("/tmp/extensions/answer.ts", sourceInfo({ source: "custom:thing" }))).toBe("answer.ts");
		expect(label("/tmp/extensions/answer.ts")).toBe("answer.ts");
	});

	it("renders package extension labels from package-relative paths", () => {
		const mode = createMode("/tmp/project");
		const npmRoot = "/repo/node_modules/metis-markdown-preview";
		const npmSource = (source: string, baseDir?: string) =>
			sourceInfo({ source, origin: "package", ...(baseDir === undefined ? {} : { baseDir }) });
		const gitRoot = "/repo/.metis/git/github.com/HazAT/metis-interactive-subagents";
		const gitSource = (source: string, baseDir?: string) =>
			sourceInfo({ source, origin: "package", ...(baseDir === undefined ? {} : { baseDir }) });
		const label = (resourcePath: string, info?: SourceInfo): string =>
			mode.getCompactExtensionLabels([{ path: resourcePath, sourceInfo: info }])[0]!;

		expect(label(`${npmRoot}/extensions/index.ts`, npmSource("npm:metis-markdown-preview", npmRoot))).toBe(
			"metis-markdown-preview",
		);
		expect(label(`${npmRoot}/extensions/subagents/index.ts`, npmSource("npm:metis-markdown-preview", npmRoot))).toBe(
			"metis-markdown-preview:subagents",
		);
		expect(label(`${npmRoot}/extensions/subagents/main.ts`, npmSource("npm:metis-markdown-preview", npmRoot))).toBe(
			"metis-markdown-preview:subagents/main.ts",
		);
		expect(label(`${npmRoot}/src/a.ts`, npmSource("npm:metis-markdown-preview", npmRoot))).toBe(
			"metis-markdown-preview:src/a.ts",
		);
		expect(
			label(
				`${gitRoot}/extensions/index.js`,
				gitSource("git:github.com/HazAT/metis-interactive-subagents", gitRoot),
			),
		).toBe("HazAT/metis-interactive-subagents");
		expect(
			label(
				`${gitRoot}/extensions/sub/main.ts`,
				gitSource("git:github.com/HazAT/metis-interactive-subagents", gitRoot),
			),
		).toBe("HazAT/metis-interactive-subagents:sub/main.ts");
		expect(label("/tmp/extensions/answer.ts")).toBe("answer.ts");
		expect(label("/tmp/extensions/answer.ts", sourceInfo({ source: "local", baseDir: "/tmp/extensions" }))).toBe(
			"answer.ts",
		);
	});

	it("keeps the npm fallback's loss of the first package subdirectory when baseDir is absent", () => {
		const mode = createMode("/tmp/project");
		const label = (resourcePath: string, info?: SourceInfo): string =>
			mode.getCompactExtensionLabels([{ path: resourcePath, sourceInfo: info }])[0]!;

		expect(label("/repo/node_modules/pkg/src/a.ts", sourceInfo({ source: "npm:pkg" }))).toBe("pkg:a.ts");
		expect(
			label("/repo/node_modules/pkg/src/a.ts", sourceInfo({ source: "npm:pkg", baseDir: "/repo/node_modules/pkg" })),
		).toBe("pkg:src/a.ts");
	});
});

describe("InteractiveMode compact extension-list compatibility", () => {
	function extension(resourcePath: string, info?: SourceInfo): { path: string; sourceInfo?: SourceInfo } {
		return { path: resourcePath, sourceInfo: info };
	}

	it("uses basenames when they are unique and expands only colliding suffixes", () => {
		const mode = createMode("/tmp/project");

		expect(
			mode.getCompactExtensionLabels([extension("/tmp/extensions/answer.ts"), extension("/tmp/other/btw.ts")]),
		).toEqual(["answer.ts", "btw.ts"]);

		expect(
			mode.getCompactExtensionLabels([extension("/tmp/alpha/one/index.ts"), extension("/tmp/beta/one/index.ts")]),
		).toEqual(["alpha/one", "beta/one"]);

		expect(
			mode.getCompactExtensionLabels([extension("/tmp/shared/tool.ts"), extension("/tmp/x/shared/tool.ts")]),
		).toEqual(["tmp/shared/tool.ts", "x/shared/tool.ts"]);
	});

	it("falls back to the full path for identical duplicate extension paths", () => {
		const mode = createMode("/tmp/project");

		expect(
			mode.getCompactExtensionLabels([
				extension("/tmp/c/tool.ts"),
				extension("/tmp/c/tool.ts"),
				extension("/tmp/shared/tool.ts"),
			]),
		).toEqual(["tmp/c/tool.ts", "tmp/c/tool.ts", "shared/tool.ts"]);
	});

	it("strips index.ts and index.js only when a parent segment remains", () => {
		const mode = createMode("/tmp/project");

		expect(
			mode.getCompactExtensionLabels([
				extension("index.ts"),
				extension("dir/index.ts"),
				extension("dir/index.js"),
				extension("nested/plan-mode/index.ts"),
			]),
		).toEqual(["index.ts", "dir", "dir", "plan-mode"]);
	});

	it("keeps package labels independent from non-package collision indexes", () => {
		const mode = createMode("/tmp/project");
		const npmRoot = "/repo/node_modules/metis-markdown-preview";
		const extensions = [
			extension(
				`${npmRoot}/extensions/index.ts`,
				sourceInfo({ source: "npm:metis-markdown-preview", origin: "package", baseDir: npmRoot }),
			),
			extension("/tmp/alpha/one/index.ts"),
			extension("/tmp/beta/one/index.ts"),
			extension(
				"/repo/node_modules/other-package/extensions/main.ts",
				sourceInfo({
					source: "npm:other-package",
					origin: "package",
					baseDir: "/repo/node_modules/other-package",
				}),
			),
		];

		expect(mode.getCompactExtensionLabels(extensions)).toEqual([
			"metis-markdown-preview",
			"alpha/one",
			"beta/one",
			"other-package:main.ts",
		]);
	});

	it("does not let package sources force non-package disambiguation", () => {
		const mode = createMode("/tmp/project");
		const npmRoot = "/repo/node_modules/metis-markdown-preview";

		expect(
			mode.getCompactExtensionLabels([
				extension("/tmp/extensions/foo/index.ts"),
				extension(
					`${npmRoot}/extensions/foo/index.ts`,
					sourceInfo({ source: "npm:metis-markdown-preview", origin: "package", baseDir: npmRoot }),
				),
			]),
		).toEqual(["foo", "metis-markdown-preview:foo"]);
	});

	it("returns an empty list for no extensions", () => {
		const mode = createMode("/tmp/project");
		expect(mode.getCompactExtensionLabels([])).toEqual([]);
	});
});

describe("InteractiveMode resource scope label compatibility", () => {
	it("keeps local, CLI, package, unknown and missing scope labels", () => {
		const mode = createMode("/tmp/project");

		expect(mode.getDisplaySourceInfo(sourceInfo({ source: "local", scope: "user" }))).toEqual({
			label: "user",
			color: "muted",
		});
		expect(mode.getDisplaySourceInfo(sourceInfo({ source: "local", scope: "project" }))).toEqual({
			label: "project",
			color: "muted",
		});
		expect(mode.getDisplaySourceInfo(sourceInfo({ source: "local", scope: "temporary" }))).toEqual({
			label: "path",
			scopeLabel: "temp",
			color: "muted",
		});
		expect(mode.getDisplaySourceInfo(sourceInfo({ source: "cli", scope: "temporary" }))).toEqual({
			label: "path",
			scopeLabel: "temp",
			color: "muted",
		});
		expect(mode.getDisplaySourceInfo(sourceInfo({ source: "npm:pkg", scope: "user", origin: "package" }))).toEqual({
			label: "npm:pkg",
			scopeLabel: "user",
			color: "accent",
		});
		expect(
			mode.getDisplaySourceInfo(sourceInfo({ source: "git:github.com/a/b", scope: "temporary", origin: "package" })),
		).toEqual({
			label: "git:github.com/a/b",
			scopeLabel: "temp",
			color: "accent",
		});
		expect(mode.getDisplaySourceInfo(sourceInfo({ source: "custom:thing", scope: "temporary" }))).toEqual({
			label: "custom:thing",
			scopeLabel: "temp",
			color: "accent",
		});
		expect(mode.getDisplaySourceInfo()).toEqual({ label: "project", color: "muted" });
	});

	it("keeps scope grouping for user, project, temporary, CLI and unknown scopes", () => {
		const mode = createMode("/tmp/project");

		expect(mode.getScopeGroup()).toBe("project");
		expect(mode.getScopeGroup(sourceInfo({ source: "local", scope: "user" }))).toBe("user");
		expect(mode.getScopeGroup(sourceInfo({ source: "local", scope: "project" }))).toBe("project");
		expect(mode.getScopeGroup(sourceInfo({ source: "local", scope: "temporary" }))).toBe("path");
		expect(mode.getScopeGroup(sourceInfo({ source: "cli", scope: "project" }))).toBe("path");
		expect(mode.getScopeGroup(sourceInfo({ source: "npm:pkg", scope: "temporary" }))).toBe("path");
		expect(mode.getScopeGroup(sourceInfo({ source: "custom:thing", scope: "other" as SourceInfo["scope"] }))).toBe(
			"path",
		);
	});
});
