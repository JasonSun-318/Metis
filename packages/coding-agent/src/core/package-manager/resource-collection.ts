import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { globSync } from "glob";
import type { PathMetadata } from "../package-manager.ts";
import { collectResourceFiles, type MetisManifest, type ResourceType } from "./resource-discovery.ts";
import {
	applyAutoloadDisabledPatterns,
	applyPatterns,
	hasGlobPattern,
	isOverridePattern,
} from "./resource-patterns.ts";
import { addResource, getTargetMap, type ResourceAccumulator } from "./resource-results.ts";

export interface PackageFilter {
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

export function collectPackageResources(
	packageRoot: string,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): boolean {
	if (filter) {
		for (const resourceType of RESOURCE_TYPES) {
			const patterns = filter[resourceType];
			const target = getTargetMap(accumulator, resourceType);
			if (filter.autoload === false) {
				applyPackageDeltaFilter(packageRoot, patterns ?? [], resourceType, target, metadata);
			} else if (patterns !== undefined) {
				applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
			} else {
				collectDefaultResources(packageRoot, resourceType, target, metadata);
			}
		}
		return true;
	}

	const manifest = readMetisManifest(packageRoot);
	if (manifest) {
		for (const resourceType of RESOURCE_TYPES) {
			const entries = manifest[resourceType as keyof MetisManifest];
			addManifestEntries(entries, packageRoot, resourceType, getTargetMap(accumulator, resourceType), metadata);
		}
		return true;
	}

	let hasAnyDir = false;
	for (const resourceType of RESOURCE_TYPES) {
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			// Collect all files from the directory (all enabled by default)
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				addResource(getTargetMap(accumulator, resourceType), f, metadata, true);
			}
			hasAnyDir = true;
		}
	}
	return hasAnyDir;
}

function collectDefaultResources(
	packageRoot: string,
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
): void {
	const manifest = readMetisManifest(packageRoot);
	const entries = manifest?.[resourceType as keyof MetisManifest];
	if (entries) {
		addManifestEntries(entries, packageRoot, resourceType, target, metadata);
		return;
	}
	const dir = join(packageRoot, resourceType);
	if (existsSync(dir)) {
		// Collect all files from the directory (all enabled by default)
		const files = collectResourceFiles(dir, resourceType);
		for (const f of files) {
			addResource(target, f, metadata, true);
		}
	}
}

function applyPackageFilter(
	packageRoot: string,
	userPatterns: string[],
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
): void {
	const { allFiles } = collectManifestFiles(packageRoot, resourceType);

	if (userPatterns.length === 0) {
		// Empty array explicitly disables all resources of this type
		for (const f of allFiles) {
			addResource(target, f, metadata, false);
		}
		return;
	}

	// Apply user patterns
	const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

	for (const f of allFiles) {
		const enabled = enabledByUser.has(f);
		addResource(target, f, metadata, enabled);
	}
}

function applyPackageDeltaFilter(
	packageRoot: string,
	userPatterns: string[],
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
): void {
	if (userPatterns.length === 0) {
		return;
	}

	const { allFiles } = collectManifestFiles(packageRoot, resourceType);
	const enabledByUser = applyAutoloadDisabledPatterns(allFiles, userPatterns, packageRoot);
	for (const [filePath, enabled] of enabledByUser) {
		addResource(target, filePath, metadata, enabled);
	}
}

/**
 * Collect all files from a package for a resource type, applying manifest patterns.
 * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
 * that pass the manifest's own patterns.
 */
function collectManifestFiles(
	packageRoot: string,
	resourceType: ResourceType,
): { allFiles: string[]; enabledByManifest: Set<string> } {
	const manifest = readMetisManifest(packageRoot);
	const entries = manifest?.[resourceType as keyof MetisManifest];
	if (entries && entries.length > 0) {
		const allFiles = collectFilesFromManifestEntries(entries, packageRoot, resourceType);
		const manifestPatterns = entries.filter(isOverridePattern);
		const enabledByManifest =
			manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
		return { allFiles: Array.from(enabledByManifest), enabledByManifest };
	}

	const conventionDir = join(packageRoot, resourceType);
	if (!existsSync(conventionDir)) {
		return { allFiles: [], enabledByManifest: new Set() };
	}
	const allFiles = collectResourceFiles(conventionDir, resourceType);
	return { allFiles, enabledByManifest: new Set(allFiles) };
}

function readMetisManifest(packageRoot: string): MetisManifest | null {
	const packageJsonPath = join(packageRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		return null;
	}

	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as { metis?: MetisManifest };
		return pkg.metis ?? null;
	} catch {
		return null;
	}
}

function addManifestEntries(
	entries: string[] | undefined,
	root: string,
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
): void {
	if (!entries) return;

	const allFiles = collectFilesFromManifestEntries(entries, root, resourceType);
	const patterns = entries.filter(isOverridePattern);
	const enabledPaths = applyPatterns(allFiles, patterns, root);

	for (const f of allFiles) {
		if (enabledPaths.has(f)) {
			addResource(target, f, metadata, true);
		}
	}
}

function collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
	const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
	const resolved = sourceEntries.flatMap((entry) => {
		if (!hasGlobPattern(entry)) {
			return [resolve(root, entry)];
		}

		return globSync(entry, {
			cwd: root,
			absolute: true,
			dot: false,
			nodir: false,
		}).map((match) => resolve(match));
	});
	return collectFilesFromPaths(resolved, resourceType);
}

export function collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
	const files: string[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;

		try {
			const stats = statSync(p);
			if (stats.isFile()) {
				files.push(p);
			} else if (stats.isDirectory()) {
				files.push(...collectResourceFiles(p, resourceType));
			}
		} catch {
			// Ignore errors
		}
	}
	return files;
}
