import { basename } from "node:path";
import { canonicalizeActionPath } from "../../utils/paths.ts";
import { curlImplicitConfigurationReason } from "./curl-implicit-config.ts";
import type { OptionScan, OptionSpec } from "./option-scanner.ts";
import type { ShellDisposition, ShellState, ShellValue } from "./shell-analysis.ts";
import type { NetworkEndpoint, PermissionEffect } from "./types.ts";

/**
 * Git and curl command semantics over the analyzer's fact-recording surface.
 * The control-flow traversal owns cwd/variable state and per-command fact
 * attribution; these functions only interpret one command's argv.
 */
export interface GitCurlAnalysisContext {
	readonly currentDirectory: string;
	mark(disposition: ShellDisposition, reason: string, complete?: boolean): void;
	addEffect(effect: PermissionEffect): void;
	addEndpoint(endpoint: NetworkEndpoint): void;
	addRead(value: ShellValue, state: ShellState, traversal: boolean): void;
	addWrite(value: ShellValue, state: ShellState, destructive?: boolean): void;
	resolveTarget(raw: string, state: ShellState, glob: boolean): string | undefined;
	scanOptions(args: readonly ShellValue[], spec: OptionSpec, numericShort?: boolean): OptionScan;
	gitImplicitConfigRisk(state: ShellState): string | undefined;
}

export function analyzeGitCommand(
	ctx: GitCurlAnalysisContext,
	args: readonly ShellValue[],
	state: ShellState,
): ShellState {
	return gitCommand(ctx, args, state);
}

function gitCommand(ctx: GitCurlAnalysisContext, args: readonly ShellValue[], state: ShellState): ShellState {
	let index = 0;
	let cwd = state;
	while (index < args.length) {
		const value = args[index]!;
		if (value.dynamic || value.text === undefined) {
			ctx.mark("user", "git argument is not statically known", false);
			return cwd;
		}
		const text = value.text;
		if (!text.startsWith("-")) break;
		if (text === "--") {
			index += 1;
			break;
		}
		if (text === "-C") {
			const target = args[index + 1];
			if (!target || target.dynamic || target.text === undefined || target.glob) {
				ctx.mark("user", "git -C target is not statically known", false);
				return cwd;
			}
			const resolved = ctx.resolveTarget(target.text, cwd, false);
			if (resolved === undefined) {
				ctx.mark("user", "git -C target has no determinate working directory", false);
				return cwd;
			}
			cwd = { cwd: canonicalizeActionPath(resolved, cwd.cwd ?? ctx.currentDirectory), vars: new Map(cwd.vars) };
			index += 2;
			continue;
		}
		if (["-c", "--config-env", "--exec-path", "--git-dir", "--namespace", "--work-tree"].includes(text)) {
			ctx.addEffect("unknown");
			ctx.mark("user", "git configuration or external helper injection requires review", false);
			index += text.startsWith("--") && text.includes("=") ? 1 : 2;
			continue;
		}
		if (text === "--no-pager" || text === "-P") {
			index += 1;
			continue;
		}
		if (text === "--paginate" || text === "-p" || text === "--bare" || text === "--help") {
			ctx.mark("user", "git pager or execution mode is not statically transparent", false);
			index += 1;
			continue;
		}
		if (
			[
				"--literal-pathspecs",
				"--glob-pathspecs",
				"--noglob-pathspecs",
				"--icase-pathspecs",
				"--no-replace-objects",
				"--no-optional-locks",
			].includes(text)
		) {
			index += 1;
			continue;
		}
		ctx.mark("user", `unsupported git global option: ${text}`, false);
		index += 1;
	}
	const subcommand = args[index];
	if (!subcommand || subcommand.dynamic || subcommand.text === undefined) {
		ctx.mark("user", "git subcommand is not statically known", false);
		return cwd;
	}
	const rest = args.slice(index + 1);
	return gitSubcommand(ctx, subcommand.text, rest, cwd);
}

function gitSubcommand(
	ctx: GitCurlAnalysisContext,
	subcommand: string,
	args: readonly ShellValue[],
	state: ShellState,
): ShellState {
	if (["status", "diff", "log", "show"].includes(subcommand)) {
		const implicitRisk = ctx.gitImplicitConfigRisk(state);
		if (implicitRisk) {
			ctx.addEffect("unknown");
			ctx.mark("user", implicitRisk, false);
			return state;
		}
	}
	if (subcommand === "status") return gitStatus(ctx, args, state);
	if (subcommand === "diff") return gitDiff(ctx, args, state);
	if (subcommand === "log" || subcommand === "show") return gitLog(ctx, args, state);
	if (["reset", "clean"].includes(subcommand)) {
		ctx.addEffect("destructive");
		ctx.mark("user", `git ${subcommand} is destructive`, false);
		return state;
	}
	if (["push", "publish"].includes(subcommand)) {
		// Preserve exact literal destinations for the manual grant. Unresolved
		// remotes/configuration keep this action incomplete and prevent a rule fast-path.
		for (const value of args) {
			if (value.dynamic || !value.text || !/^https?:\/\//iu.test(value.text)) continue;
			try {
				const url = new URL(value.text);
				ctx.addEndpoint({
					hostname: url.hostname,
					port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
				});
			} catch {
				/* Invalid destinations remain outside the grant. */
			}
		}
		ctx.addEffect("external-side-effect");
		ctx.mark("user", `git ${subcommand} has external side effects`, false);
		return state;
	}
	ctx.addEffect("unknown");
	ctx.mark("user", `git ${subcommand} is not a supported read-only subcommand`, false);
	return state;
}

function gitStatus(ctx: GitCurlAnalysisContext, args: readonly ShellValue[], state: ShellState): ShellState {
	const scan = ctx.scanOptions(args, {
		boolean: [
			"-b",
			"-s",
			"-v",
			"-z",
			"--ahead-behind",
			"--branch",
			"--column",
			"--long",
			"--no-ahead-behind",
			"--no-column",
			"--no-renames",
			"--renames",
			"--short",
			"--show-stash",
			"--verbose",
		],
		value: ["-u"],
		optionalValue: ["--find-renames", "--ignored", "--porcelain", "--untracked-files"],
	});
	if (!scan.ok) {
		ctx.mark("user", scan.reason ?? "git status arguments are not statically supported", false);
		return state;
	}
	for (const target of scan.positionals) ctx.addRead(target, state, false);
	return state;
}

function gitDiff(ctx: GitCurlAnalysisContext, args: readonly ShellValue[], state: ShellState): ShellState {
	const scan = ctx.scanOptions(args, {
		boolean: [
			"-R",
			"-U",
			"-a",
			"-b",
			"-c",
			"-q",
			"-w",
			"--binary",
			"--cached",
			"--check",
			"--color",
			"--dirstat",
			"--exit-code",
			"--full-index",
			"--ignore-all-space",
			"--ignore-blank-lines",
			"--ignore-case",
			"--ignore-space-at-eol",
			"--ignore-space-change",
			"--irreversible-delete",
			"--name-only",
			"--name-status",
			"--no-color",
			"--no-ext-diff",
			"--no-index",
			"--no-renames",
			"--no-textconv",
			"--numstat",
			"--patch",
			"--patience",
			"--quiet",
			"--raw",
			"--shortstat",
			"--staged",
			"--summary",
			"--text",
			"--word-diff",
		],
		value: [
			"-G",
			"-S",
			"--diff-filter",
			"--find-renames",
			"--output",
			"--src-prefix",
			"--dst-prefix",
			"--unified",
			"--word-diff-regex",
		],
		optionalValue: ["--stat"],
	});
	if (!scan.ok) {
		ctx.mark("user", scan.reason ?? "git diff arguments are not statically supported", false);
		return state;
	}
	for (const option of scan.options) {
		if (option.name === "--output" && option.value) ctx.addWrite(option.value, state);
		if (option.name === "--ext-diff" || option.name === "--textconv") {
			ctx.mark("user", "git external diff helpers are not statically analyzable", false);
		}
	}
	for (const target of scan.positionals) {
		if (!target.dynamic && target.text?.startsWith("-")) continue;
		ctx.addRead(target, state, false);
	}
	return state;
}

function gitLog(ctx: GitCurlAnalysisContext, args: readonly ShellValue[], state: ShellState): ShellState {
	let sawSeparator = false;
	const paths: ShellValue[] = [];
	const scan = ctx.scanOptions(args, {
		boolean: [
			"-p",
			"--all",
			"--branches",
			"--decorate",
			"--graph",
			"--name-only",
			"--name-status",
			"--oneline",
			"--stat",
			"--tags",
			"--no-color",
			"--no-decorate",
			"--no-patch",
			"--first-parent",
		],
		value: ["-n", "--author", "--format", "--grep", "--max-count", "--pretty", "--since", "--until", "--output"],
	});
	if (!scan.ok) {
		ctx.mark("user", scan.reason ?? "git log arguments are not statically supported", false);
		return state;
	}
	for (const option of scan.options) {
		if (option.name === "--output" && option.value) ctx.addWrite(option.value, state);
	}
	for (const target of scan.positionals) {
		if (!target.dynamic && target.text === "--") {
			sawSeparator = true;
			continue;
		}
		if (sawSeparator) paths.push(target);
	}
	for (const target of paths) ctx.addRead(target, state, false);
	return state;
}

export function analyzeCurlCommand(
	ctx: GitCurlAnalysisContext,
	args: readonly ShellValue[],
	state: ShellState,
): ShellState {
	return curlCommand(ctx, args, state);
}

function curlCommand(ctx: GitCurlAnalysisContext, args: readonly ShellValue[], state: ShellState): ShellState {
	const implicitRisk = curlImplicitConfigurationReason(args.map((value) => (value.dynamic ? "" : (value.text ?? ""))));
	if (implicitRisk) {
		ctx.addEffect("unknown");
		ctx.mark("user", implicitRisk, false);
	}
	const scan = ctx.scanOptions(args, {
		boolean: [
			"-4",
			"-6",
			"-G",
			"-I",
			"-J",
			"-L",
			"-N",
			"-O",
			"-S",
			"-f",
			"-g",
			"-i",
			"-k",
			"-n",
			"-q",
			"-s",
			"-v",
			"--compressed",
			"--fail",
			"--globoff",
			"--head",
			"--http1.0",
			"--http1.1",
			"--http2",
			"--insecure",
			"--ipv4",
			"--ipv6",
			"--location",
			"--location-trusted",
			"--netrc",
			"--no-buffer",
			"--no-progress-meter",
			"--progress-meter",
			"--remote-header-name",
			"--remote-name",
			"--remote-name-all",
			"--show-error",
			"--silent",
			"--verbose",
		],
		value: [
			"-A",
			"-D",
			"-E",
			"-H",
			"-K",
			"-T",
			"-U",
			"-X",
			"-b",
			"-c",
			"-d",
			"-e",
			"-m",
			"-o",
			"-r",
			"-u",
			"-w",
			"-x",
			"--cacert",
			"--capath",
			"--cert",
			"--ciphers",
			"--config",
			"--connect-timeout",
			"--connect-to",
			"--cookie",
			"--cookie-jar",
			"--data",
			"--data-ascii",
			"--data-binary",
			"--data-raw",
			"--data-urlencode",
			"--dump-header",
			"--form",
			"--header",
			"--interface",
			"--json",
			"--key",
			"--limit-rate",
			"--max-filesize",
			"--max-time",
			"--netrc-file",
			"--output",
			"--output-dir",
			"--pass",
			"--preproxy",
			"--proto",
			"--proto-redir",
			"--proxy",
			"--proxy-user",
			"--range",
			"--referer",
			"--request",
			"--resolve",
			"--retry",
			"--retry-delay",
			"--retry-max-time",
			"--socks4",
			"--socks4a",
			"--socks5",
			"--socks5-hostname",
			"--tls-max",
			"--upload-file",
			"--url",
			"--user",
			"--user-agent",
			"--write-out",
		],
	});
	if (!scan.ok) {
		// The request itself reaches an external service and its arguments
		// cannot be proven read-only, so keep the mutation effect.
		ctx.addEffect("external-side-effect");
		ctx.mark("user", scan.reason ?? "curl arguments are not statically supported", false);
		return state;
	}
	const qIndex = args.findIndex((value) => !value.dynamic && value.text === "-q");
	if (qIndex > 0) {
		ctx.mark("user", "curl -q is only meaningful as the first argument", false);
	}
	let hasEndpoint = false;
	const urls: { readonly value: ShellValue; readonly option: string }[] = [];
	for (const option of scan.options) {
		if (option.name === "-q") continue;
		if (["-K", "--config"].includes(option.name)) {
			ctx.addEffect("external-side-effect");
			ctx.mark("user", "curl configuration files change request semantics", false);
			continue;
		}
		if (["-X", "--request"].includes(option.name)) {
			const method = (option.value?.text ?? "").toUpperCase();
			if (!["GET", "HEAD"].includes(method)) {
				ctx.addEffect("external-side-effect");
				ctx.mark("user", "curl request methods beyond GET or HEAD mutate remote state", true);
			}
			continue;
		}
		if (
			[
				"-d",
				"--data",
				"--data-ascii",
				"--data-binary",
				"--data-raw",
				"--data-urlencode",
				"-F",
				"--form",
				"-T",
				"--upload-file",
				"--json",
			].includes(option.name)
		) {
			ctx.addEffect("external-side-effect");
			ctx.mark("user", "curl uploads or sends a request body", true);
			continue;
		}
		if (
			["-x", "--proxy", "--preproxy", "--socks4", "--socks4a", "--socks5", "--socks5-hostname"].includes(option.name)
		) {
			ctx.mark("user", "curl proxy routing is not authorized by the request itself", true);
			continue;
		}
		if (["-k", "--insecure"].includes(option.name)) {
			ctx.addEffect("security-weakening");
			ctx.mark("user", "curl TLS verification bypass requires review", true);
			continue;
		}
		if (["-n", "--netrc", "--netrc-file"].includes(option.name)) {
			ctx.addEffect("sensitive-read");
			ctx.mark("user", "curl netrc credentials require review", true);
			continue;
		}
		if (option.name === "--location-trusted") {
			ctx.addEffect("external-side-effect");
			ctx.mark("user", "curl --location-trusted forwards credentials", true);
			continue;
		}
		if (["-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar"].includes(option.name)) {
			if (option.value) ctx.addWrite(option.value, state);
			continue;
		}
		if (option.name === "--output-dir") {
			ctx.mark("user", "curl --output-dir requires an explicit output review", true);
			continue;
		}
		if (option.name === "--url" && option.value) {
			urls.push({ value: option.value, option: option.name });
		}
	}
	for (const positional of scan.positionals) urls.push({ value: positional, option: "positional" });
	for (const entry of urls) {
		if (entry.value.dynamic || entry.value.text === undefined) {
			ctx.mark("user", "curl URL is not statically known", false);
			return state;
		}
		let url: URL;
		try {
			url = new URL(entry.value.text);
		} catch {
			ctx.mark("user", "curl URL is not a valid absolute URL", false);
			return state;
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
			ctx.mark("user", "curl URL must be a plain HTTP or HTTPS URL", false);
			return state;
		}
		const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			ctx.mark("user", "curl URL port is invalid", false);
			return state;
		}
		const endpoint = { hostname: url.hostname, port };
		ctx.addEndpoint(endpoint);
		hasEndpoint = true;
		const remoteName = scan.options.some((option) =>
			["-O", "--remote-name", "--remote-name-all"].includes(option.name),
		);
		if (remoteName || scan.options.some((option) => ["-J", "--remote-header-name"].includes(option.name))) {
			const name = basename(url.pathname) || "index.html";
			ctx.addWrite({ text: name, dynamic: false, glob: false }, state);
		}
	}
	if (urls.length === 0 || !hasEndpoint) {
		ctx.mark("user", "curl requires at least one statically known HTTP URL", false);
	}
	return state;
}
