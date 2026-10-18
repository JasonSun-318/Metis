import type { AgentMode, SessionSummary } from "@metis/app-protocol";

export interface ProjectSessionGroup {
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly name: string;
	readonly pinned: boolean;
	readonly sessions: readonly SessionSummary[];
}
