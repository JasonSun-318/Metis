import type { SessionGoalView } from "@metis/app-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatElapsed } from "../format-elapsed.ts";
import { Pause, Play, Target, Trash } from "../icons.tsx";

interface GoalBarProps {
	readonly goal: SessionGoalView | null;
	readonly onPause: () => void;
	readonly onResume: () => void;
	readonly onClear: () => void;
}

function goalElapsedMs(goal: SessionGoalView, now: number): number {
	const base = Math.max(0, goal.timeUsedSeconds) * 1_000;
	if (goal.status !== "active" || goal.activeStartedAt === null) return base;
	const started = Date.parse(goal.activeStartedAt);
	if (!Number.isFinite(started)) return base;
	return base + Math.max(0, now - started);
}

function statusLabelKey(status: SessionGoalView["status"]): string {
	switch (status) {
		case "active":
			return "Active goal";
		case "paused":
			return "Goal paused";
		case "blocked":
			return "Goal blocked";
		case "usage_limited":
			return "Goal usage limited";
		case "complete":
			return "Goal complete";
	}
}

export function GoalBar({ goal, onPause, onResume, onClear }: GoalBarProps) {
	const { t } = useTranslation();
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!goal || goal.status !== "active") return;
		const id = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(id);
	}, [goal]);

	if (!goal || goal.status === "complete") return null;

	const canPause = goal.status === "active";
	const canResume = goal.status === "paused" || goal.status === "blocked" || goal.status === "usage_limited";

	return (
		<div className="goal-bar-slot">
			<section aria-label={t(statusLabelKey(goal.status))} className="goal-bar-panel">
				<header className="goal-bar-heading">
					<span aria-hidden="true" className="goal-bar-icon">
						<Target size={14} />
					</span>
					<div className="goal-bar-copy">
						<strong>{t(statusLabelKey(goal.status))}</strong>
						<p className="goal-bar-objective" title={goal.objective}>
							{goal.objective}
						</p>
					</div>
					<span aria-live="off" className="goal-bar-elapsed">
						{formatElapsed(goalElapsedMs(goal, now))}
					</span>
					<div className="goal-bar-controls">
						<button aria-label={t("Delete goal")} className="goal-bar-action" onClick={onClear} type="button">
							<Trash aria-hidden="true" size={14} />
						</button>
						{canPause ? (
							<button aria-label={t("Pause goal")} className="goal-bar-action" onClick={onPause} type="button">
								<Pause aria-hidden="true" size={14} />
							</button>
						) : null}
						{canResume ? (
							<button aria-label={t("Resume goal")} className="goal-bar-action" onClick={onResume} type="button">
								<Play aria-hidden="true" size={14} />
							</button>
						) : null}
					</div>
				</header>
			</section>
		</div>
	);
}
