import type { PathMetadata } from "./package-manager.ts";
import type { PluginOwner } from "./plugins/types.ts";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
	/** Canonical package/server/source identity, separate from the user-facing path. */
	sourceIdentity?: string;
	/** Digest/version of the executable source, used only for stable permission identity. */
	implementationVersion?: string;
	pluginOwner?: PluginOwner;
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
		sourceIdentity?: string;
		implementationVersion?: string;
		pluginOwner?: PluginOwner;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
		sourceIdentity: options.sourceIdentity,
		implementationVersion: options.implementationVersion,
		pluginOwner: options.pluginOwner,
	};
}
