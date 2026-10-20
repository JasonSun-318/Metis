import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ignore from "ignore";
import { addIgnoreRules } from "../ignore-rules.ts";
import { toPosixPath } from "./resource-patterns.ts";

export interface MetisManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

type IgnoreMatcher = ReturnType<typeof ignore>;

function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

type SkillDiscoveryMode = "metis" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (mode === "metis" && dir === root && isFile && entry.name.endsWith(".md") && !ig.ignores(relPath)) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

export function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

export function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

function collectAutoFileEntries(dir: string, extension: ".md" | ".json"): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(extension)) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

export function collectAutoPromptEntries(dir: string): string[] {
	return collectAutoFileEntries(dir, ".md");
}

export function collectAutoThemeEntries(dir: string): string[] {
	return collectAutoFileEntries(dir, ".json");
}

function readMetisManifestFile(packageJsonPath: string): MetisManifest | null {
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as { metis?: MetisManifest };
		return pkg.metis ?? null;
	} catch {
		return null;
	}
}

function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readMetisManifestFile(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

export function collectAutoExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
			} else if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
export function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "metis");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}
