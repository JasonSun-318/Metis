export function rpcErrorCode(cause: unknown): number | undefined {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
	const code = Number(cause.code);
	return Number.isFinite(code) ? code : undefined;
}

/** Reuse idempotency keys only when the server may have completed without returning a response. */
export function shouldReuseMutationRequest(cause: unknown): boolean {
	return rpcErrorCode(cause) === undefined;
}
