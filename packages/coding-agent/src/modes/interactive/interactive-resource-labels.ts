import * as path from "node:path";
import type { SourceInfo } from "../../core/source-info.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";

/**
 * Private, side-effect-free resource path and label formatting.
 *
 * Home directory reads are injected as a callback so callers keep the exact
 * read timing of the original InteractiveMode methods: paths that never needed
 * the home directory still do not read it.
 */

export function formatDisplayPath(p: string, home: () => string): string {
	const homeDir = home();
	let result = p;

	// Replace home directory with ~
	if (result.startsWith(homeDir)) {
		result = `~${result.slice(homeDir.length)}`;
	}

	return result;
}

export function formatExtensionDisplayPath(resourcePath: string, home: () => string): string {
	let result = formatDisplayPath(resourcePath, home);
	result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
	return result;
}

export function formatContextPath(p: string, cwd: string, home: () => string): string {
	const resolvedCwd = path.resolve(cwd);
	const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(resolvedCwd, p);
	const relativePath = getCwdRelativePath(absolutePath, resolvedCwd);
	if (relativePath !== undefined) {
		return relativePath;
	}

	return formatDisplayPath(absolutePath, home);
}

export function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

/**
 * Get a short path relative to the package root for display.
 */
export function getShortPath(fullPath: string, sourceInfo: SourceInfo | undefined, home: () => string): string {
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}

	const source = sourceInfo?.source ?? "";
	const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && source.startsWith("npm:")) {
		return npmMatch[2];
	}

	const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && source.startsWith("git:")) {
		return gitMatch[1];
	}

	return formatDisplayPath(fullPath, home);
}

export function getCompactPathLabel(
	resourcePath: string,
	sourceInfo: SourceInfo | undefined,
	home: () => string,
): string {
	const shortPath = getShortPath(resourcePath, sourceInfo, home);
	const normalizedPath = shortPath.replace(/\\/g, "/");
	const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
	if (segments.length > 0) {
		return segments[segments.length - 1];
	}
	return shortPath;
}

function getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) {
		return source.slice("npm:".length) || source;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		return gitSource.path || source;
	}

	return source;
}

function getCompactExtensionLabel(
	resourcePath: string,
	sourceInfo: SourceInfo | undefined,
	home: () => string,
): string {
	if (!isPackageSource(sourceInfo)) {
		return getCompactPathLabel(resourcePath, sourceInfo, home);
	}

	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) {
		return getCompactPathLabel(resourcePath, sourceInfo, home);
	}

	const shortPath = getShortPath(resourcePath, sourceInfo, home).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const parsedPath = path.posix.parse(packagePath);

	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}

	return `${sourceLabel}:${packagePath}`;
}

function getCompactDisplayPathSegments(resourcePath: string, home: () => string): string[] {
	return formatDisplayPath(resourcePath, home)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

function getCompactNonPackageExtensionLabel(
	resourcePath: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
	home: () => string,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) {
		return getCompactPathLabel(resourcePath, undefined, home);
	}

	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		const isUnique = allPaths.every((item, itemIndex) => {
			if (itemIndex === index) {
				return true;
			}
			return item.segments.slice(-segmentCount).join("/") !== candidate;
		});

		if (isUnique) {
			return candidate;
		}
	}

	return segments.join("/");
}

export function getCompactExtensionLabels(
	extensions: Array<{ path: string; sourceInfo?: SourceInfo }>,
	home: () => string,
): string[] {
	const nonPackageExtensions = extensions
		.map((extension) => {
			const segments = getCompactDisplayPathSegments(extension.path, home);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
				segments.pop();
			}
			return {
				path: extension.path,
				sourceInfo: extension.sourceInfo,
				segments,
			};
		})
		.filter((extension) => !isPackageSource(extension.sourceInfo));

	return extensions.map((extension) => {
		if (isPackageSource(extension.sourceInfo)) {
			return getCompactExtensionLabel(extension.path, extension.sourceInfo, home);
		}

		const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
		if (nonPackageIndex === -1) {
			return getCompactPathLabel(extension.path, extension.sourceInfo, home);
		}

		return getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions, home);
	});
}
