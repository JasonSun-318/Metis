import type { ClientResult, SessionSummary } from "@metis/app-protocol";

/** One visible project folder; projects are grouped and deleted by cwd only. */
export interface ProjectSessionGroup {
	readonly cwd: string;
	readonly name: string;
	readonly pinned: boolean;
	readonly sessions: readonly SessionSummary[];
}

export type ProjectDeletePreview = ClientResult<"project/deletePreview">;
