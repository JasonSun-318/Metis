interface LockRetryOptions {
	readonly maxAttempts: number;
	readonly delayMs: number;
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	return String((error as { code?: unknown }).code);
}

function waitSync(delayMs: number): void {
	const start = Date.now();
	while (Date.now() - start < delayMs) {
		// Keep the synchronous busy-wait; portable waiting primitives are runtime-dependent.
	}
}

/**
 * Retries a synchronous lock acquisition only while the raw error code coerces to
 * ELOCKED. The acquisition callback owns lock options and initialization; its
 * release callback is returned unchanged.
 */
export function acquireLockSyncWithRetry(acquire: () => () => void, options: LockRetryOptions): () => void {
	const { maxAttempts, delayMs } = options;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return acquire();
		} catch (error) {
			if (getErrorCode(error) !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			waitSync(delayMs);
		}
	}

	throw lastError ?? new Error("Failed to acquire lock");
}
