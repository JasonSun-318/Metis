import type { SessionControlEntry } from "./session-control.ts";

export type CollaborationMode = "default" | "plan";
export type PlanStatus = "proposed" | "superseded" | "accepted" | "cancelled";

export const MAX_PLAN_TITLE_UTF16_UNITS = 256;
export const MAX_PLAN_MARKDOWN_UTF8_BYTES = 64 * 1024;

export interface PlanRef {
	readonly planId: string;
	readonly revision: number;
}

export interface StoredPlan {
	readonly entryId: string;
	readonly parentId: string | null;
	readonly planId: string;
	readonly revision: number;
	readonly title: string;
	readonly markdown: string;
	readonly status: PlanStatus;
	readonly createdAt: string;
}

export interface PlanState {
	readonly collaborationMode: CollaborationMode;
	readonly plans: readonly StoredPlan[];
	readonly currentPlan?: StoredPlan;
}

type PlanControlEntry = Extract<
	SessionControlEntry,
	{ type: "session_collaboration_mode" | "session_plan_proposal" | "session_plan_status" }
>;

function isPlanControlEntry(value: unknown): value is PlanControlEntry {
	if (typeof value !== "object" || value === null) return false;
	const type = Reflect.get(value, "type");
	return type === "session_collaboration_mode" || type === "session_plan_proposal" || type === "session_plan_status";
}

export function reducePlanState(entries: readonly unknown[], activeBranchIds?: ReadonlySet<string>): PlanState {
	let collaborationMode: CollaborationMode = "default";
	const proposals: StoredPlan[] = [];
	const terminal = new Map<string, "accepted" | "cancelled">();
	for (const entry of entries) {
		if (!isPlanControlEntry(entry)) continue;
		if (entry.type === "session_collaboration_mode") {
			collaborationMode = entry.collaborationMode;
			continue;
		}
		if (entry.type === "session_plan_status") {
			if (activeBranchIds && entry.parentId !== null && !activeBranchIds.has(entry.parentId)) continue;
			terminal.set(`${entry.planId}:${entry.revision}`, entry.status);
			continue;
		}
		if (entry.type !== "session_plan_proposal") continue;
		if (activeBranchIds && entry.parentId !== null && !activeBranchIds.has(entry.parentId)) continue;
		proposals.push({
			entryId: entry.id,
			parentId: entry.parentId,
			planId: entry.planId,
			revision: entry.revision,
			title: entry.title,
			markdown: entry.markdown,
			status: "proposed",
			createdAt: entry.timestamp,
		});
	}
	const plans: StoredPlan[] = proposals.map((plan, index) => {
		const explicit = terminal.get(`${plan.planId}:${plan.revision}`);
		const superseded = proposals.slice(index + 1).some(
			(candidate) => candidate.planId === plan.planId && candidate.revision > plan.revision,
		);
		const status: PlanStatus = explicit ?? (superseded ? "superseded" : "proposed");
		return { ...plan, status };
	});
	return { collaborationMode, plans, currentPlan: [...plans].reverse().find((plan) => plan.status === "proposed") };
}
