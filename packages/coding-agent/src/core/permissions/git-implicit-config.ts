import { closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MAX_GIT_CONFIG_BYTES } from "./limits.ts";

/**
 * Read-only inspection of Git configuration that can make read-only
 * subcommands execute project-configured helpers. `git status` starts
 * core.fsmonitor and `git diff`/`git show` run textconv and external diff
 * drivers, so a repo (or global config) that configures them must not be
 * auto-approved as read-only from static command text alone.
 *
 * The reader is intentionally conservative: include directives, unrecognized
 * syntax, oversized files, unreadable files (which Git may still be able to
 * read), and environment overrides of the configuration sources all produce a
 * reason instead of a clean result. Pagers are deliberately not a risk: the
 * bash tool always runs commands with piped stdio, so pagers never execute.
 */

const ENV_OVERRIDE_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_EXTERNAL_DIFF",
	"GIT_EXEC_PATH",
] as const;

type ConfigRead =
	| { readonly state: "missing" }
	| { readonly state: "unreadable"; readonly path: string }
	| { readonly state: "oversized"; readonly path: string }
	| { readonly state: "text"; readonly text: string };

function readConfig(path: string, deadline: number): ConfigRead {
	if (Date.now() > deadline) return { state: "unreadable", path };
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) return { state: "unreadable", path };
		if (stat.size > MAX_GIT_CONFIG_BYTES) return { state: "oversized", path };
		const buffer = Buffer.alloc(MAX_GIT_CONFIG_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			if (Date.now() > deadline) return { state: "unreadable", path };
			const count = readSync(descriptor, buffer, length, buffer.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > MAX_GIT_CONFIG_BYTES) return { state: "oversized", path };
		return { state: "text", text: buffer.subarray(0, length).toString("utf8") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
		return { state: "unreadable", path };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function riskyConfigReasons(path: string, text: string): readonly string[] {
	const reasons: string[] = [];
	let section: string | undefined;
	let subsection = "";
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const sectionMatch = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]\s*$/u.exec(line);
		if (sectionMatch) {
			section = sectionMatch[1]!.toLowerCase();
			subsection = sectionMatch[2]?.replace(/\\(.)/gu, "$1") ?? "";
			if (section === "include" || section === "includeif") {
				// Included files add arbitrary extra configuration that this
				// reader does not resolve, so the source can never be clean.
				reasons.push(`${path}: [${section}] directives are not resolved`);
			}
			continue;
		}
		if (section === undefined) {
			reasons.push(`${path}: unrecognized configuration syntax`);
			continue;
		}
		const entryMatch = /^([A-Za-z0-9.-]+)\s*=\s*(.*)$/u.exec(line) ?? /^([A-Za-z0-9.-]+)\s*$/u.exec(line);
		if (!entryMatch) {
			reasons.push(`${path}: unrecognized configuration syntax`);
			continue;
		}
		const name = entryMatch[1]!.toLowerCase();
		const key = `${section}${subsection ? `.${subsection}` : ""}.${name}`;
		const value = (entryMatch[2] ?? "").trim().replace(/^["']|["']$/gu, "");
		if (section === "core" && name === "fsmonitor" && value !== "false") {
			reasons.push(`${path}: ${key}`);
			continue;
		}
		if (section === "diff" && ["external", "textconv", "command", "difffilter"].includes(name)) {
			reasons.push(`${path}: ${key}`);
			continue;
		}
		if (section === "interactive" && name === "difffilter") {
			reasons.push(`${path}: ${key}`);
		}
	}
	return reasons;
}

function collectFileReasons(path: string, deadline: number, reasons: string[]): void {
	const read = readConfig(path, deadline);
	if (read.state === "missing") return;
	if (read.state === "unreadable") {
		reasons.push(`${read.path} is not readable`);
		return;
	}
	if (read.state === "oversized") {
		reasons.push(`${read.path} exceeds the configuration size limit`);
		return;
	}
	reasons.push(...riskyConfigReasons(path, read.text));
}

function repoConfigPaths(directory: string, deadline: number, reasons: string[]): readonly string[] {
	const gitEntry = join(directory, ".git");
	let gitdir: string;
	try {
		const stat = statSync(gitEntry);
		if (stat.isDirectory()) gitdir = gitEntry;
		else {
			const pointer = readConfig(gitEntry, deadline);
			const match = pointer.state === "text" ? /^gitdir:\s*(.+)\s*$/u.exec(pointer.text) : undefined;
			if (!match) {
				reasons.push("repository Git directory pointer is not completely known");
				return [];
			}
			gitdir = isAbsolute(match[1]!) ? match[1]! : resolve(directory, match[1]!);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			reasons.push("repository Git directory cannot be inspected");
		return [];
	}
	let commonConfig = join(gitdir, "config");
	const common = readConfig(join(gitdir, "commondir"), deadline);
	if (common.state === "text") {
		const commonDirectory = common.text.trim();
		if (!commonDirectory || commonDirectory.includes("\n") || commonDirectory.includes("\0"))
			reasons.push("Git common directory is invalid");
		else commonConfig = join(resolve(gitdir, commonDirectory), "config");
	} else if (common.state !== "missing") reasons.push("Git common directory cannot be inspected");
	// Keep missing and unreadable distinct when each candidate is read below.
	return [commonConfig, join(gitdir, "config.worktree")];
}

function globalConfigPaths(): readonly string[] {
	const home = homedir();
	const paths = [join(home, ".gitconfig"), join(home, ".config", "git", "config"), "/etc/gitconfig"];
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) paths.unshift(join(xdg, "git", "config"));
	return paths;
}

/**
 * Reasons why a Git command running in `cwd` could execute project- or
 * user-configured helpers. An empty list only means every inspected source is
 * provably clean; any include directive, unrecognized syntax, unreadable or
 * oversized file, or environment override produces a reason instead.
 */
export function gitImplicitExecutionReasons(cwd: string, deadline: number = Date.now() + 50): readonly string[] {
	const reasons: string[] = [];
	const env = process.env;
	for (const name of ENV_OVERRIDE_VARS) {
		if (env[name] !== undefined) reasons.push(`${name} overrides git configuration sources`);
	}
	if (env.GIT_CONFIG_COUNT !== undefined && Number(env.GIT_CONFIG_COUNT) > 0) {
		reasons.push("GIT_CONFIG_COUNT declares extra git configuration");
	}
	for (const name of Object.keys(env)) {
		if (name.startsWith("GIT_CONFIG_KEY_") || name.startsWith("GIT_CONFIG_VALUE_")) {
			reasons.push(`${name} overrides git configuration sources`);
		}
	}

	if (Date.now() > deadline) {
		reasons.push("git configuration inspection exceeded its deadline");
		return [...new Set(reasons)];
	}

	let directory = resolve(cwd);
	// Walk up like Git resolves the repository, bounded by the filesystem root.
	for (let depth = 0; depth < 64; depth += 1) {
		if (Date.now() > deadline) {
			reasons.push("git configuration inspection exceeded its deadline");
			break;
		}
		const configs = repoConfigPaths(directory, deadline, reasons);
		if (configs.length > 0 || existsSync(join(directory, ".git"))) {
			for (const config of configs) collectFileReasons(config, deadline, reasons);
			break;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}

	const nosystem = env.GIT_CONFIG_NOSYSTEM;
	const skipSystem = nosystem !== undefined && /^(?:true|1|yes)$/iu.test(nosystem);
	for (const path of globalConfigPaths()) {
		if (skipSystem && path === "/etc/gitconfig") continue;
		collectFileReasons(path, deadline, reasons);
	}
	const globalOverride = env.GIT_CONFIG_GLOBAL;
	if (globalOverride) collectFileReasons(globalOverride, deadline, reasons);
	const systemOverride = env.GIT_CONFIG_SYSTEM;
	if (systemOverride) collectFileReasons(systemOverride, deadline, reasons);
	return [...new Set(reasons)];
}
