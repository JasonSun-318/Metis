import { accessSync, constants, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeActionPath, isPathInside } from "../../utils/paths.ts";
import type { ActionRisk, NetworkTarget, PermissionAction, ToolProvenance } from "./approval.ts";
import { bashReferencesSensitivePath, isSensitivePath } from "./sensitive-paths.ts";

export type { ActionRisk, NetworkTarget, PermissionAction, ToolProvenance } from "./approval.ts";

export interface ClassifyActionInput {
	readonly actionId: string;
	readonly toolName: string;
	readonly provenance: ToolProvenance;
	readonly args: unknown;
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly readOnlyRoots?: readonly string[];
	readonly mcpAnnotations?: {
		readonly readOnlyHint?: boolean;
		readonly destructiveHint?: boolean;
	};
	readonly builtinNetworkTargets?: readonly NetworkTarget[];
}

const RISK_ORDER: readonly ActionRisk[] = [
	"ordinary-read",
	"outside-read",
	"sensitive-read",
	"workspace-write",
	"outside-write",
	"shell",
	"destructive",
	"network",
	"elevation",
	"external-side-effect",
	"custom",
	"unknown",
];

const STRUCTURED_READ_TOOLS = new Set(["read", "grep", "find", "ls", "describe_image"]);
const STRUCTURED_WRITE_TOOLS = new Set(["write", "edit"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function uniqueRisks(risks: Iterable<ActionRisk>): ActionRisk[] {
	const values = new Set(risks);
	return RISK_ORDER.filter((risk) => values.has(risk));
}

function uniquePaths(paths: Iterable<string>): string[] {
	return [...new Set(paths)];
}

function isInsideWorkspaceRoots(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => isPathInside(root, path));
}

function normalizePaths(rawPaths: readonly string[], cwd: string): { paths: string[]; invalid: boolean } {
	const paths: string[] = [];
	try {
		for (const path of rawPaths) {
			if (!path || path.includes("\0")) return { paths, invalid: true };
			paths.push(canonicalizeActionPath(path, cwd));
		}
		return { paths: uniquePaths(paths), invalid: false };
	} catch {
		return { paths, invalid: true };
	}
}

function isOrdinaryFilesystemObject(path: string): boolean {
	try {
		const value = statSync(path);
		if (!value.isFile() && !value.isDirectory()) return false;
		accessSync(path, constants.R_OK | (value.isDirectory() ? constants.X_OK : 0));
		return true;
	} catch {
		return false;
	}
}

function action(
	input: ClassifyActionInput,
	risks: Iterable<ActionRisk>,
	paths: readonly string[] = [],
	command?: string,
	networkTargets: readonly NetworkTarget[] = [],
): PermissionAction {
	const normalizedRisks = uniqueRisks(risks);
	return {
		actionId: input.actionId,
		toolName: input.toolName,
		provenance: input.provenance,
		risks: normalizedRisks.length > 0 ? normalizedRisks : ["unknown"],
		paths: uniquePaths(paths),
		networkTargets: [...networkTargets],
		...(command === undefined ? {} : { command }),
	};
}

export function unclassifiedAction(input: ClassifyActionInput): PermissionAction {
	const args = record(input.args);
	return action(
		input,
		input.toolName === "bash" ? ["shell"] : ["unknown"],
		[],
		input.toolName === "bash" && typeof args?.command === "string" ? args.command : undefined,
		input.builtinNetworkTargets,
	);
}

function classifyStructuredRead(input: ClassifyActionInput, rawPath: string, traversal: boolean): PermissionAction {
	const normalized = normalizePaths([rawPath], input.cwd);
	if (normalized.invalid || normalized.paths.length !== 1 || !isOrdinaryFilesystemObject(normalized.paths[0]!)) {
		return action(input, ["unknown"], normalized.paths);
	}
	return action(
		input,
		isSensitivePath(normalized.paths[0]!, input.cwd, traversal, input.workspaceRoots)
			? ["sensitive-read"]
			: isInsideWorkspaceRoots(normalized.paths[0]!, [...input.workspaceRoots, ...(input.readOnlyRoots ?? [])])
				? ["ordinary-read"]
				: ["outside-read"],
		normalized.paths,
	);
}

function classifyStructuredWrite(input: ClassifyActionInput, rawPath: string): PermissionAction {
	const normalized = normalizePaths([rawPath], input.cwd);
	if (normalized.invalid || normalized.paths.length !== 1) return action(input, ["unknown"], normalized.paths);
	return action(
		input,
		isInsideWorkspaceRoots(normalized.paths[0]!, input.workspaceRoots) ? ["workspace-write"] : ["outside-write"],
		normalized.paths,
	);
}

function isOpaqueBashExecution(command: string): boolean {
	return (
		/(?:^|[;&|]\s*)(?:\.{1,2}[/\\]|(?:bash|sh|zsh|fish|pwsh|powershell|cmd)(?:\.exe)?\b)/iu.test(command) ||
		/\b(?:node|nodejs|deno|python\d*|pypy\d*|perl|ruby|php|lua|osascript)\b[^\n]*(?:\s(?:-[ceEr]|--eval|--print|--input-type)(?:\s|=)|<<)/iu.test(
			command,
		) ||
		/(?:^|[;&|]\s*)(?:eval|source)\b|(?:^|[;&|]\s*)\.\s+|\$\(|`|\$'|\\(?:x[\da-f]{2}|u[\da-f]{4}|u\{[\da-f]+\})/iu.test(
			command,
		)
	);
}

function classifyBash(input: ClassifyActionInput, command: string): PermissionAction {
	const risks: ActionRisk[] = ["shell"];
	if (bashReferencesSensitivePath(command)) risks.push("sensitive-read");
	if (isOpaqueBashExecution(command)) risks.push("unknown");
	if (
		/\b(?:rm|rmdir|shred|truncate|dd|mkfs|del|erase|format)\b/iu.test(command) ||
		/\bfind\b[^\n]*\s-delete\b/iu.test(command) ||
		/\bgit\s+(?:reset\s+--hard|clean\b)/iu.test(command) ||
		/\b(?:kill|pkill|killall|reboot|shutdown)\b/iu.test(command) ||
		/\b(?:chmod|chown|chgrp)\b/iu.test(command)
	) {
		risks.push("destructive");
	}
	if (/\bgit\s+push\b|\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b|\bdeploy\b/iu.test(command)) {
		risks.push("external-side-effect");
	}
	if (
		/\b(?:curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b|\bgit\s+(?:push|pull|fetch|clone)\b|\b(?:npm|pnpm|yarn|bun|pip|pip3|cargo|brew)\s+(?:install|add|update|publish)\b/iu.test(
			command,
		)
	) {
		risks.push("network");
	}
	if (/\b(?:sudo|doas|runas|su)\b|\bStart-Process\b.*\b-Verb\s+RunAs\b/iu.test(command)) risks.push("elevation");
	return action(input, risks, [], command);
}

export function classifyAction(input: ClassifyActionInput): PermissionAction {
	if (input.provenance !== "builtin") {
		const risks: ActionRisk[] = ["custom"];
		if (input.mcpAnnotations?.destructiveHint) risks.push("destructive", "external-side-effect");
		return action(input, risks);
	}
	if (
		[
			"set_tasks",
			"ask_user",
			"deliver_file",
			"tool_search",
			"inspect_agents",
			"get_goal",
			"create_goal",
			"update_goal",
		].includes(input.toolName)
	) {
		return action(input, ["ordinary-read"]);
	}
	const args = record(input.args);
	if (!args) return action(input, ["unknown"]);
	if (input.toolName === "web_fetch") {
		if (typeof args.url !== "string") return action(input, ["unknown"]);
		try {
			const url = new URL(args.url);
			if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
				return action(input, ["unknown"]);
			}
			return action(input, ["network"], [], undefined, [
				{ host: url.hostname, port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80 },
			]);
		} catch {
			return action(input, ["unknown"]);
		}
	}
	if (input.toolName === "web_search") {
		return input.builtinNetworkTargets?.length
			? action(input, ["network"], [], undefined, input.builtinNetworkTargets)
			: action(input, ["unknown"]);
	}
	if (input.toolName === "bash") {
		return typeof args.command === "string" ? classifyBash(input, args.command) : action(input, ["unknown"]);
	}
	if (STRUCTURED_READ_TOOLS.has(input.toolName)) {
		if (args.path !== undefined && typeof args.path !== "string") return action(input, ["unknown"]);
		if (args.path === undefined && input.toolName === "read") return action(input, ["unknown"]);
		// describe_image reads a single file like `read`, so it must not be
		// classified with the directory-traversal semantics of grep/find/ls.
		const traversal = input.toolName !== "read" && input.toolName !== "describe_image";
		return classifyStructuredRead(input, typeof args.path === "string" ? args.path : input.cwd, traversal);
	}
	if (STRUCTURED_WRITE_TOOLS.has(input.toolName)) {
		return typeof args.path === "string" ? classifyStructuredWrite(input, args.path) : action(input, ["unknown"]);
	}
	return action(input, ["unknown"]);
}

export function revalidateStructuredActionBinding(
	approved: PermissionAction,
	args: unknown,
	cwd: string,
	workspaceRoots: readonly string[],
	readOnlyRoots: readonly string[] = [],
): boolean {
	if (approved.paths.length === 0) return true;
	if (
		approved.provenance !== "builtin" ||
		(!STRUCTURED_READ_TOOLS.has(approved.toolName) && !STRUCTURED_WRITE_TOOLS.has(approved.toolName))
	) {
		return false;
	}
	const current = classifyAction({
		actionId: approved.actionId,
		toolName: approved.toolName,
		provenance: approved.provenance,
		args,
		cwd,
		workspaceRoots,
		readOnlyRoots,
	});
	return isDeepStrictEqual(current.paths, approved.paths) && isDeepStrictEqual(current.risks, approved.risks);
}
