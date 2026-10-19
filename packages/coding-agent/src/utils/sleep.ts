/**
 * Sleep helper that respects abort signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		function cleanup(): void {
			signal?.removeEventListener("abort", onAbort);
		}

		function onAbort(): void {
			clearTimeout(timeout);
			cleanup();
			reject(new Error("Aborted"));
		}

		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort);
	});
}
