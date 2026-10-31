import type { SessionTaskView } from "@metis/app-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretRight, CheckCircle, CircleNotch, ListChecks } from "../icons.tsx";
export function TaskList({ tasks }: { readonly tasks: readonly SessionTaskView[] }) {
	const { t } = useTranslation();
	const completed = tasks.filter((task) => task.completed).length;
	const done = tasks.length > 0 && completed === tasks.length;
	const [expanded, setExpanded] = useState(!done);
	useEffect(() => setExpanded(!done), [done]);
	if (tasks.length === 0) return null;
	return (
		<section className="conversation-interaction-card conversation-tasks" aria-label={t("Tasks")}>
			<button
				className="conversation-card-heading"
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
			>
				<ListChecks aria-hidden="true" size={16} />
				<strong>{t(done ? "Completed" : "Tasks")}</strong>
				<span>
					{completed}/{tasks.length}
				</span>
				<CaretRight className="conversation-task-chevron" aria-hidden="true" size={13} />
			</button>
			<div
				className="transcript-drawer"
				data-open={expanded ? "true" : undefined}
				inert={!expanded}
				aria-hidden={!expanded}
			>
				<div>
					<ul className="conversation-task-items">
						{tasks.map((task, index) => (
							/* biome-ignore lint/suspicious/noArrayIndexKey: Task snapshots are ordered and contain no row-local state. */
							<li key={index} className={task.completed ? "is-completed" : undefined}>
								{task.completed ? (
									<CheckCircle aria-hidden="true" size={15} />
								) : (
									<CircleNotch aria-hidden="true" className="task-list-spinner" size={15} />
								)}
								<span>{task.task}</span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</section>
	);
}
