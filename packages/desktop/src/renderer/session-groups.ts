import type { AgentMode, ClientResult, SessionSummary } from "@metis/app-protocol";

export interface ProjectSessionGroup {
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly name: string;
	readonly pinned: boolean;
	readonly sessions: readonly SessionSummary[];
}

/** The second legacy classification shares the same visible project folder. */
export type ProjectDeletePreview = ClientResult<"project/deletePreview"> & {
	readonly additionalProjects?: readonly ClientResult<"project/deletePreview">[];
};
