import type { SessionTaskView } from "@metis/app-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretDown, CheckCircle, CircleNotch } from "../icons.tsx";

interface TaskListProps {
	readonly tasks: readonly SessionTaskView[];
}

const COMPLETION_HOLD_MS = 450;
const EXIT_MS = 200;

function TaskContent({ task }: { readonly task: SessionTaskView }) {
	const { t } = useTranslation();
	return (
		<>
			<span className="task-list-status">
				{task.completed ? (
					<CheckCircle aria-hidden="true" size={14} />
				) : (
					<CircleNotch aria-hidden="true" className="task-list-spinner" size={14} />
				)}
				<span className="sr-only">{t(task.completed ? "Completed" : "Working")}</span>
			</span>
			<span className="task-list-text" title={task.task}>
				{task.task}
			</span>
		</>
	);
}

function TaskRow({ task }: { readonly task: SessionTaskView }) {
	return (
		<li className={`task-list-row${task.completed ? " is-completed" : ""}`}>
			<TaskContent task={task} />
		</li>
	);
}

export function TaskList({ tasks }: TaskListProps) {
	const { t } = useTranslation();
	const allCompleted = tasks.length > 0 && tasks.every((task) => task.completed);
	const [expanded, setExpanded] = useState(true);
	const [visibility, setVisibility] = useState<"visible" | "closing" | "hidden">(() =>
		tasks.length > 0 && !allCompleted ? "visible" : "hidden",
	);

	useEffect(() => {
		if (tasks.length === 0) {
			setVisibility("hidden");
			return;
		}
		if (!allCompleted) {
			if (visibility !== "visible") setExpanded(true);
			setVisibility("visible");
			return;
		}
		if (visibility !== "visible") return;
		const timeout = window.setTimeout(() => setVisibility("closing"), COMPLETION_HOLD_MS);
		return () => window.clearTimeout(timeout);
	}, [allCompleted, tasks.length, visibility]);

	useEffect(() => {
		if (visibility !== "closing") return;
		const timeout = window.setTimeout(() => setVisibility("hidden"), EXIT_MS);
		return () => window.clearTimeout(timeout);
	}, [visibility]);

	if (tasks.length === 0 || visibility === "hidden") return null;

	const completed = tasks.filter((task) => task.completed).length;
	const current = tasks.find(({ completed }) => !completed) ?? tasks.at(-1)!;

	return (
		<div
			className={`task-list-slot${visibility === "closing" ? " is-closing" : ""}`}
			inert={visibility === "closing"}
		>
			<section aria-label={t("Tasks")} className={`task-list-panel${expanded ? "" : " is-collapsed"}`}>
				{expanded ? (
					<button
						aria-expanded={true}
						aria-label={t("Collapse task list")}
						className="task-list-header task-list-toggle"
						onClick={() => setExpanded(false)}
						type="button"
					>
						<span>
							{t("Tasks")}
							<small>
								{completed}/{tasks.length}
							</small>
						</span>
						<CaretDown aria-hidden="true" size={14} />
					</button>
				) : (
					<button
						aria-atomic="true"
						aria-expanded={false}
						aria-live="polite"
						className={`task-list-row task-list-summary task-list-toggle${current.completed ? " is-completed" : ""}`}
						onClick={() => setExpanded(true)}
						type="button"
					>
						<TaskContent task={current} />
						<span className="sr-only">{t("Expand task list")}</span>
						<CaretDown aria-hidden="true" size={14} />
					</button>
				)}
				<div aria-hidden={!expanded} className="task-list-drawer" inert={!expanded}>
					<ul aria-live="polite" className={`task-list-items${tasks.length > 5 ? " is-scrollable" : ""}`}>
						{tasks.map((task, index) => (
							/* biome-ignore lint/suspicious/noArrayIndexKey: The protocol supplies an ordered task snapshot without IDs; these rows have no local state. */
							<TaskRow key={index} task={task} />
						))}
					</ul>
				</div>
			</section>
		</div>
	);
}
