import type { SessionGoalView } from "@metis/app-protocol";
import { Pause, Play, Target, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface GoalBarProps {
	readonly goal: SessionGoalView | null;
	readonly onPause: () => void;
	readonly onResume: () => void;
	readonly onClear: () => void;
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
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

	if (!goal) return null;

	const canPause = goal.status === "active";
	const canResume = goal.status === "paused" || goal.status === "blocked" || goal.status === "usage_limited";

	return (
		<div className="goal-bar-slot">
			<section aria-label={t(statusLabelKey(goal.status))} className="goal-bar-panel">
				<span aria-hidden="true" className="goal-bar-icon">
					<Target size={14} />
				</span>
				<div className="goal-bar-copy">
					<strong>{t(statusLabelKey(goal.status))}</strong>
					<span className="goal-bar-objective" title={goal.objective}>
						{goal.objective}
					</span>
				</div>
				<span aria-live="off" className="goal-bar-elapsed">
					{formatElapsed(goalElapsedMs(goal, now))}
				</span>
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
			</section>
		</div>
	);
}
