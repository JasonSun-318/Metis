import { canonicalizePath } from "../../utils/paths.ts";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../package-manager.ts";
import type { ResourceType } from "./resource-discovery.ts";

export interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

export function getTargetMap(
	accumulator: ResourceAccumulator,
	resourceType: ResourceType,
): Map<string, { metadata: PathMetadata; enabled: boolean }> {
	switch (resourceType) {
		case "extensions":
			return accumulator.extensions;
		case "skills":
			return accumulator.skills;
		case "prompts":
			return accumulator.prompts;
		case "themes":
			return accumulator.themes;
		default:
			throw new Error(`Unknown resource type: ${resourceType}`);
	}
}

export function addResource(
	map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	path: string,
	metadata: PathMetadata,
	enabled: boolean,
): void {
	if (!path) return;
	if (!map.has(path)) {
		map.set(path, { metadata, enabled });
	}
}

export function createAccumulator(): ResourceAccumulator {
	return {
		extensions: new Map(),
		skills: new Map(),
		prompts: new Map(),
		themes: new Map(),
	};
}

export function toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
	const mapToResolved = (entries: Map<string, { metadata: PathMetadata; enabled: boolean }>): ResolvedResource[] => {
		const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
			path,
			enabled,
			metadata,
		}));
		resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

		const seen = new Set<string>();
		return resolved.filter((entry) => {
			const canonicalPath = canonicalizePath(entry.path);
			if (seen.has(canonicalPath)) return false;
			seen.add(canonicalPath);
			return true;
		});
	};

	return {
		extensions: mapToResolved(accumulator.extensions),
		skills: mapToResolved(accumulator.skills),
		prompts: mapToResolved(accumulator.prompts),
		themes: mapToResolved(accumulator.themes),
	};
}
