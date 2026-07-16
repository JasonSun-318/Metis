import type { SessionSummary } from "@arcmind/app-protocol";

export function RecoveryBanner({ session }: { readonly session: SessionSummary }) {
	if (
		!session.recoveryNotice &&
		session.state !== "interrupted" &&
		session.state !== "corrupt" &&
		session.state !== "in_use"
	)
		return null;
	const message =
		session.recoveryNotice ??
		(session.state === "interrupted"
			? "The last turn was interrupted. Your saved work is intact; send a new message to continue."
			: session.state === "corrupt"
				? "This session is corrupt. ArcMind left the source data untouched."
				: "This session is currently open in another process.");
	return <div className="recovery-banner" role="status">{message}</div>;
}
