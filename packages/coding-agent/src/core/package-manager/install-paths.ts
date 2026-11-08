import { join, resolve, sep } from "path";
import { getProjectConfigDir } from "../../config.ts";
import type { GitSource } from "../../utils/git.ts";
import type { NpmSource, SourceScope } from "../package-manager.ts";

/** Path layout for package install roots, managed paths and temporary dirs. */
export interface InstallPathContext {
	readonly cwd: string;
	readonly agentDir: string;
	assertProjectTrusted(scope: SourceScope): void;
}

export function resolveManagedPath(root: string, ...parts: string[]): string {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, ...parts);
	if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
		throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
	}
	return resolvedPath;
}

export function getBaseDirForScope(scope: SourceScope, context: InstallPathContext): string {
	if (scope === "project") {
		context.assertProjectTrusted(scope);
		return getProjectConfigDir(context.cwd);
	}
	if (scope === "user") {
		return context.agentDir;
	}
	return context.cwd;
}

export function getNpmInstallRoot(
	scope: SourceScope,
	temporary: boolean,
	temporaryDir: (prefix: string, suffix?: string) => string,
	context: InstallPathContext,
): string {
	if (temporary) {
		return temporaryDir("npm");
	}
	if (scope === "project") {
		context.assertProjectTrusted(scope);
		return join(getProjectConfigDir(context.cwd), "npm");
	}
	return join(context.agentDir, "npm");
}

export function getManagedNpmInstallPath(
	source: NpmSource,
	scope: SourceScope,
	temporaryDir: (prefix: string, suffix?: string) => string,
	context: InstallPathContext,
): string {
	if (scope === "temporary") {
		return join(temporaryDir("npm"), "node_modules", source.name);
	}
	if (scope === "project") {
		context.assertProjectTrusted(scope);
		return join(getProjectConfigDir(context.cwd), "npm", "node_modules", source.name);
	}
	return join(context.agentDir, "npm", "node_modules", source.name);
}

export function getGitInstallRoot(scope: SourceScope, context: InstallPathContext): string | undefined {
	if (scope === "temporary") {
		return undefined;
	}
	if (scope === "project") {
		context.assertProjectTrusted(scope);
		return join(getProjectConfigDir(context.cwd), "git");
	}
	return join(context.agentDir, "git");
}

export function getGitInstallPath(
	source: GitSource,
	scope: SourceScope,
	temporaryDir: (prefix: string, suffix?: string) => string,
	context: InstallPathContext,
): string {
	if (scope === "temporary") {
		return temporaryDir(`git-${source.host}`, source.path);
	}
	const installRoot = getGitInstallRoot(scope, context);
	if (!installRoot) {
		throw new Error("Missing git install root");
	}
	return resolveManagedPath(installRoot, source.host, source.path);
}
