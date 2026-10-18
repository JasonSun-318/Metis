export function approvalErrorMessage(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : "The response could not be sent.";
	if (/stale|unavailable|cancelled|no longer/i.test(message)) return "This approval is no longer available.";
	return message;
}
