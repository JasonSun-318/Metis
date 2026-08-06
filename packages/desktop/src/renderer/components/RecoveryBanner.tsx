import type { SessionSummary } from "@arcmind/app-protocol";
import { useTranslation } from "react-i18next";

export function RecoveryBanner({ session }: { readonly session: SessionSummary }) {
	const { t } = useTranslation();
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
			? t("The last turn was interrupted. Your saved work is intact; send a new message to continue.")
			: session.state === "corrupt"
				? t("This session is corrupt. ArcMind left the source data untouched.")
				: t("This session is currently open in another process."));
	return <div className="recovery-banner" role="status">{message}</div>;
}
