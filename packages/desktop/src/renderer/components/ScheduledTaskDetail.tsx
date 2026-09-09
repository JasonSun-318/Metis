import type { ScheduleRunView, ScheduleTaskView } from "@metis/app-protocol";
import { ArrowLeft, NotePencil, Play, Trash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { localeForIntl } from "../i18n.ts";
import { ScheduledTaskDeleteDialog } from "./ScheduledTaskDeleteDialog.tsx";

function dateTime(value: string | null | undefined, locale: string): string {
	return value ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

type Translate = (key: string, options?: Record<string, unknown>) => string;
const passthrough: Translate = (key, options) => Object.entries(options ?? {}).reduce((value, [name, replacement]) => value.replace(`{{${name}}}`, String(replacement)), key);

export function scheduleLabel(schedule: ScheduleTaskView["schedule"], t: Translate = passthrough): string {
	if (schedule.kind === "once") return t("Once on {{date}} at {{time}}", { date: schedule.date, time: schedule.time });
	if (schedule.kind === "daily") return t("Daily at {{time}}", { time: schedule.time });
	if (schedule.kind === "weekly") return t("Weekly on {{days}} at {{time}}", { days: schedule.weekdays.map((day) => t(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 1]!)).join(", "), time: schedule.time });
	if (schedule.kind === "monthly") return t("Monthly on day {{day}} at {{time}}", { day: schedule.day, time: schedule.time });
	return t("Every {{count}} {{unit}}", { count: schedule.every, unit: t(schedule.every === 1 ? schedule.unit : `${schedule.unit}s`) });
}

export function ScheduledTaskDetail({ api, task, onBack, onChanged, onDeleted, onEdit, onOpenSession }: {
	readonly api: MetisDesktopApi;
	readonly task: ScheduleTaskView;
	readonly onBack: () => void;
	readonly onChanged: (task: ScheduleTaskView) => void;
	readonly onDeleted: (taskId: string) => void;
	readonly onEdit: () => void;
	readonly onOpenSession: (sessionId: string) => void;
}) {
	const { t, i18n } = useTranslation();
	const intlLocale = localeForIntl(i18n.resolvedLanguage);
	const [runs, setRuns] = useState<readonly ScheduleRunView[]>([]);
	const [nextBeforeRunId, setNextBeforeRunId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const generation = useRef(0);
	const markRequests = useRef(new Map<string, string>());
	const runNowRequest = useRef<string | null>(null);
	const statusRequest = useRef<{ action: "pause" | "resume"; id: string } | null>(null);

	const loadRuns = async (beforeRunId?: string) => {
		const current = ++generation.current;
		if (!beforeRunId) setLoading(true);
		try {
			const page = await api.listScheduleRuns({ taskId: task.id, limit: 40, ...(beforeRunId ? { beforeRunId } : {}) });
			if (current !== generation.current) return;
			setRuns((existing) => beforeRunId ? [...existing, ...page.runs] : page.runs);
			setNextBeforeRunId(page.nextBeforeRunId);
			setError(null);
		} catch (cause) {
			if (current === generation.current) setError(cause instanceof Error ? cause.message : "Run history could not be loaded.");
		} finally {
			if (current === generation.current) setLoading(false);
		}
	};

	useEffect(() => {
		void loadRuns();
		return () => { generation.current += 1; };
	}, [task.id, task.lastRun?.id, task.lastRun?.status]);

	const mutate = async (operation: () => Promise<{ task: ScheduleTaskView }>) => {
		setBusy(true);
		setError(null);
		try {
			onChanged((await operation()).task);
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The scheduled task could not be updated.");
			return false;
		} finally {
			setBusy(false);
		}
	};

	const runNow = async () => {
		setBusy(true);
		setError(null);
		try {
			runNowRequest.current ??= crypto.randomUUID();
			await api.runScheduleNow({ taskId: task.id, requestId: runNowRequest.current });
			onChanged((await api.getSchedule({ taskId: task.id })).task);
			await loadRuns();
			runNowRequest.current = null;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The task could not be started.");
		} finally {
			setBusy(false);
		}
	};

	const toggleActive = async () => {
		const action = task.status === "active" ? "pause" : "resume";
		if (statusRequest.current?.action !== action) {
			statusRequest.current = { action, id: crypto.randomUUID() };
		}
		const requestId = statusRequest.current.id;
		const saved = await mutate(() => action === "pause"
			? api.pauseSchedule({ taskId: task.id, requestId })
			: api.resumeSchedule({ taskId: task.id, requestId }));
		if (saved) statusRequest.current = null;
	};

	const openRun = async (run: ScheduleRunView) => {
		setError(null);
		try {
			const validated = (await api.getScheduleRun({ taskId: task.id, runId: run.id })).run;
			if (validated.unread) {
				const requestId = markRequests.current.get(run.id) ?? crypto.randomUUID();
				markRequests.current.set(run.id, requestId);
				await api.markScheduleRunRead({ taskId: task.id, runId: run.id, requestId });
				markRequests.current.delete(run.id);
				setRuns((current) => current.map((item) => item.id === run.id ? { ...item, unread: false } : item));
			}
			if (validated.sessionId) onOpenSession(validated.sessionId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The scheduled run could not be opened.");
		}
	};

	const running = task.activeRunId !== undefined;
	return (
		<section className="scheduled-task-detail">
			<nav aria-label={t("Breadcrumb")} className="scheduled-task-breadcrumb"><button onClick={onBack} type="button"><ArrowLeft aria-hidden="true" size={14} /> {t("Scheduled tasks")}</button></nav>
			<header>
				<div className="scheduled-task-detail-heading">
					<h1>{task.name}</h1>
					{task.description && <p>{task.description}</p>}
					<div className="scheduled-task-status-line">
						<label><input aria-label={t("Active")} checked={task.status === "active"} disabled={busy || running || task.status === "completed" || task.status === "deleting"} onChange={() => void toggleActive()} role="switch" type="checkbox" /> {t(running ? "Running" : task.status.replace("_", " "))}</label>
						<span>{scheduleLabel(task.schedule, t)}</span>
					</div>
				</div>
				<div className="scheduled-task-detail-actions">
					<button className="scheduled-task-run-now" disabled={busy || running || task.status === "deleting"} onClick={() => void runNow()} type="button"><Play aria-hidden="true" size={14} /> {t("Run now")}</button>
					<button aria-label={t("Edit task")} title={t("Edit task")} disabled={busy || running} onClick={onEdit} type="button"><NotePencil aria-hidden="true" size={15} /></button>
					<button aria-label={t("Delete task")} title={t("Delete task")} disabled={busy || running} onClick={() => setConfirmDelete(true)} type="button"><Trash aria-hidden="true" size={15} /></button>
				</div>
			</header>
			{task.pauseReason === "model_unavailable" && <p className="scheduled-task-warning" role="status">{t("The selected model is no longer available. Edit the task and choose a configured model.")}</p>}
			{error && <p className="scheduled-task-form-error" role="alert">{t(error)}</p>}
			<div className="scheduled-task-detail-grid">
				<div className="scheduled-task-detail-main">
					<section aria-labelledby="schedule-instructions-heading" className="scheduled-task-instructions">
						<h2 id="schedule-instructions-heading">{t("Instructions")}</h2><p>{task.instruction}</p>
					</section>
					<section aria-labelledby="schedule-history-heading">
						<h2 id="schedule-history-heading">{t("History")}</h2>
						{loading ? <div className="scheduled-task-loading" role="status">{t("Loading run history…")}</div> : runs.length === 0 ? <p className="scheduled-task-muted">{t("No runs yet.")}</p> : (
							<ul className="scheduled-task-history">{runs.map((run) => (
								<li key={run.id}><button disabled={busy} onClick={() => void openRun(run)} type="button">
									<span className={`scheduled-run-dot run-${run.status}`} />
									<span className="scheduled-task-history-content"><span className="scheduled-task-history-heading"><strong>{t(run.status)}</strong><time dateTime={run.completedAt ?? run.createdAt}>{dateTime(run.completedAt ?? run.createdAt, intlLocale)}</time></span>{(run.resultPreview || run.error) && <small>{run.resultPreview || run.error?.message}</small>}</span>
									{run.unread && <i aria-label={t("Unread")} />}
								</button></li>
							))}</ul>
						)}
						{nextBeforeRunId && <button className="scheduled-task-load-more" disabled={loading} onClick={() => void loadRuns(nextBeforeRunId)} type="button">{t("Load older runs")}</button>}
					</section>
				</div>
				<aside aria-label={t("Settings")}>
					<dl className="scheduled-task-properties">
						<div><dt>{t("Next run")}</dt><dd>{dateTime(task.nextRunAt, intlLocale)}</dd></div>
						<div><dt>{t("Model")}</dt><dd>{task.model.provider} / {task.model.modelId}</dd></div>
						<div><dt>{t("Project")}</dt><dd>{task.target.workspace === "fixed" ? task.target.cwd : t("Dedicated task workspace")}</dd></div>
						<div><dt>{t("Time zone")}</dt><dd>{task.timezone}</dd></div>
					</dl>
					<details className="scheduled-task-permissions"><summary>{t("Permissions")}</summary><p>{t("Workspace files, web access, and available Skills. No Connectors, Extensions, or project memory.")}</p></details>
				</aside>
			</div>
			{confirmDelete && <ScheduledTaskDeleteDialog deleteSchedule={(input) => api.deleteSchedule(input)} onClose={() => setConfirmDelete(false)} onDeleted={() => { setConfirmDelete(false); onDeleted(task.id); }} task={task} />}
		</section>
	);
}
