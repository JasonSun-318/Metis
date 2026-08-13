import { isAbsolute } from "node:path";
import { canonicalizeActionPath } from "../utils/paths.ts";
import type { PermissionExecutionTarget } from "./permission-policy.ts";
import type { BashOperations } from "./tools/bash.ts";
import { createWorkspaceSandbox, type WorkspaceSandbox } from "./workspace-sandbox.ts";

export interface InteractiveBashContext {
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly readOnlyRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly shellPath?: string;
}

export interface InteractiveBashBoundary {
	readonly operations: BashOperations;
	bind(actionId: string, target: PermissionExecutionTarget): void;
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
	const paths = [value.cwd, ...value.workspaceRoots, ...value.readOnlyRoots, ...value.writeRoots];
	if (
		!isAbsolute(value.cwd) ||
		value.workspaceRoots.length === 0 ||
		paths.some((path) => !path || !isAbsolute(path))
	) {
		throw new TypeError("Interactive Bash sandbox paths must be absolute and non-empty");
	}
	const roots = (items: readonly string[]) =>
		[...new Set(items.map((path) => canonicalizeActionPath(path, path)))].sort();
	return {
		cwd: canonicalizeActionPath(value.cwd, value.cwd),
		workspaceRoots: roots(value.workspaceRoots),
		readOnlyRoots: roots(value.readOnlyRoots),
		writeRoots: roots(value.writeRoots),
		...(value.shellPath === undefined
			? {}
			: {
					shellPath: isAbsolute(value.shellPath)
						? canonicalizeActionPath(value.shellPath, value.shellPath)
						: value.shellPath,
				}),
	};
}

class DefaultInteractiveBashBoundary implements InteractiveBashBoundary {
	readonly operations: BashOperations;
	private readonly hostOperations: BashOperations;
	private readonly context: (env: NodeJS.ProcessEnv | undefined) => InteractiveBashContext;
	private readonly createSandbox: typeof createWorkspaceSandbox;
	private readonly bindings = new Map<string, PermissionExecutionTarget>();
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

	bind(actionId: string, target: PermissionExecutionTarget): void {
		if (this.closed) throw new Error("Interactive Bash boundary is closed");
		if (!actionId) throw new TypeError("Interactive Bash action ID is required");
		if (this.bindings.has(actionId)) throw new Error(`Interactive Bash action ID was reused: ${actionId}`);
		this.bindings.set(actionId, target);
	}

	unbind(actionId: string): void {
		this.bindings.delete(actionId);
	}

	private exec(
		command: string,
		cwd: string,
		options: Parameters<BashOperations["exec"]>[2],
	): Promise<{ exitCode: number | null }> {
		if (this.closed) return Promise.reject(new Error("Interactive Bash boundary is closed"));
		if (!options.actionId) return Promise.reject(new Error("Interactive Bash execution requires an action ID"));
		const target = this.bindings.get(options.actionId);
		this.bindings.delete(options.actionId);
		if (!target) return Promise.reject(new Error("Interactive Bash execution has no permission binding"));
		if (target === "host") return this.hostOperations.exec(command, cwd, options);

		const generation = this.generation;
		const run = this.tail.then(async () => {
			if (this.closed || generation !== this.generation) throw new Error("Interactive Bash execution was reset");
			if (options.signal?.aborted) throw new Error("aborted");
			const context = normalizeContext(this.context(options.env));
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
		const key = JSON.stringify(context);
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
