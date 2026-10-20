import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResourceType } from "../src/core/package-manager/resource-discovery.ts";
import {
	addResource,
	createAccumulator,
	getTargetMap,
	toResolvedPaths,
} from "../src/core/package-manager/resource-results.ts";
import type { PathMetadata } from "../src/core/package-manager.ts";

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceType[];

const projectLocal = { source: "local", scope: "project", origin: "top-level" } as const;
const projectAuto = { source: "auto", scope: "project", origin: "top-level" } as const;
const userLocal = { source: "local", scope: "user", origin: "top-level" } as const;
const userAuto = { source: "auto", scope: "user", origin: "top-level" } as const;
const packageMetadata = { source: "package", scope: "user", origin: "package" } as const;

type ResourceMap = Map<string, { metadata: PathMetadata; enabled: boolean }>;

function writeFixture(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "// fixture");
	return path;
}

describe("package manager resource results", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pm-results-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("routes each resource type to its own explicit map and isolates accumulators", () => {
		const accumulator = createAccumulator();
		expect(new Set([accumulator.extensions, accumulator.skills, accumulator.prompts, accumulator.themes]).size).toBe(
			4,
		);

		for (const resourceType of RESOURCE_TYPES) {
			const target = getTargetMap(accumulator, resourceType);
			expect(target).toBe(accumulator[resourceType]);
			addResource(target, `only-${resourceType}`, projectLocal, true);
		}

		for (const resourceType of RESOURCE_TYPES) {
			expect(accumulator[resourceType].size).toBe(1);
			expect(accumulator[resourceType].get(`only-${resourceType}`)).toEqual({
				metadata: projectLocal,
				enabled: true,
			});
		}

		const other = createAccumulator();
		for (const resourceType of RESOURCE_TYPES) {
			expect(other[resourceType]).not.toBe(accumulator[resourceType]);
			expect(other[resourceType].size).toBe(0);
		}
	});

	it("keeps the original unknown resource type error", () => {
		expect(() => getTargetMap(createAccumulator(), "unknown" as ResourceType)).toThrow(
			"Unknown resource type: unknown",
		);
	});

	it("skips empty paths and keeps the first metadata and enabled state for a raw key", () => {
		const map: ResourceMap = new Map();
		addResource(map, "", projectLocal, true);
		expect(map.size).toBe(0);

		addResource(map, "same", projectLocal, true);
		const firstEntry = map.get("same");
		addResource(map, "same", packageMetadata, false);

		expect(map.size).toBe(1);
		expect(map.get("same")).toBe(firstEntry);
		expect(map.get("same")).toEqual({ metadata: projectLocal, enabled: true });
	});

	it("sorts all five ranks stably, retains disabled entries and does not mutate the input map", () => {
		const paths = {
			packageEnabled: writeFixture(join(tempDir, "z-package.ts")),
			userAuto: writeFixture(join(tempDir, "x-user-auto.ts")),
			projectLocalFirst: writeFixture(join(tempDir, "z-project-local.ts")),
			projectAuto: writeFixture(join(tempDir, "w-project-auto.ts")),
			userLocal: writeFixture(join(tempDir, "v-user-local.ts")),
			projectLocalSecond: writeFixture(join(tempDir, "a-project-local.ts")),
			packageDisabled: writeFixture(join(tempDir, "a-package-disabled.ts")),
		};

		const accumulator = createAccumulator();
		const map = getTargetMap(accumulator, "extensions");
		addResource(map, paths.packageEnabled, packageMetadata, true);
		addResource(map, paths.userAuto, userAuto, true);
		addResource(map, paths.projectLocalFirst, projectLocal, true);
		addResource(map, paths.projectAuto, projectAuto, true);
		addResource(map, paths.userLocal, userLocal, true);
		addResource(map, paths.projectLocalSecond, projectLocal, true);
		addResource(map, paths.packageDisabled, packageMetadata, false);

		const keysBefore = [...map.keys()];
		const entriesBefore = [...map.entries()];
		const resolved = toResolvedPaths(accumulator).extensions;

		expect(resolved.map(({ path, enabled }) => ({ path, enabled }))).toEqual([
			{ path: paths.projectLocalFirst, enabled: true },
			{ path: paths.projectLocalSecond, enabled: true },
			{ path: paths.projectAuto, enabled: true },
			{ path: paths.userLocal, enabled: true },
			{ path: paths.userAuto, enabled: true },
			{ path: paths.packageEnabled, enabled: true },
			{ path: paths.packageDisabled, enabled: false },
		]);
		expect(resolved[0]!.metadata).toBe(projectLocal);
		expect(resolved.at(-1)!.metadata).toBe(packageMetadata);

		expect([...map.keys()]).toEqual(keysBefore);
		expect([...map.entries()]).toEqual(entriesBefore);
		for (const [key, entry] of entriesBefore) {
			expect(map.get(key)).toBe(entry);
		}
	});

	it("dedupes canonical aliases after rank sorting independently for all four resource types", () => {
		const target = writeFixture(join(tempDir, "target.ts"));
		const projectAlias = join(tempDir, "project-alias.ts");
		const packageAlias = join(tempDir, "package-alias.ts");
		symlinkSync(target, projectAlias);
		symlinkSync(target, packageAlias);

		const accumulator = createAccumulator();
		for (const resourceType of RESOURCE_TYPES) {
			const map = getTargetMap(accumulator, resourceType);
			addResource(map, packageAlias, packageMetadata, true);
			addResource(map, target, packageMetadata, true);
			addResource(map, projectAlias, projectLocal, false);
		}

		const resolved = toResolvedPaths(accumulator);
		for (const resourceType of RESOURCE_TYPES) {
			expect(resolved[resourceType]).toHaveLength(1);
			expect(resolved[resourceType][0]).toEqual({
				path: projectAlias,
				enabled: false,
				metadata: projectLocal,
			});
			expect(resolved[resourceType][0]!.metadata).toBe(projectLocal);
		}
	});

	it("keeps distinct unnormalized missing paths when realpath fails", () => {
		const collision = join(tempDir, "collision.ts");
		const unnormalized = `${tempDir}/absent/../collision.ts`;
		const accumulator = createAccumulator();
		const map = getTargetMap(accumulator, "extensions");
		addResource(map, collision, projectLocal, true);
		addResource(map, unnormalized, projectLocal, false);

		expect(toResolvedPaths(accumulator).extensions.map((entry) => entry.path)).toEqual([collision, unnormalized]);
	});

	it("re-reads canonical paths on every conversion without caching symlink targets", () => {
		const targetA = writeFixture(join(tempDir, "target-a.ts"));
		const targetB = writeFixture(join(tempDir, "target-b.ts"));
		const alias = join(tempDir, "current.ts");
		symlinkSync(targetA, alias);

		const accumulator = createAccumulator();
		const map = getTargetMap(accumulator, "extensions");
		addResource(map, alias, projectLocal, true);
		addResource(map, targetB, packageMetadata, true);

		expect(toResolvedPaths(accumulator).extensions.map((entry) => entry.path)).toEqual([alias, targetB]);

		rmSync(alias);
		symlinkSync(targetB, alias);

		expect(toResolvedPaths(accumulator).extensions.map((entry) => entry.path)).toEqual([alias]);
	});
});
