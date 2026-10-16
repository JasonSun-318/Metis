import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { normalizePath } from "./utils/paths.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Bun compiled binaries expose a virtual filesystem in import.meta.url
 * (`$bunfs`, `~BUN`, or `%7EBUN`).
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Resolve a Metis environment variable. */
export function getMetisEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[`METIS_${suffix}`];
}

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = getMetisEnv("PACKAGE_DIR");
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/** Get the bundled skills directory for source, npm, and compiled-binary layouts. */
export function getSkillsDir(): string {
	const packageDir = getPackageDir();
	if (isBunBinary) return join(packageDir, "skills");
	const sourceSkills = join(packageDir, "skills");
	return existsSync(sourceSkills) ? sourceSkills : join(packageDir, "dist", "skills");
}

/** Get the platform-specific bundled tools directory when one was packaged. */
export function getBundledToolsDir(): string | undefined {
	if (!["darwin", "linux", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
		return undefined;
	}
	const pair = `${process.platform}-${process.arch}`;
	const packageDir = getPackageDir().replace(/\.asar([\\/])/u, ".asar.unpacked$1");
	return [join(packageDir, "vendor", "tools", pair), join(packageDir, "dist", "vendor", "tools", pair)].find(
		existsSync,
	);
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

interface PackageJson {
	name?: string;
	version?: string;
	metisConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const appConfig = pkg.metisConfig;
const configuredAppName: string | undefined = appConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@metis/coding-agent";
export const APP_NAME: string = configuredAppName || "metis";
export const APP_TITLE: string = configuredAppName ? APP_NAME : "Metis";
export const CONFIG_DIR_NAME: string = appConfig?.configDir || ".metis";
export const VERSION: string = pkg.version || "0.0.0";

// ${APP_NAME}_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;
export function expandTildePath(path: string): string {
	return normalizePath(path);
}

/** Get the agent config directory (e.g., ~/.metis/agent/). */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Resolve the configured session-directory override. */
export function getSessionDirOverride(): string | undefined {
	const configured = process.env[ENV_SESSION_DIR];
	return configured ? expandTildePath(configured) : undefined;
}

/** Get the Metis project config directory. */
export function getProjectConfigDir(cwd: string): string {
	return join(resolve(cwd), CONFIG_DIR_NAME);
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to Metis-owned Chat workspaces. */
export function getWorkspacesDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "workspaces");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
