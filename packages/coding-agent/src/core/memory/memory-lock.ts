import lockfile from "proper-lockfile";

const MEMORY_LOCK_OPTIONS = {
	realpath: false,
	stale: 15_000,
	retries: { retries: 8, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true },
} as const;

export async function withMemoryRootLock<T>(memoryRoot: string, fn: () => Promise<T> | T): Promise<T> {
	const release = await lockfile.lock(memoryRoot, MEMORY_LOCK_OPTIONS);
	let operationError: unknown;
	let result: T | undefined;
	try {
		result = await fn();
	} catch (error) {
		operationError = error;
	}
	let releaseError: unknown;
	try {
		await release();
	} catch (error) {
		releaseError = error;
	}
	if (operationError !== undefined) throw operationError;
	if (releaseError !== undefined) throw releaseError;
	return result as T;
}
