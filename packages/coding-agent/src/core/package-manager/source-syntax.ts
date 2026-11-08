import { relative } from "path";
import { valid, validRange } from "semver";
import { parseGitUrl } from "../../utils/git.ts";
import { isLocalPath } from "../../utils/paths.ts";
import type { ParsedSource, SourceScope } from "../package-manager.ts";
import type { PackageSource } from "../settings-manager.ts";

export interface SourcePathHelpers {
	resolvePath(input: string): string;
	resolvePathFromBase(input: string, baseDir: string): string;
	getBaseDirForScope(scope: SourceScope): string;
}

export function isExactNpmVersion(version: string | undefined): boolean {
	return valid(version ?? "") !== null;
}

export function getNpmVersionRange(version: string | undefined): string | undefined {
	return version ? (validRange(version) ?? undefined) : undefined;
}

export function parseNpmSpec(spec: string): { name: string; version?: string } {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	if (!match) {
		return { name: spec };
	}
	const name = match[1] ?? spec;
	const version = match[2];
	return { name, version };
}

export function parseSource(source: string): ParsedSource {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length).trim();
		const { name, version } = parseNpmSpec(spec);
		return {
			type: "npm",
			spec,
			name,
			version,
			range: getNpmVersionRange(version),
			pinned: isExactNpmVersion(version),
		};
	}

	if (isLocalPath(source)) {
		return { type: "local", path: source };
	}

	// Try parsing as git URL
	const gitParsed = parseGitUrl(source);
	if (gitParsed) {
		return gitParsed;
	}

	return { type: "local", path: source };
}

export function getPackageSourceString(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

export function getSourceMatchKeyForInput(source: string, helpers: SourcePathHelpers): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	return `local:${helpers.resolvePath(parsed.path)}`;
}

export function getSourceMatchKeyForSettings(source: string, scope: SourceScope, helpers: SourcePathHelpers): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	const baseDir = helpers.getBaseDirForScope(scope);
	return `local:${helpers.resolvePathFromBase(parsed.path, baseDir)}`;
}

export function buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
	const suggestion = findSuggestedConfiguredSource(source, configuredPackages);
	if (!suggestion) {
		return `No matching package found for ${source}`;
	}
	return `No matching package found for ${source}. Did you mean ${suggestion}?`;
}

export function findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
	const trimmedSource = source.trim();
	const suggestions = new Set<string>();

	for (const pkg of configuredPackages) {
		const sourceStr = getPackageSourceString(pkg);
		const parsed = parseSource(sourceStr);
		if (parsed.type === "npm") {
			if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
				suggestions.add(sourceStr);
			}
			continue;
		}
		if (parsed.type === "git") {
			const shorthand = `${parsed.host}/${parsed.path}`;
			const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
			if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
				suggestions.add(sourceStr);
			}
		}
	}

	return suggestions.values().next().value;
}

export function packageSourcesMatch(
	existing: PackageSource,
	inputSource: string,
	scope: SourceScope,
	helpers: SourcePathHelpers,
): boolean {
	const left = getSourceMatchKeyForSettings(getPackageSourceString(existing), scope, helpers);
	const right = getSourceMatchKeyForInput(inputSource, helpers);
	return left === right;
}

export function normalizePackageSourceForSettings(
	source: string,
	scope: SourceScope,
	helpers: SourcePathHelpers,
): string {
	const parsed = parseSource(source);
	if (parsed.type !== "local") {
		return source;
	}
	const baseDir = helpers.getBaseDirForScope(scope);
	const resolved = helpers.resolvePath(parsed.path);
	const rel = relative(baseDir, resolved);
	return rel || ".";
}
