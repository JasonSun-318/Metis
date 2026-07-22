export interface ToolSubprocessInput {
	readonly actionId: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

export interface WrappedToolSubprocess {
	readonly argv: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
}

/**
 * Runs a built-in tool subprocess through the session's permission/sandbox boundary.
 * Custom tool operations do not use this seam because installed extension/SDK code is trusted.
 */
export interface ToolSubprocessExecutor {
	execute<T>(input: ToolSubprocessInput, run: (command: WrappedToolSubprocess) => Promise<T>): Promise<T>;
}
