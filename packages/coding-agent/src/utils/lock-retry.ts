interface LockRetryOptions {
	readonly maxAttempts: number;
	readonly delayMs: number;
}

const WAIT_CELL_BYTES = Int32Array.BYTES_PER_ELEMENT;

/**
 * Darwin `Atomics.wait` can wake several milliseconds late. Sleep only a part of
 * the budget and leave this margin for the clock loop, so waiting does not
 * consistently lengthen the caller's retry timeout.
 */
const SLEEP_MARGIN_MS = 10;

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	return String((error as { code?: unknown }).code);
}

/**
 * Builds a private wait cell only for the validated Darwin runtime. Returning
 * undefined keeps every other platform on the portable clock loop below.
 */
function createWaitCell(): Int32Array | undefined {
	if (process.platform !== "darwin") {
		return undefined;
	}
	if (
		typeof SharedArrayBuffer !== "function" ||
		typeof Atomics === "undefined" ||
		typeof Atomics.wait !== "function"
	) {
		return undefined;
	}
	try {
		return new Int32Array(new SharedArrayBuffer(WAIT_CELL_BYTES));
	} catch {
		return undefined;
	}
}

/**
 * Best-effort finite sleep. The caller keeps the clock loop as the fallback and
 * as the authority on the configured wait budget, so a missing or throwing
 * primitive must never replace the acquisition error.
 */
function sleepSync(cell: Int32Array, sleepMs: number): void {
	try {
		Atomics.wait(cell, 0, 0, sleepMs);
	} catch {
		// Fall through to the portable clock loop.
	}
}

function waitSync(delayMs: number, sleepMs: number, cell: Int32Array | undefined): void {
	const start = Date.now();
	if (cell !== undefined && sleepMs > 0) {
		sleepSync(cell, sleepMs);
	}
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
	const sleepMs = Math.max(0, delayMs - SLEEP_MARGIN_MS);
	let lastError: unknown;
	let waitCell: Int32Array | undefined;
	let waitCellResolved = false;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return acquire();
		} catch (error) {
			if (getErrorCode(error) !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			if (!waitCellResolved) {
				waitCellResolved = true;
				waitCell = createWaitCell();
			}
			waitSync(delayMs, sleepMs, waitCell);
		}
	}

	throw lastError ?? new Error("Failed to acquire lock");
}
