import type { SessionSummary } from "@metis/app-protocol";
import { SystemNotice, systemErrorNoticeForCode } from "./SystemNotice.tsx";

export function RecoveryBanner({ errorCode, session }: {
	readonly errorCode?: string;
	readonly session: SessionSummary;
}) {
	if (
		!session.recoveryNotice &&
		session.state !== "interrupted" &&
		session.state !== "corrupt" &&
		session.state !== "in_use"
	)
		return null;
	if (errorCode) {
		const copy = systemErrorNoticeForCode(errorCode);
		return <SystemNotice message={copy.message} title={copy.title} tone="error" />;
	}
	const message =
		session.recoveryNotice ??
		(session.state === "interrupted"
			? "The last turn was interrupted. Your saved work is intact; send a new message to continue."
			: session.state === "corrupt"
				? "This session is corrupt. Metis left the source data untouched."
				: "This session is currently open in another process.");
	return <SystemNotice message={message} title="Task needs attention" tone="warning" />;
}
