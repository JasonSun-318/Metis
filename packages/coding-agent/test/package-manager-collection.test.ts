import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectFilesFromPaths,
	collectPackageResources,
	RESOURCE_TYPES,
} from "../src/core/package-manager/resource-collection.ts";
import { createAccumulator } from "../src/core/package-manager/resource-results.ts";
import type { PathMetadata } from "../src/core/package-manager.ts";

const fsMockState = vi.hoisted(() => ({ manifestReads: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: ((path: string, options?: BufferEncoding) => {
			if (path.endsWith("package.json")) {
				fsMockState.manifestReads += 1;
			}
			return options === undefined ? actual.readFileSync(path) : actual.readFileSync(path, options);
		}) as unknown as typeof actual.readFileSync,
		statSync: ((path: string) => {
			if (path.endsWith("stat-race.ts")) {
				throw new Error("simulated stat race");
			}
			return actual.statSync(path);
		}) as unknown as typeof actual.statSync,
	};
});

function writeFixture(path: string, content = "// fixture"): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

describe("package manager resource collection", () => {
	let root: string;
	let metadata: PathMetadata;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pm-collection-"));
		metadata = { source: root, scope: "user", origin: "package", baseDir: root };
		fsMockState.manifestReads = 0;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("keeps the collection boolean tied to filter, manifest and directory presence rather than file count", () => {
		expect(RESOURCE_TYPES).toEqual(["extensions", "skills", "prompts", "themes"]);

		const emptyDir = join(root, "empty");
		mkdirSync(emptyDir, { recursive: true });
		const empty = createAccumulator();
		expect(collectPackageResources(emptyDir, empty, undefined, metadata)).toBe(false);
		expect(empty.extensions.size).toBe(0);

		const emptyConventionDir = join(root, "empty-convention");
		mkdirSync(join(emptyConventionDir, "extensions"), { recursive: true });
		const convention = createAccumulator();
		expect(collectPackageResources(emptyConventionDir, convention, undefined, metadata)).toBe(true);
		expect(convention.extensions.size).toBe(0);

		const emptyManifestDir = join(root, "empty-manifest");
		writeFixture(join(emptyManifestDir, "package.json"), JSON.stringify({ metis: {} }));
		const emptyManifest = createAccumulator();
		expect(collectPackageResources(emptyManifestDir, emptyManifest, undefined, metadata)).toBe(true);
		expect(emptyManifest.extensions.size).toBe(0);

		const emptyArrayDir = join(root, "empty-array-manifest");
		writeFixture(join(emptyArrayDir, "extensions", "hidden.ts"));
		writeFixture(join(emptyArrayDir, "package.json"), JSON.stringify({ metis: { extensions: [] } }));
		const emptyArray = createAccumulator();
		expect(collectPackageResources(emptyArrayDir, emptyArray, undefined, metadata)).toBe(true);
		expect(emptyArray.extensions.size).toBe(0);

		const emptyFilter = createAccumulator();
		expect(collectPackageResources(emptyDir, emptyFilter, {}, metadata)).toBe(true);
		expect(emptyFilter.extensions.size).toBe(0);
	});

	it("distinguishes no filter, empty {} filter, ordinary [] filter and empty autoload=false delta", () => {
		const packageRoot = join(root, "filter-package");
		const conventionExtension = writeFixture(join(packageRoot, "extensions", "auto.ts"));
		const declaredPrompt = writeFixture(join(packageRoot, "prompts", "p.md"), "# Prompt\n");
		writeFixture(join(packageRoot, "prompts", "auto.md"), "# Auto\n");
		writeFixture(join(packageRoot, "package.json"), JSON.stringify({ metis: { prompts: ["prompts/p.md"] } }));

		const collect = (filter: Parameters<typeof collectPackageResources>[2]) => {
			const accumulator = createAccumulator();
			const result = collectPackageResources(packageRoot, accumulator, filter, metadata);
			return { accumulator, result };
		};

		const unfiltered = collect(undefined);
		expect(unfiltered.result).toBe(true);
		expect([...unfiltered.accumulator.extensions]).toEqual([]);
		expect([...unfiltered.accumulator.prompts]).toEqual([[declaredPrompt, { metadata, enabled: true }]]);

		const emptyFilter = collect({});
		expect(emptyFilter.result).toBe(true);
		expect([...emptyFilter.accumulator.extensions]).toEqual([[conventionExtension, { metadata, enabled: true }]]);
		expect([...emptyFilter.accumulator.prompts]).toEqual([[declaredPrompt, { metadata, enabled: true }]]);

		const ordinaryEmptyFilter = collect({ extensions: [] });
		expect(ordinaryEmptyFilter.result).toBe(true);
		expect([...ordinaryEmptyFilter.accumulator.extensions]).toEqual([
			[conventionExtension, { metadata, enabled: false }],
		]);
		expect([...ordinaryEmptyFilter.accumulator.prompts]).toEqual([[declaredPrompt, { metadata, enabled: true }]]);

		const emptyDelta = collect({ autoload: false, extensions: [] });
		expect(emptyDelta.result).toBe(true);
		expect(emptyDelta.accumulator.extensions.size).toBe(0);
		expect(emptyDelta.accumulator.prompts.size).toBe(0);
	});

	it("applies manifest filters before ordinary user filters and delta overrides without merging stages", () => {
		const packageRoot = join(root, "manifest-filter-package");
		const first = writeFixture(join(packageRoot, "extensions", "a.ts"));
		const excludedByManifest = writeFixture(join(packageRoot, "extensions", "b.ts"));
		const third = writeFixture(join(packageRoot, "extensions", "c.ts"));
		writeFixture(
			join(packageRoot, "package.json"),
			JSON.stringify({ metis: { extensions: ["extensions/*.ts", "!extensions/b.ts"] } }),
		);

		const ordinary = createAccumulator();
		expect(collectPackageResources(packageRoot, ordinary, { extensions: ["-extensions/a.ts"] }, metadata)).toBe(true);
		expect(new Set(ordinary.extensions.keys())).toEqual(new Set([first, third]));
		expect(ordinary.extensions.get(first)).toEqual({ metadata, enabled: false });
		expect(ordinary.extensions.get(third)).toEqual({ metadata, enabled: true });
		expect(ordinary.extensions.has(excludedByManifest)).toBe(false);

		const forceInclude = createAccumulator();
		expect(collectPackageResources(packageRoot, forceInclude, { extensions: ["+extensions/b.ts"] }, metadata)).toBe(
			true,
		);
		expect(new Set(forceInclude.extensions.keys())).toEqual(new Set([first, third]));
		expect(forceInclude.extensions.has(excludedByManifest)).toBe(false);

		const delta = createAccumulator();
		expect(
			collectPackageResources(packageRoot, delta, { autoload: false, extensions: ["-extensions/a.ts"] }, metadata),
		).toBe(true);
		expect([...delta.extensions.entries()]).toEqual([[first, { metadata, enabled: false }]]);
		expect(delta.extensions.has(third)).toBe(false);
	});

	it("collects explicit files regardless of suffix and expands directories by type in input order", () => {
		const explicit = writeFixture(join(root, "explicit.txt"));
		const directory = join(root, "themes");
		const theme = writeFixture(join(directory, "theme.json"), "{}");
		writeFixture(join(directory, "ignored.txt"));
		const missing = join(root, "missing");

		expect(collectFilesFromPaths([explicit, missing, directory], "themes")).toEqual([explicit, theme]);
		expect(collectFilesFromPaths([directory, explicit, missing], "themes")).toEqual([theme, explicit]);
		expect(collectFilesFromPaths([missing], "themes")).toEqual([]);
	});

	it("expands manifest explicit file, glob and directory entries in order without suffix filtering direct files", () => {
		const packageRoot = join(root, "manifest-expansion-package");
		const explicit = writeFixture(join(packageRoot, "explicit.txt"));
		const directoryFile = writeFixture(join(packageRoot, "extensions", "one.ts"));
		const ignoredByManifest = writeFixture(join(packageRoot, "extensions", "ignored.ts"));
		const globFile = writeFixture(join(packageRoot, "glob", "a.js"));
		const hiddenGlobFile = writeFixture(join(packageRoot, "glob", ".hidden.js"));
		writeFixture(
			join(packageRoot, "package.json"),
			JSON.stringify({
				metis: {
					extensions: ["explicit.txt", "extensions", "glob/*.js", "missing.ts", "!extensions/ignored.ts"],
				},
			}),
		);

		const accumulator = createAccumulator();
		expect(collectPackageResources(packageRoot, accumulator, undefined, metadata)).toBe(true);
		expect([...accumulator.extensions.keys()]).toEqual([explicit, directoryFile, globFile]);
		expect(accumulator.extensions.get(explicit)?.enabled).toBe(true);
		expect(accumulator.extensions.has(hiddenGlobFile)).toBe(false);
		expect(accumulator.extensions.has(ignoredByManifest)).toBe(false);
	});

	it("keeps the first raw key and original metadata reference across repeated collection", () => {
		const packageRoot = join(root, "stable-key-package");
		const resourcePath = writeFixture(join(packageRoot, "extensions", "same.ts"));
		writeFixture(
			join(packageRoot, "package.json"),
			JSON.stringify({ metis: { extensions: ["extensions/same.ts"] } }),
		);
		const firstMetadata: PathMetadata = {
			source: "first-source",
			scope: "user",
			origin: "package",
			baseDir: packageRoot,
		};
		const secondMetadata: PathMetadata = {
			source: "second-source",
			scope: "project",
			origin: "package",
			baseDir: packageRoot,
		};

		const accumulator = createAccumulator();
		expect(collectPackageResources(packageRoot, accumulator, undefined, firstMetadata)).toBe(true);
		const firstEntry = accumulator.extensions.get(resourcePath);
		expect(collectPackageResources(packageRoot, accumulator, undefined, secondMetadata)).toBe(true);

		expect(accumulator.extensions.size).toBe(1);
		expect(accumulator.extensions.get(resourcePath)).toBe(firstEntry);
		expect(firstEntry?.metadata).toBe(firstMetadata);
		expect(firstEntry?.enabled).toBe(true);
	});

	it("falls back through bad JSON and unreadable manifests and swallows stat failures", () => {
		const badJsonRoot = join(root, "bad-json");
		const badJsonFallback = writeFixture(join(badJsonRoot, "extensions", "bad.ts"));
		writeFixture(join(badJsonRoot, "package.json"), "{ invalid json");
		const badJson = createAccumulator();
		expect(collectPackageResources(badJsonRoot, badJson, undefined, metadata)).toBe(true);
		expect([...badJson.extensions.keys()]).toEqual([badJsonFallback]);

		const unreadableRoot = join(root, "unreadable-manifest");
		const unreadableFallback = writeFixture(join(unreadableRoot, "extensions", "fallback.ts"));
		mkdirSync(join(unreadableRoot, "package.json"), { recursive: true });
		const unreadable = createAccumulator();
		expect(collectPackageResources(unreadableRoot, unreadable, undefined, metadata)).toBe(true);
		expect([...unreadable.extensions.keys()]).toEqual([unreadableFallback]);

		const statRace = writeFixture(join(root, "stat-race-package", "stat-race.ts"));
		expect(collectFilesFromPaths([statRace], "extensions")).toEqual([]);
	});

	it("reads the manifest once per resource type under an empty filter and re-reads on every call", () => {
		const packageRoot = join(root, "repeat-package");
		const first = writeFixture(join(packageRoot, "first.ts"));
		const second = writeFixture(join(packageRoot, "second.ts"));
		const manifestPath = join(packageRoot, "package.json");
		writeFixture(manifestPath, JSON.stringify({ metis: { extensions: ["first.ts"] } }));

		const firstAccumulator = createAccumulator();
		expect(collectPackageResources(packageRoot, firstAccumulator, {}, metadata)).toBe(true);
		expect([...firstAccumulator.extensions.keys()]).toEqual([first]);
		expect(fsMockState.manifestReads).toBe(RESOURCE_TYPES.length);

		writeFixture(manifestPath, JSON.stringify({ metis: { extensions: ["second.ts"] } }));
		const secondAccumulator = createAccumulator();
		expect(collectPackageResources(packageRoot, secondAccumulator, {}, metadata)).toBe(true);
		expect([...secondAccumulator.extensions.keys()]).toEqual([second]);
		expect(firstAccumulator.extensions.has(first)).toBe(true);
		expect(fsMockState.manifestReads).toBe(RESOURCE_TYPES.length * 2);
	});
});
