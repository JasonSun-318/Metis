import { isAbsolute } from "node:path";
import { canonicalizeActionPath } from "../utils/paths.ts";
import type { PermissionExecutionTarget } from "./permission-policy.ts";
import { assertConsumedExecutionGrant, claimConsumedExecutionGrant } from "./permissions/grant-store.ts";
import { digestCanonical } from "./permissions/normalize.ts";
import type { ExecutionGrant, NetworkEndpoint } from "./permissions/types.ts";
import type { BashOperations } from "./tools/bash.ts";
import { createWorkspaceSandbox, type WorkspaceSandbox } from "./workspace-sandbox.ts";
import { SANDBOX_RUNTIME_ID } from "./workspace-sandbox-health.ts";

export interface InteractiveBashContext {
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly readOnlyRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly protectedRoots?: readonly string[];
	readonly writeProtectedRoots?: readonly string[];
	readonly networkEndpoints?: readonly NetworkEndpoint[];
	readonly shellPath?: string;
	readonly workspaceReadOnly?: boolean;
}

/** Roots mounted read-only in the interactive Bash sandbox (attachments, long-term memory, …). */
export function buildInteractiveBashReadOnlyRoots(input: {
	readonly attachmentDir?: string;
	readonly memoryReadRoots?: readonly string[];
}): string[] {
	const roots: string[] = [];
	if (input.attachmentDir) roots.push(input.attachmentDir);
	if (input.memoryReadRoots) roots.push(...input.memoryReadRoots);
	return roots;
}

export interface InteractiveBashBoundary {
	readonly operations: BashOperations;
	bind(grant: ExecutionGrant): void;
	/** @internal Temporary old-runtime entry; removed at the Plan 05 cutover. */
	bindLegacy(actionId: string, target: PermissionExecutionTarget): void;
	unbind(actionId: string): void;
	reset(): Promise<void>;
	dispose(): Promise<void>;
	forceDispose(): void;
}

type SandboxState = {
	readonly key: string;
	readonly promise: Promise<WorkspaceSandbox>;
	instance?: WorkspaceSandbox;
};

function normalizeContext(value: InteractiveBashContext): InteractiveBashContext {
	const paths = [
		value.cwd,
		...value.workspaceRoots,
		...value.readOnlyRoots,
		...value.writeRoots,
		...(value.protectedRoots ?? []),
		...(value.writeProtectedRoots ?? []),
	];
	if (
		!isAbsolute(value.cwd) ||
		value.workspaceRoots.length === 0 ||
		paths.some((path) => !path || !isAbsolute(path))
	) {
		throw new TypeError("Interactive Bash sandbox paths must be absolute and non-empty");
	}
	const roots = (items: readonly string[]) =>
		[...new Set(items.map((path) => canonicalizeActionPath(path, path)))].sort();
	const networkEndpoints = [...(value.networkEndpoints ?? [])]
		.map(({ hostname, port }) => Object.freeze({ hostname: hostname.toLowerCase().replace(/\.$/, ""), port }))
		.sort((left, right) =>
			left.hostname === right.hostname ? left.port - right.port : left.hostname < right.hostname ? -1 : 1,
		);
	return {
		cwd: canonicalizeActionPath(value.cwd, value.cwd),
		workspaceRoots: roots(value.workspaceRoots),
		readOnlyRoots: roots(value.readOnlyRoots),
		writeRoots: roots(value.writeRoots),
		protectedRoots: roots(value.protectedRoots ?? []),
		writeProtectedRoots: roots(value.writeProtectedRoots ?? []),
		networkEndpoints: Object.freeze(networkEndpoints),
		workspaceReadOnly: value.workspaceReadOnly === true,
		...(value.shellPath === undefined
			? {}
			: {
					shellPath: isAbsolute(value.shellPath)
						? canonicalizeActionPath(value.shellPath, value.shellPath)
						: value.shellPath,
				}),
	};
}

export function workspaceSandboxProfileKey(value: InteractiveBashContext): string {
	return digestCanonical({
		version: 1,
		sandboxRuntime: SANDBOX_RUNTIME_ID,
		platform: process.platform,
		architecture: process.arch,
		context: normalizeContext(value),
	});
}

class DefaultInteractiveBashBoundary implements InteractiveBashBoundary {
	readonly operations: BashOperations;
	private readonly hostOperations: BashOperations;
	private readonly context: (env: NodeJS.ProcessEnv | undefined) => InteractiveBashContext;
	private readonly createSandbox: typeof createWorkspaceSandbox;
	private readonly bindings = new Map<string, ExecutionGrant>();
	private readonly legacyBindings = new Map<string, PermissionExecutionTarget>();
	private tail: Promise<void> = Promise.resolve();
	private sandbox?: SandboxState;
	private generation = 0;
	private closed = false;
	private disposeTask?: Promise<void>;

	constructor(input: {
		hostOperations: BashOperations;
		context: (env: NodeJS.ProcessEnv | undefined) => InteractiveBashContext;
		createSandbox?: typeof createWorkspaceSandbox;
	}) {
		this.hostOperations = input.hostOperations;
		this.context = input.context;
		this.createSandbox = input.createSandbox ?? createWorkspaceSandbox;
		this.operations = { exec: (command, cwd, options) => this.exec(command, cwd, options) };
	}

	bind(grant: ExecutionGrant): void {
		if (this.closed) throw new Error("Interactive Bash boundary is closed");
		assertConsumedExecutionGrant(grant);
		if (grant.toolName !== "bash") throw new TypeError("Interactive Bash requires a Bash execution grant");
		if (grant.executionTarget === "external") {
			throw new TypeError("External execution grants cannot run through Interactive Bash");
		}
		if (this.bindings.has(grant.actionId) || this.legacyBindings.has(grant.actionId)) {
			throw new Error(`Interactive Bash action ID was reused: ${grant.actionId}`);
		}
		this.bindings.set(grant.actionId, grant);
	}

	bindLegacy(actionId: string, target: PermissionExecutionTarget): void {
		if (this.closed) throw new Error("Interactive Bash boundary is closed");
		if (!actionId) throw new TypeError("Interactive Bash action ID is required");
		if (this.bindings.has(actionId) || this.legacyBindings.has(actionId)) {
			throw new Error(`Interactive Bash action ID was reused: ${actionId}`);
		}
		this.legacyBindings.set(actionId, target);
	}

	unbind(actionId: string): void {
		this.bindings.delete(actionId);
		this.legacyBindings.delete(actionId);
	}

	private exec(
		command: string,
		cwd: string,
		options: Parameters<BashOperations["exec"]>[2],
	): Promise<{ exitCode: number | null }> {
		if (this.closed) return Promise.reject(new Error("Interactive Bash boundary is closed"));
		if (!options.actionId) return Promise.reject(new Error("Interactive Bash execution requires an action ID"));
		const grant = this.bindings.get(options.actionId);
		const legacyTarget = this.legacyBindings.get(options.actionId);
		this.bindings.delete(options.actionId);
		this.legacyBindings.delete(options.actionId);
		if (!grant && !legacyTarget) {
			return Promise.reject(new Error("Interactive Bash execution has no permission binding"));
		}
		let target = legacyTarget;
		if (grant) {
			if (grant.executionTarget === "external") {
				return Promise.reject(new Error("External execution grants cannot run through Interactive Bash"));
			}
			const canonicalCwd = canonicalizeActionPath(cwd, grant.cwd);
			if (canonicalCwd !== grant.cwd) {
				return Promise.reject(new Error("Interactive Bash cwd does not match the execution grant"));
			}
			const argsDigest = digestCanonical({
				command,
				...(options.timeout === undefined ? {} : { timeout: options.timeout }),
			});
			if (argsDigest !== grant.argsDigest) {
				return Promise.reject(new Error("Interactive Bash command does not match the execution grant"));
			}
			try {
				claimConsumedExecutionGrant(grant);
			} catch (error) {
				return Promise.reject(error);
			}
			target = grant.executionTarget;
		}
		if (target === "host") return this.hostOperations.exec(command, cwd, options);

		const generation = this.generation;
		const run = this.tail.then(async () => {
			if (this.closed || generation !== this.generation) throw new Error("Interactive Bash execution was reset");
			if (options.signal?.aborted) throw new Error("aborted");
			const baseContext = normalizeContext(this.context(options.env));
			const context = grant
				? normalizeContext({
						...baseContext,
						cwd: grant.cwd,
						workspaceRoots: grant.workspaceRoots,
						readOnlyRoots: grant.readRoots,
						writeRoots: grant.writeRoots,
						protectedRoots: [],
						writeProtectedRoots: grant.protectedRoots,
						networkEndpoints: grant.networkEndpoints,
						workspaceReadOnly: true,
					})
				: baseContext;
			const sandbox = await this.getSandbox(context, generation);
			if (this.closed || generation !== this.generation) throw new Error("Interactive Bash execution was reset");
			if (options.signal?.aborted) throw new Error("aborted");
			return sandbox.operations.exec(command, cwd, options);
		});
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async getSandbox(context: InteractiveBashContext, generation: number): Promise<WorkspaceSandbox> {
		const key = workspaceSandboxProfileKey(context);
		if (this.sandbox?.key === key) return this.sandbox.promise;
		const previous = this.sandbox;
		this.sandbox = undefined;
		if (previous) {
			try {
				await (previous.instance ?? (await previous.promise)).dispose();
			} catch {
				// A failed or already-closed sandbox is replaced, never bypassed.
			}
		}
		if (this.closed || generation !== this.generation) throw new Error("Interactive Bash execution was reset");
		let state!: SandboxState;
		const promise = this.createSandbox(context).then((instance) => {
			state.instance = instance;
			if (this.closed || generation !== this.generation || this.sandbox !== state) {
				instance.forceDispose();
				throw new Error("Interactive Bash execution was reset");
			}
			return instance;
		});
		state = { key, promise };
		this.sandbox = state;
		try {
			return await promise;
		} catch (error) {
			if (this.sandbox === state) this.sandbox = undefined;
			throw error;
		}
	}

	async reset(): Promise<void> {
		if (this.closed) return this.disposeTask;
		await this.resetOpenBoundary();
	}

	private async resetOpenBoundary(): Promise<void> {
		this.generation += 1;
		this.bindings.clear();
		this.legacyBindings.clear();
		const state = this.sandbox;
		this.sandbox = undefined;
		if (state) {
			try {
				await (state.instance ?? (await state.promise)).dispose();
			} catch {
				// Reset is idempotent even after a broker failure.
			}
		}
		await this.tail;
	}

	dispose(): Promise<void> {
		if (this.disposeTask) return this.disposeTask;
		this.closed = true;
		this.disposeTask = this.resetOpenBoundary();
		return this.disposeTask;
	}

	forceDispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.generation += 1;
		this.bindings.clear();
		this.legacyBindings.clear();
		const state = this.sandbox;
		this.sandbox = undefined;
		if (state?.instance) state.instance.forceDispose();
		else if (state)
			void state.promise.then(
				(sandbox) => sandbox.forceDispose(),
				() => undefined,
			);
	}
}

export function createInteractiveBashBoundary(input: {
	readonly hostOperations: BashOperations;
	readonly context: (env: NodeJS.ProcessEnv | undefined) => InteractiveBashContext;
	readonly createSandbox?: typeof createWorkspaceSandbox;
}): InteractiveBashBoundary {
	return new DefaultInteractiveBashBoundary(input);
}
