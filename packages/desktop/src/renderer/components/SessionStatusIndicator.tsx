import type { SessionIndicator } from "../session-view-utils.ts";

/** Shared by root sessions, agent conversations and collapsed agent summaries. */
export function SessionStatusIndicator({ indicator }: { readonly indicator: SessionIndicator | undefined }) {
	return <i aria-hidden="true" className={indicator} />;
}
