import { statSync } from "node:fs";
import { dirname, parse } from "node:path";
import type { Static, TSchema } from "typebox";
import { canonicalizeActionPath, isPathInside } from "../utils/paths.ts";
import { getShellConfig } from "../utils/shell.ts";
import type {
	ToolDefinition,
	ToolPermissionClaim,
	ToolPermissionContext,
	ToolPermissionDescriptor,
} from "./extensions/types.ts";
import { MAX_SHELL_COMMAND_BYTES } from "./permissions/limits.ts";
import { assertWellFormedAction, digestCanonical, normalizePermissionAction } from "./permissions/normalize.ts";
import { isSensitivePath } from "./permissions/sensitive-paths.ts";
import { analyzeShellCommand } from "./permissions/shell-analysis.ts";
import { getShellParserStatus } from "./permissions/shell-parser.ts";
import type { NormalizedPermissionAction, ToolProvenance } from "./permissions/types.ts";

const CLAIM_KEYS = ["command", "effects", "networkEndpoints", "readPaths", "shellAnalysis", "writePaths"] as const;

/**
 * Shared cap alias kept for existing imports; the value itself lives in the
 * leaf limits module so policy and this adapter never depend on each other.
 */
export const MAX_BASH_COMMAND_BYTES = MAX_SHELL_COMMAND_BYTES;

export interface ToolIdentityInput {
	readonly provenance: ToolProvenance;
	readonly sourceIdentity: string;
	readonly toolName: string;
	readonly implementationVersion: string;
	readonly descriptorVersion: number;
}

export interface DescribeToolActionContext extends ToolPermissionContext {
	readonly provenance: ToolProvenance;
	readonly toolIdentity: string;
}

export class ToolPermissionDescriptionError extends TypeError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolPermissionDescriptionError";
	}
}

export function permissionDescriptor<TParams>(
	describe: ToolPermissionDescriptor<TParams>["describe"],
): ToolPermissionDescriptor<TParams> {
	return Object.freeze({ version: 1, describe });
}

export function permissionClaim(input: Partial<ToolPermissionClaim> = {}): ToolPermissionClaim {
	return {
		readPaths: input.readPaths ?? [],
		writePaths: input.writePaths ?? [],
		networkEndpoints: input.networkEndpoints ?? [],
		...(input.command === undefined ? {} : { command: input.command }),
		effects: input.effects ?? [],
		...(input.shellAnalysis === undefined ? {} : { shellAnalysis: input.shellAnalysis }),
	};
}

export function fileReadPermissionClaim(
	path: string,
	context: ToolPermissionContext,
	options: {
		readonly traversal?: boolean;
		readonly networkEndpoints?: ToolPermissionClaim["networkEndpoints"];
	} = {},
): ToolPermissionClaim {
	return permissionClaim({
		readPaths: [path],
		networkEndpoints: options.networkEndpoints,
		effects: isSensitivePath(path, context.cwd, options.traversal === true, context.workspaceRoots)
			? ["sensitive-read"]
			: [],
	});
}

export function exactNetworkEndpoint(value: string | URL): { readonly hostname: string; readonly port: number } {
	const url = value instanceof URL ? value : new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Network URL must use HTTP(S)");
	if (url.username || url.password) throw new TypeError("Network URL must not contain credentials");
	const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
	if (!hostname || hostname.includes("*")) throw new TypeError("Network URL must name one exact host");
	const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("Network URL port is invalid");
	return Object.freeze({ hostname, port });
}

/**
 * Windows sandbox grants apply to directories. The SDK drops a grant for a path
 * that does not exist yet, so a claim for a future file could not create it.
 * Grant the nearest existing ancestor directory instead. Files stay
 * directory-scoped too so atomic replace, delete, and recreate keep working.
 * The containing workspace root is a hard lower bound: a workspace target must
 * never widen to the workspace parent or a drive root. macOS keeps exact
 * targets because its sandbox accepts grants for paths that do not exist yet.
 */
function windowsDirectoryWriteRoots(paths: readonly string[], workspaceRoots: readonly string[]): readonly string[] {
	const roots = workspaceRoots.map((root) => canonicalizeActionPath(root, root));
	const widened = paths.map((path) => {
		if (roots.includes(path)) return path;
		const filesystemRoot = parse(path).root;
		if (path === filesystemRoot) return path;
		const boundary = roots.find((root) => isPathInside(root, path));
		let current = path;
		for (;;) {
			try {
				if (statSync(current).isDirectory()) {
					// Never imply a grant for a whole filesystem root.
					return current === filesystemRoot ? path : current;
				}
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// Only a missing component justifies widening to its parent. Any
				// other failure keeps the exact target so the grant cannot broaden.
				if (code !== "ENOENT" && code !== "ENOTDIR") return path;
			}
			const parent = dirname(current);
			if (parent === current) return path;
			// Never widen a workspace target beyond its own workspace root.
			if (boundary !== undefined && !isPathInside(boundary, parent)) return path;
			current = parent;
		}
	});
	return [...new Set(widened)];
}

function claimFromAnalysis(
	command: string,
	context: ToolPermissionContext,
	overrideEffects?: readonly ToolPermissionClaim["effects"][number][],
): ToolPermissionClaim {
	const workspaceReads = [...context.workspaceRoots];
	if (overrideEffects) {
		return permissionClaim({ readPaths: workspaceReads, writePaths: [], command, effects: overrideEffects });
	}
	const analysis = analyzeShellCommand({
		command,
		cwd: context.cwd,
		workspaceRoots: context.workspaceRoots,
		shellPath: context.shellPath ?? getShellConfig().shell,
	});
	const effects = new Set(analysis.effects);
	// An incomplete analysis can never be treated as fully understood; complete
	// user-required actions keep their own facts and route to the user by disposition.
	if (!analysis.complete) effects.add("unknown");
	// Grants must still cover writes the analyzer could not pin down; complete
	// analyses keep their exact write targets.
	const writePaths = analysis.complete
		? [...analysis.writePaths]
		: [...new Set([...context.workspaceRoots, ...analysis.writePaths])];
	const scopedWritePaths =
		process.platform === "win32" ? windowsDirectoryWriteRoots(writePaths, context.workspaceRoots) : writePaths;
	return permissionClaim({
		readPaths: [...new Set([...workspaceReads, ...analysis.readPaths])],
		writePaths: scopedWritePaths,
		networkEndpoints: [...analysis.networkEndpoints],
		command,
		effects: [...effects],
		shellAnalysis: {
			disposition: analysis.disposition,
			complete: analysis.complete,
			commands: analysis.commands,
			readPaths: analysis.readPaths,
		},
	});
}

/**
 * Builtin bash is the only tool allowed to claim trusted analysis facts: the
 * claim is produced by the engine's own AST analyzer, never by tool input.
 */
export function bashPermissionClaim(command: string, context: ToolPermissionContext): ToolPermissionClaim {
	if (typeof command !== "string" || command.length === 0) {
		return claimFromAnalysis(command ?? "", context, ["unknown"]);
	}
	if (Buffer.byteLength(command, "utf8") > MAX_BASH_COMMAND_BYTES) {
		return claimFromAnalysis(command, context, ["unknown"]);
	}
	if (!getShellParserStatus().ready) {
		return claimFromAnalysis(command, context, ["unknown"]);
	}
	return claimFromAnalysis(command, context);
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must not be empty`);
	if (value.includes("\0")) throw new TypeError(`${field} must not contain NUL bytes`);
	return value.trim();
}

export function createToolIdentity(input: ToolIdentityInput): string {
	const identity = {
		version: 1,
		provenance: input.provenance,
		sourceIdentity: nonEmpty(input.sourceIdentity, "sourceIdentity"),
		toolName: nonEmpty(input.toolName, "toolName"),
		implementationVersion: nonEmpty(input.implementationVersion, "implementationVersion"),
		descriptorVersion: input.descriptorVersion,
	};
	if (!Number.isSafeInteger(identity.descriptorVersion) || identity.descriptorVersion < 1) {
		throw new TypeError("descriptorVersion must be a positive integer");
	}
	return `tool:v1:${digestCanonical(identity)}`;
}

export function assertToolPermissionDescriptor(
	definition: Pick<ToolDefinition<any, any, any>, "name"> & { readonly permission?: unknown },
): asserts definition is Pick<ToolDefinition<any, any, any>, "name" | "permission"> {
	const descriptor = definition.permission as Partial<ToolPermissionDescriptor<unknown>> | undefined;
	if (
		!descriptor ||
		typeof descriptor !== "object" ||
		descriptor.version !== 1 ||
		typeof descriptor.describe !== "function"
	) {
		throw new TypeError(`Executable tool ${definition.name} requires a permission descriptor`);
	}
}

function copyClaim(value: unknown): ToolPermissionClaim {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Permission action scope is incomplete");
	}
	const record = value as Record<string, unknown>;
	const actualKeys = Object.keys(record).sort();
	const expectedKeys = CLAIM_KEYS.filter(
		(key) =>
			(key !== "command" || record.command !== undefined) &&
			(key !== "shellAnalysis" || record.shellAnalysis !== undefined),
	).sort();
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
		throw new TypeError("Permission action scope is incomplete");
	}
	if (
		!Array.isArray(record.readPaths) ||
		!Array.isArray(record.writePaths) ||
		!Array.isArray(record.networkEndpoints) ||
		!Array.isArray(record.effects)
	) {
		throw new TypeError("Permission action scope is incomplete");
	}
	return {
		readPaths: [...record.readPaths] as string[],
		writePaths: [...record.writePaths] as string[],
		networkEndpoints: (record.networkEndpoints as Array<{ hostname: string; port: number }>).map(
			({ hostname, port }) => ({ hostname, port }),
		),
		...(record.command === undefined ? {} : { command: record.command as string }),
		effects: [...record.effects] as ToolPermissionClaim["effects"],
		...(record.shellAnalysis === undefined
			? {}
			: { shellAnalysis: record.shellAnalysis as ToolPermissionClaim["shellAnalysis"] }),
	};
}

export function describeToolAction<TParams extends TSchema>(
	definition: ToolDefinition<TParams, any, any>,
	params: Static<TParams>,
	context: DescribeToolActionContext,
): NormalizedPermissionAction {
	try {
		assertToolPermissionDescriptor(definition);
		const claim = copyClaim(definition.permission.describe(params, context));
		const action = normalizePermissionAction({
			actionId: context.actionId,
			toolName: definition.name,
			provenance: context.provenance,
			toolIdentity: context.toolIdentity,
			args: params,
			cwd: context.cwd,
			workspaceRoots: context.workspaceRoots,
			...claim,
		});
		assertWellFormedAction(action);
		return action;
	} catch (error) {
		if (error instanceof ToolPermissionDescriptionError) throw error;
		const message =
			error instanceof TypeError &&
			/scope is incomplete|^network (?:hostname|url|endpoint|port)\b/iu.test(error.message)
				? error.message
				: `Permission action could not be described for ${definition.name}`;
		throw new ToolPermissionDescriptionError(message, { cause: error });
	}
}
