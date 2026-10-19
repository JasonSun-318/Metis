import * as path from "node:path";
import { describe, expect, test } from "vitest";
import type { SourceInfo } from "../src/core/source-info.ts";
import {
	formatContextPath,
	formatDisplayPath,
	formatExtensionDisplayPath,
	getCompactExtensionLabels,
	getCompactPathLabel,
	getShortPath,
	isPackageSource,
} from "../src/modes/interactive/interactive-resource-labels.ts";

function createSourceInfo(
	filePath: string,
	options: {
		source: string;
		scope?: "user" | "project" | "temporary";
		origin?: "package" | "top-level";
		baseDir?: string;
	},
): SourceInfo {
	return {
		path: filePath,
		source: options.source,
		scope: options.scope ?? "project",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}

describe("interactive resource labels (pure)", () => {
	test("abbreviates raw home prefixes without normalizing separators", () => {
		const home = () => "/home/tester";

		expect(formatDisplayPath("/home/tester/project/file.ts", home)).toBe("~/project/file.ts");
		expect(formatDisplayPath("/home/tester", home)).toBe("~");
		expect(formatDisplayPath("/home/tester-suffix/file.ts", home)).toBe("~-suffix/file.ts");
		expect(formatDisplayPath("C:\\Users\\tester\\file.ts", home)).toBe("C:\\Users\\tester\\file.ts");

		const windowsHome = () => "C:\\Users\\tester";
		expect(formatDisplayPath("C:\\Users\\tester\\file.ts", windowsHome)).toBe("~\\file.ts");
	});

	test("strips index suffixes only for forward-slash paths", () => {
		const home = () => "/home/tester";

		expect(formatExtensionDisplayPath("/home/tester/extensions/answer/index.ts", home)).toBe("~/extensions/answer");
		expect(formatExtensionDisplayPath("/home/tester/extensions/answer/index.js", home)).toBe("~/extensions/answer");
		expect(formatExtensionDisplayPath("/home/tester/extensions/answer/index.jsx", home)).toBe(
			"~/extensions/answer/index.jsx",
		);
		expect(formatExtensionDisplayPath("/home/tester/extensions/answer/index.ts/", home)).toBe(
			"~/extensions/answer/index.ts/",
		);

		const windowsHome = () => "C:\\Users\\tester";
		expect(formatExtensionDisplayPath("C:\\Users\\tester\\extensions\\answer\\index.ts", windowsHome)).toBe(
			"~\\extensions\\answer\\index.ts",
		);
	});

	test("resolves context paths against the current platform", () => {
		const cwd = path.resolve("/platform/work/project");
		const homeDir = path.resolve("/platform/home/tester");
		const home = () => homeDir;
		const relativePath = path.join("src", "main.ts");
		const outsidePath = path.resolve(cwd, "..", "sibling", "file.ts");
		const homeFile = path.join(homeDir, ".metis", "agent", "AGENTS.md");

		expect(formatContextPath(path.join(cwd, "src", "main.ts"), cwd, home)).toBe(relativePath);
		expect(formatContextPath("src/main.ts", cwd, home)).toBe(relativePath);
		expect(formatContextPath(cwd, cwd, home)).toBe(".");
		expect(formatContextPath(outsidePath, cwd, home)).toBe(outsidePath);
		expect(formatContextPath(homeFile, cwd, home)).toBe(`~${homeFile.slice(homeDir.length)}`);
	});

	test("keeps package containment and legacy npm/git fallbacks", () => {
		const projectRoot = path.resolve("/platform/project");
		const homeDir = path.resolve("/platform/home/tester");
		const home = () => homeDir;
		const packageRoot = path.join(projectRoot, "node_modules", "metis-x");
		const packagePath = path.join(packageRoot, "extensions", "answer.ts");
		const packageSource = createSourceInfo(packagePath, {
			source: "npm:metis-x",
			origin: "package",
			baseDir: packageRoot,
		});

		expect(getShortPath(packagePath, packageSource, home)).toBe("extensions/answer.ts");
		expect(getShortPath(packageRoot, packageSource, home)).toBe(packageRoot);

		const siblingPath = path.join(projectRoot, "packages", "metis-x-sibling", "extensions", "answer.ts");
		const siblingSource = createSourceInfo(siblingPath, {
			source: "git:github.com/user/repo",
			origin: "package",
			baseDir: packageRoot,
		});
		expect(getShortPath(siblingPath, siblingSource, home)).toBe(siblingPath);

		expect(
			getShortPath(
				"/repo/node_modules/metis-x/extensions/answer.ts",
				createSourceInfo("", { source: "npm:metis-x" }),
				home,
			),
		).toBe("answer.ts");
		expect(
			getShortPath(
				"/repo/node_modules/@scope/metis-x/extensions/answer.ts",
				createSourceInfo("", { source: "npm:@scope/metis-x" }),
				home,
			),
		).toBe("extensions/answer.ts");
		expect(
			getShortPath(
				"/repo/.metis/git/github.com/user/repo/extensions/answer.ts",
				createSourceInfo("", { source: "git:github.com/user/repo" }),
				home,
			),
		).toBe("repo/extensions/answer.ts");
	});

	test("ignores package baseDir for local, CLI, unknown and missing sources", () => {
		const home = () => "/home/tester";
		const baseDir = "/tmp/extensions";
		const resourcePath = "/tmp/extensions/answer.ts";

		for (const source of ["local", "cli", "unknown-source"]) {
			expect(getShortPath(resourcePath, createSourceInfo(resourcePath, { source, baseDir }), home)).toBe(
				resourcePath,
			);
		}
		expect(getShortPath(resourcePath, undefined, home)).toBe(resourcePath);
	});

	test("reduces compact path labels across separators", () => {
		const home = () => "/home/tester";

		expect(getCompactPathLabel("/tmp/extensions/answer.ts", undefined, home)).toBe("answer.ts");
		expect(getCompactPathLabel("~", undefined, home)).toBe("~");
		expect(getCompactPathLabel("C:\\tmp\\answer.ts", undefined, home)).toBe("answer.ts");
	});

	test("resolves compact collisions and index forms", () => {
		const home = () => "/home/tester";

		expect(
			getCompactExtensionLabels(
				[
					{ path: "/repo/alpha/one/index.ts" },
					{ path: "/repo/beta/one/index.ts" },
					{ path: "/repo/gamma/one/index.ts" },
				],
				home,
			),
		).toEqual(["alpha/one", "beta/one", "gamma/one"]);
		expect(getCompactExtensionLabels([{ path: "/repo/alpha/one.ts" }, { path: "/repo/alpha/one.ts" }], home)).toEqual(
			["repo/alpha/one.ts", "repo/alpha/one.ts"],
		);
		expect(getCompactExtensionLabels([{ path: "/" }], home)).toEqual(["/"]);
		expect(getCompactExtensionLabels([{ path: "~" }], home)).toEqual(["~"]);
		expect(getCompactExtensionLabels([{ path: "/tmp/a\\b\\c.ts" }], home)).toEqual(["c.ts"]);
		expect(getCompactExtensionLabels([{ path: "/tmp/extensions/local/index.js" }], home)).toEqual(["local"]);

		const projectRoot = path.resolve("/platform/project");
		const packageRoot = path.join(projectRoot, "node_modules", "metis-x");
		const packageSource = (filePath: string) =>
			createSourceInfo(filePath, { source: "npm:metis-x", origin: "package", baseDir: packageRoot });
		const packageIndex = path.join(packageRoot, "extensions", "index.mjs");
		const packageSubIndex = path.join(packageRoot, "extensions", "sub", "index.mts");
		const packageDeclaration = path.join(packageRoot, "extensions", "index.d.ts");

		expect(
			getCompactExtensionLabels([{ path: packageIndex, sourceInfo: packageSource(packageIndex) }], home),
		).toEqual(["metis-x"]);
		expect(
			getCompactExtensionLabels([{ path: packageSubIndex, sourceInfo: packageSource(packageSubIndex) }], home),
		).toEqual(["metis-x:sub"]);
		expect(
			getCompactExtensionLabels([{ path: packageDeclaration, sourceInfo: packageSource(packageDeclaration) }], home),
		).toEqual(["metis-x:index.d.ts"]);

		const scopedRoot = path.join(projectRoot, "node_modules", "@scope", "metis-x");
		const scopedIndex = path.join(scopedRoot, "extensions", "index.ts");
		expect(
			getCompactExtensionLabels(
				[
					{
						path: scopedIndex,
						sourceInfo: createSourceInfo(scopedIndex, {
							source: "npm:@scope/metis-x",
							origin: "package",
							baseDir: scopedRoot,
						}),
					},
				],
				home,
			),
		).toEqual(["@scope/metis-x"]);

		const gitRoot = path.join(projectRoot, ".metis", "git", "github.com", "user", "repo");
		const gitIndex = path.join(gitRoot, "extensions", "index.ts");
		expect(
			getCompactExtensionLabels(
				[
					{
						path: gitIndex,
						sourceInfo: createSourceInfo(gitIndex, {
							source: "git:github.com/user/repo",
							origin: "package",
							baseDir: gitRoot,
						}),
					},
				],
				home,
			),
		).toEqual(["user/repo"]);
	});

	test("classifies only npm and git sources as package sources", () => {
		for (const source of ["npm:metis-x", "npm:@scope/metis-x", "git:github.com/user/repo"]) {
			expect(isPackageSource(createSourceInfo("", { source }))).toBe(true);
		}
		for (const source of ["local", "cli", "unknown-source", ""]) {
			expect(isPackageSource(createSourceInfo("", { source }))).toBe(false);
		}
		expect(isPackageSource(undefined)).toBe(false);
	});
});

describe("interactive resource labels (environment timing)", () => {
	test("reads injected home only when a display fallback is needed", () => {
		let homeReads = 0;
		const homeDir = path.resolve("/platform/home/tester");
		const home = () => {
			homeReads += 1;
			return homeDir;
		};
		const cwd = path.resolve("/platform/work/project");

		expect(formatContextPath(path.join(cwd, "src", "main.ts"), cwd, home)).toBe(path.join("src", "main.ts"));
		expect(homeReads).toBe(0);

		const outsidePath = path.resolve(cwd, "..", "outside.txt");
		expect(formatContextPath(outsidePath, cwd, home)).toBe(outsidePath);
		expect(homeReads).toBe(1);

		homeReads = 0;
		const projectRoot = path.resolve("/platform/project");
		const packageRoot = path.join(projectRoot, "node_modules", "metis-x");
		const packagePath = path.join(packageRoot, "extensions", "index.ts");
		const packageSource = createSourceInfo(packagePath, {
			source: "npm:metis-x",
			origin: "package",
			baseDir: packageRoot,
		});

		expect(getShortPath(packagePath, packageSource, home)).toBe("extensions/index.ts");
		expect(getCompactPathLabel(packagePath, packageSource, home)).toBe("index.ts");
		expect(homeReads).toBe(0);

		const nonPackagePath = path.join(projectRoot, "extensions", "answer.ts");
		expect(getShortPath(nonPackagePath, undefined, home)).toBe(nonPackagePath);
		expect(homeReads).toBe(1);
	});

	test("reads injected home once per aggregate entry before package filtering", () => {
		let homeReads = 0;
		const homeDir = path.resolve("/platform/home/tester");
		const home = () => {
			homeReads += 1;
			return homeDir;
		};
		const projectRoot = path.resolve("/platform/project");
		const packageRoot = path.join(projectRoot, "node_modules", "metis-x");
		const sourceAt = (filePath: string) =>
			createSourceInfo(filePath, { source: "npm:metis-x", origin: "package", baseDir: packageRoot });
		const first = path.join(packageRoot, "extensions", "index.ts");
		const second = path.join(packageRoot, "extensions", "second.ts");

		expect(getCompactExtensionLabels([{ path: first, sourceInfo: sourceAt(first) }], home)).toEqual(["metis-x"]);
		expect(homeReads).toBe(1);

		homeReads = 0;
		expect(
			getCompactExtensionLabels(
				[
					{ path: first, sourceInfo: sourceAt(first) },
					{ path: second, sourceInfo: sourceAt(second) },
				],
				home,
			),
		).toEqual(["metis-x", "metis-x:second.ts"]);
		expect(homeReads).toBe(2);
	});
});
