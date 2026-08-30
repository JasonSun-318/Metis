import { useSyncExternalStore } from "react";
import type { SessionWorkspaceSnapshot, SessionWorkspaceWorkflow } from "../session-workspace-workflow.ts";

export function useSessionWorkspace(workflow: SessionWorkspaceWorkflow): SessionWorkspaceSnapshot {
	return useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
}
