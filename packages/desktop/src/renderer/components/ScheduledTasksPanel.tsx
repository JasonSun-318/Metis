import type { ModelOptionView, ScheduleTaskView, SessionSummary } from "@metis/app-protocol";
import { ChatCircleDots, FolderSimple, Gear, Info, MagnifyingGlass, Sun, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import scheduleEmptyIcon from "../assets/scheduled-tasks-empty.svg";
import { localeForIntl } from "../i18n.ts";
import { useScheduleStore } from "../hooks/use-schedule-store.ts";
import type { ScheduleStore } from "../store/schedule-store.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import { ScheduledTaskDetail, scheduleLabel } from "./ScheduledTaskDetail.tsx";
import { ScheduledTaskDialog } from "./ScheduledTaskDialog.tsx";
import { TracedSvgIcon } from "./TracedSvgIcon.tsx";

export const SCHEDULE_KEEP_AWAKE_KEY = "metis.scheduleKeepAwake.v1";
type Sort = "next_run" | "updated" | "name";
const SORT_OPTIONS = [
	{ value: "next_run", label: "Next run" },
	{ value: "updated", label: "Last updated" },
	{ value: "name", label: "Name" },
] as const;
type NewTaskAction = "" | "assisted" | "manual";

function NewTaskMenu({
	className,
	disabled,
	onAssisted,
	onManual,
}: {
	readonly className?: string;
	readonly disabled: boolean;
	readonly onAssisted: () => void;
	readonly onManual: () => void;
}) {
	const { t } = useTranslation();
	return (
			<MenuSelect<NewTaskAction>
				ariaLabel={t("Create scheduled task")}
				className={`scheduled-task-new-menu ${className ?? ""}`.trim()}
				disabled={disabled}
				menuAlign="end"
				menuMinWidth={204}
			onChange={(action) => {
				if (action === "assisted") onAssisted();
				else if (action === "manual") onManual();
			}}
			options={[
				{ value: "assisted", label: t("Create with Metis"), icon: <ChatCircleDots aria-hidden="true" size={17} /> },
				{ value: "manual", label: t("Set up manually"), icon: <Gear aria-hidden="true" size={17} /> },
			]}
			placeholder={t("New task")}
			value=""
		/>
	);
}

function AssistedScheduleWorkspaceDialog({
	api,
	onClose,
	onCreate,
}: {
	readonly api: MetisDesktopApi;
	readonly onClose: () => void;
	readonly onCreate: (cwd: string | null) => Promise<void>;
}) {
	const { t } = useTranslation();
	const dialog = useRef<HTMLDialogElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		dialog.current?.showModal?.();
		return () => dialog.current?.close?.();
	}, []);

	const create = async (cwd: string | null) => {
		setBusy(true);
		setError(null);
		let created = false;
		try {
			await onCreate(cwd);
			created = true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The Chat could not be created.");
		} finally {
			setBusy(false);
		}
		if (created) onClose();
	};
	const chooseFolder = async () => {
		setBusy(true);
		setError(null);
		let cwd: string | null = null;
		try {
			cwd = await api.selectProjectFolder();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The folder could not be selected.");
		} finally {
			setBusy(false);
		}
		if (cwd) await create(cwd);
	};

	return (
		<dialog
			aria-labelledby="assisted-schedule-workspace-title"
			className="scheduled-task-workspace-dialog"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) onClose();
			}}
			ref={dialog}
		>
			<div>
				<header>
					<div>
						<h2 id="assisted-schedule-workspace-title">{t("Where should this task work?")}</h2>
						<p>{t("Choose a folder for project files, or use a dedicated task workspace.")}</p>
					</div>
					<button aria-label={t("Close")} disabled={busy} onClick={onClose} type="button">
						<X aria-hidden="true" size={17} />
					</button>
				</header>
				<div className="scheduled-task-workspace-options">
					<button disabled={busy} onClick={() => void chooseFolder()} type="button">
						<FolderSimple aria-hidden="true" size={21} />
						<span><strong>{t("Choose folder")}</strong><small>{t("Work directly in a folder on your computer.")}</small></span>
					</button>
					<button disabled={busy} onClick={() => void create(null)} type="button">
						<ChatCircleDots aria-hidden="true" size={21} />
						<span><strong>{t("Use default workspace")}</strong><small>{t("Use a dedicated workspace managed by Metis.")}</small></span>
					</button>
				</div>
				{error && <p className="scheduled-task-form-error" role="alert">{t(error)}</p>}
			</div>
		</dialog>
	);
}

function nextRunLabel(task: ScheduleTaskView, locale: string, t: (key: string) => string): string {
	if (!task.nextRunAt) return t(task.status === "completed" ? "Completed" : "No next run");
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(task.nextRunAt));
}

export function ScheduledTasksPanel({ api, onCreateWithMetis, onOpenSession, onSelectTask, selectedTaskId, serverReady, sessions, store }: {
	readonly api: MetisDesktopApi;
	readonly onCreateWithMetis: (cwd: string | null) => Promise<void>;
	readonly onOpenSession: (sessionId: string) => void;
	readonly onSelectTask: (taskId: string | null) => void;
	readonly selectedTaskId: string | null;
	readonly serverReady: boolean;
	readonly sessions: readonly SessionSummary[];
	readonly store: ScheduleStore;
}) {
	const { t, i18n } = useTranslation();
	const intlLocale = localeForIntl(i18n.resolvedLanguage);
	const scheduleState = useScheduleStore(store);
	const [tasks, setTasks] = useState<readonly ScheduleTaskView[]>([]);
	const [nextAfterTaskId, setNextAfterTaskId] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<Sort>("next_run");
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [listError, setListError] = useState<string | null>(null);
	const [modelError, setModelError] = useState<string | null>(null);
	const [keepAwakeError, setKeepAwakeError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const [models, setModels] = useState<readonly ModelOptionView[]>([]);
	const [modelsLoading, setModelsLoading] = useState(true);
	const [dialogTask, setDialogTask] = useState<ScheduleTaskView | null | undefined>(undefined);
	const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
	const [keepAwake, setKeepAwake] = useState(() => localStorage.getItem(SCHEDULE_KEEP_AWAKE_KEY) === "true");
	const [keepAwakeBusy, setKeepAwakeBusy] = useState(false);
	const listGeneration = useRef(0);
	const selectedTask = selectedTaskId ? scheduleState.tasksById.get(selectedTaskId) : undefined;

	useEffect(() => {
		if (!serverReady) return;
		setModelsLoading(true);
		void api.listModels()
			.then((result) => {
				setModels(result.models);
				setModelError(null);
			})
			.catch((cause) => {
				setModels([]);
				setModelError(cause instanceof Error ? cause.message : "Configured models could not be loaded.");
			})
			.finally(() => setModelsLoading(false));
	}, [api, reload, serverReady]);

	useEffect(() => {
		if (!serverReady) return;
		const generation = ++listGeneration.current;
		const timer = setTimeout(() => {
			setLoading(true);
			void api.listSchedules({ limit: 50, sort, ...(query.trim() ? { query: query.trim() } : {}) })
				.then((page) => {
					if (generation !== listGeneration.current) return;
					setTasks(page.tasks);
					setNextAfterTaskId(page.nextAfterTaskId);
					setListError(null);
				})
				.catch((cause) => {
					if (generation === listGeneration.current) setListError(cause instanceof Error ? cause.message : "Scheduled tasks could not be loaded.");
				})
				.finally(() => {
					if (generation === listGeneration.current) setLoading(false);
				});
		}, 160);
		return () => clearTimeout(timer);
	}, [api, query, reload, scheduleState.version, serverReady, sort]);

	const loadMore = async () => {
		if (!nextAfterTaskId || loadingMore) return;
		setLoadingMore(true);
		try {
			const page = await api.listSchedules({ afterTaskId: nextAfterTaskId, limit: 50, sort, ...(query.trim() ? { query: query.trim() } : {}) });
			setTasks((current) => [...current, ...page.tasks]);
			setNextAfterTaskId(page.nextAfterTaskId);
		} catch (cause) {
			setListError(cause instanceof Error ? cause.message : "More scheduled tasks could not be loaded.");
		} finally {
			setLoadingMore(false);
		}
	};

	const toggleKeepAwake = async (enabled: boolean) => {
		setKeepAwakeBusy(true);
		setKeepAwakeError(null);
		try {
			await api.setScheduleKeepAwake(enabled);
			setKeepAwake(enabled);
			localStorage.setItem(SCHEDULE_KEEP_AWAKE_KEY, String(enabled));
		} catch (cause) {
			setKeepAwakeError(cause instanceof Error ? cause.message : "Keep Awake could not be changed.");
		} finally {
			setKeepAwakeBusy(false);
		}
	};
	const error = modelError ?? listError ?? keepAwakeError;

	const saveTask = (task: ScheduleTaskView) => {
		store.upsertTask(task);
		setDialogTask(undefined);
		onSelectTask(task.id);
	};
	const retry = () => {
		const retryKeepAwake = keepAwakeError !== null;
		setListError(null);
		setModelError(null);
		setKeepAwakeError(null);
		setReload((value) => value + 1);
		if (retryKeepAwake) void toggleKeepAwake(keepAwake);
	};

	if (selectedTask) {
		return (
			<>
				<ScheduledTaskDetail
					api={api}
					onBack={() => onSelectTask(null)}
					onChanged={(task) => store.upsertTask(task)}
					onDeleted={(taskId) => { store.removeTask(taskId); onSelectTask(null); }}
					onEdit={() => setDialogTask(selectedTask)}
					onOpenSession={onOpenSession}
					task={selectedTask}
				/>
				{dialogTask && <ScheduledTaskDialog api={api} models={models} onClose={() => setDialogTask(undefined)} onSaved={saveTask} sessions={sessions} task={dialogTask} />}
			</>
		);
	}

	return (
		<section className="scheduled-tasks-panel">
					<header className="scheduled-tasks-header"><div><h1>{t("Scheduled tasks")}</h1><p>{t("Run tasks on a schedule or whenever you need them. Type /schedule in any existing task to set one up.")}</p></div><div><MenuSelect ariaLabel={t("Sort scheduled tasks")} className="scheduled-task-sort" onChange={setSort} options={SORT_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))} prefix={t("Sort by ")} value={sort} /><NewTaskMenu disabled={!serverReady || modelsLoading || models.length === 0} onAssisted={() => setWorkspaceDialogOpen(true)} onManual={() => setDialogTask(null)} /></div></header>
			<div className="scheduled-tasks-scroll"><div className="scheduled-tasks-layout">
				<div className="scheduled-tasks-toolbar"><MagnifyingGlass aria-hidden="true" size={16} /><input aria-label={t("Search scheduled tasks")} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search scheduled tasks…")} value={query} /></div>
						<div className="scheduled-tasks-notice"><span><Info aria-hidden="true" size={16} />{t("Scheduled tasks run only while Metis is open and your computer is awake and online.")}</span><label><Sun aria-hidden="true" size={16} />{t("Keep awake")} <input checked={keepAwake} disabled={keepAwakeBusy} onChange={(event) => void toggleKeepAwake(event.target.checked)} role="switch" type="checkbox" /></label></div>
				{error && <div className="scheduled-tasks-error" role="alert"><span>{t(error)}</span><button onClick={retry} type="button">{t("Retry")}</button></div>}
				{!modelsLoading && models.length === 0 && !modelError && <div className="scheduled-task-warning" role="status">{t("Configure a model provider before creating a scheduled task.")}</div>}
				<div className="scheduled-tasks-content">
										{loading && tasks.length === 0 ? <div className="scheduled-task-loading" role="status">{t("Loading scheduled tasks…")}</div> : tasks.length === 0 ? <div className="scheduled-tasks-empty"><TracedSvgIcon className="scheduled-tasks-empty-icon" src={scheduleEmptyIcon} /><h2>{t(query ? "No matching scheduled tasks" : "Create your first scheduled task")}</h2><p>{t(query ? "Try another name or description." : "Set a task to run once or on a recurring schedule.")}</p>{!query && <button className="settings-primary-button" disabled={!serverReady || modelsLoading || models.length === 0} onClick={() => setDialogTask(null)} type="button">{t("Create scheduled task")}</button>}</div> : <div className="scheduled-task-cards">{tasks.map((task) => (
						<button className="scheduled-task-card" key={task.id} onClick={() => onSelectTask(task.id)} type="button">
							<span className="scheduled-task-card-heading"><strong>{task.name}</strong><span className={`scheduled-task-state state-${task.status}`}>{t(task.activeRunId ? "Running" : task.status.replace("_", " "))}</span></span>
							{task.description && <p>{task.description}</p>}
							<span className="scheduled-task-card-summary"><span>{scheduleLabel(task.schedule, t)}</span>{task.unreadCount > 0 && <i aria-label={t("{{count}} unread runs", { count: task.unreadCount })}>{task.unreadCount}</i>}</span>
							<span className="scheduled-task-card-next">{t("Next: {{value}}", { value: nextRunLabel(task, intlLocale, t) })}</span>
						</button>
					))}</div>}
					{nextAfterTaskId && <button className="scheduled-task-load-more" disabled={loadingMore} onClick={() => void loadMore()} type="button">{t(loadingMore ? "Loading…" : "Load more")}</button>}
				</div>
				</div></div>
				{workspaceDialogOpen && <AssistedScheduleWorkspaceDialog api={api} onClose={() => setWorkspaceDialogOpen(false)} onCreate={onCreateWithMetis} />}
				{dialogTask !== undefined && <ScheduledTaskDialog api={api} models={models} onClose={() => setDialogTask(undefined)} onSaved={saveTask} sessions={sessions} {...(dialogTask ? { task: dialogTask } : {})} />}
		</section>
	);
}
