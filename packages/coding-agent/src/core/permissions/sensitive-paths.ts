import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { canonicalizeActionPath, isPathInside, pathsIntersect } from "../../utils/paths.ts";

const SENSITIVE_DIRECTORY_NAMES = new Set([".ssh", ".aws", ".gnupg", ".kube", ".azure"]);
const SENSITIVE_FILE_NAMES = new Set([
	".git-credentials",
	".netrc",
	".npmrc",
	".pypirc",
	"auth.json",
	"credentials",
	"credentials.json",
]);
const COMMON_SENSITIVE_ENV_FILES = [
	".env",
	".env.local",
	".env.development",
	".env.development.local",
	".env.production",
	".env.production.local",
	".env.staging",
	".env.staging.local",
	".env.test",
	".env.test.local",
] as const;

function uniquePaths(paths: Iterable<string>): string[] {
	return [...new Set(paths)];
}

/** Fixed host-owned paths that require explicit sensitive-read authorization. */
export function getSensitiveFilesystemPaths(
	cwd: string,
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoots: readonly string[] = [cwd],
): string[] {
	const home = homedir();
	const workspaceEnvironmentFiles = workspaceRoots.flatMap((root) =>
		COMMON_SENSITIVE_ENV_FILES.map((name) => join(root, name)),
	);
	for (const root of workspaceRoots) {
		try {
			for (const name of readdirSync(root)) {
				const lower = name.toLowerCase();
				if (
					(lower === ".env" || lower.startsWith(".env.")) &&
					!lower.endsWith(".example") &&
					!lower.endsWith(".sample")
				) {
					workspaceEnvironmentFiles.push(join(root, name));
				}
			}
		} catch {
			// Fixed sensitive paths and direct sensitive-name checks still apply.
		}
	}
	const roots = [
		...Array.from(SENSITIVE_DIRECTORY_NAMES, (name) => join(home, name)),
		join(home, ".config", "gcloud"),
		join(home, ".config", "google-chrome"),
		join(home, ".config", "chromium"),
		join(home, ".config", "microsoft-edge"),
		join(home, ".docker", "config.json"),
		join(home, ".git-credentials"),
		join(home, ".local", "share", "keyrings"),
		join(home, ".mozilla", "firefox"),
		join(home, ".netrc"),
		join(home, ".npmrc"),
		join(home, ".metis", "agent", "auth.json"),
		join(home, ".arcmind", "agent", "auth.json"),
		...workspaceEnvironmentFiles,
	];
	if (process.platform === "darwin") {
		roots.push(
			"/Library/Keychains",
			join(home, "Library", "Application Support", "Chromium"),
			join(home, "Library", "Application Support", "Firefox"),
			join(home, "Library", "Application Support", "Google", "Chrome"),
			join(home, "Library", "Application Support", "Microsoft Edge"),
			join(home, "Library", "Keychains"),
			join(home, "Library", "Safari"),
		);
	}
	if (environment.APPDATA && isAbsolute(environment.APPDATA)) {
		roots.push(
			join(environment.APPDATA, "Microsoft", "Credentials"),
			join(environment.APPDATA, "Microsoft", "Vault"),
			join(environment.APPDATA, "Mozilla", "Firefox"),
		);
	}
	if (environment.LOCALAPPDATA && isAbsolute(environment.LOCALAPPDATA)) {
		roots.push(
			join(environment.LOCALAPPDATA, "Google", "Chrome", "User Data"),
			join(environment.LOCALAPPDATA, "Microsoft", "Credentials"),
			join(environment.LOCALAPPDATA, "Microsoft", "Edge", "User Data"),
			join(environment.LOCALAPPDATA, "Microsoft", "Vault"),
		);
	}
	return uniquePaths(roots.map((path) => canonicalizeActionPath(path, cwd)));
}

function hasSensitiveName(path: string): boolean {
	const lowerBase = basename(path).toLowerCase();
	const sampleEnvironmentFile =
		lowerBase.startsWith(".env") && (lowerBase.endsWith(".example") || lowerBase.endsWith(".sample"));
	if (!sampleEnvironmentFile && (lowerBase === ".env" || lowerBase.startsWith(".env."))) return true;
	if (SENSITIVE_FILE_NAMES.has(lowerBase)) return true;
	return path
		.split(/[\\/]+/u)
		.map((part) => part.toLowerCase())
		.some((part) => SENSITIVE_DIRECTORY_NAMES.has(part));
}

export function isSensitivePath(
	path: string,
	cwd: string,
	traversal: boolean,
	workspaceRoots: readonly string[],
): boolean {
	const target = canonicalizeActionPath(path, cwd);
	if (hasSensitiveName(target)) return true;
	return getSensitiveFilesystemPaths(cwd, process.env, workspaceRoots).some((sensitive) =>
		traversal ? existsSync(sensitive) && pathsIntersect(target, sensitive) : isPathInside(sensitive, target),
	);
}

export function bashReferencesSensitivePath(command: string): boolean {
	const normalized = command.toLowerCase().replaceAll("\\", "/");
	const environmentFiles = normalized.match(/(?:^|[\s"'=:/])\.env(?:\.[a-z0-9_.-]+)?/gu) ?? [];
	if (environmentFiles.some((value) => !value.endsWith(".example") && !value.endsWith(".sample"))) return true;
	return /(?:^|[\s"'=:/])(?:\.ssh|\.aws|\.gnupg|\.kube|\.azure)(?:\/|\b)|(?:^|[\s"'=:/])(?:\.git-credentials|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials(?:\.json)?)(?:\b|$)/u.test(
		normalized,
	);
}
