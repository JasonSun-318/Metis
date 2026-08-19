import type { AgentMode, ClientResult, ScheduleTaskView, SessionSummary } from "@metis/app-protocol";
import { ArrowRight, CaretDown, CaretRight, ChatCircleDots, ClockCountdown, Code, FolderSimple, NotePencil, SidebarSimple, Sparkle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopUpdateState, MetisDesktopApi } from "../../shared/desktop-api.ts";
import { localeForIntl } from "../i18n.ts";
import type { AppStoreSnapshot } from "../store/app-store.ts";
import type { ProjectPreference, ProjectPreferenceMap } from "../store/project-preferences.ts";
import {
	DEFAULT_SESSION_GROUPING,
	groupSessionsByDate,
	groupSessionsByUnread,
	loadSessionGroupingPreferences,
	saveSessionGroupingPreferences,
	type SessionGroupBy,
	sessionsForMode,
} from "../store/session-grouping.ts";
import { ProjectActions } from "./ProjectActions.tsx";
import { AccountMenu } from "./AccountMenu.tsx";
import { SessionActions } from "./SessionActions.tsx";
import { SessionGroupingMenu } from "./SessionGroupingMenu.tsx";
import { ScheduledTaskActions } from "./ScheduledTaskActions.tsx";

export type SidebarDestination = "tasks" | "skills" | "schedules";

const SESSION_SIDEBAR_DEFAULT_WIDTH = 302;
const SESSION_SIDEBAR_NARROW_WIDTH = 232;
const SESSION_SIDEBAR_MAX_WIDTH = SESSION_SIDEBAR_DEFAULT_WIDTH * 2;

/** Mirrors the @media (max-width: 980px) override in app.css. */
export function sessionSidebarDefaultWidth(): number {
	return window.innerWidth <= 980 ? SESSION_SIDEBAR_NARROW_WIDTH : SESSION_SIDEBAR_DEFAULT_WIDTH;
}

export function clampSessionSidebarPreferredWidth(value: number): number {
	return Math.max(SESSION_SIDEBAR_NARROW_WIDTH, Math.min(SESSION_SIDEBAR_MAX_WIDTH, Math.round(value)));
}

export function clampSessionSidebarWidth(value: number, viewportWidth = window.innerWidth): number {
	const maximum = Math.max(SESSION_SIDEBAR_NARROW_WIDTH, Math.min(SESSION_SIDEBAR_MAX_WIDTH, Math.floor(viewportWidth / 3)));
	return Math.min(maximum, clampSessionSidebarPreferredWidth(value));
}

interface SessionSidebarProps {
	readonly state: AppStoreSnapshot;
	readonly platform: string;
	readonly busy: boolean;
	readonly mode: AgentMode;
	readonly destination: SidebarDestination;
	readonly newTaskOpen: boolean;
	readonly onModeChange: (mode: AgentMode) => void;
	readonly onNewTask: () => void;
	readonly onOpen: (sessionId: string) => Promise<void>;
	readonly onDeleteSession: (session: SessionSummary) => Promise<void>;
	readonly onPinSession: (session: SessionSummary, pinned: boolean) => void;
	readonly onRenameSession: (session: SessionSummary, name: string) => Promise<void>;
	readonly onCreateProjectSession: (group: ProjectSessionGroup) => Promise<void>;
	readonly onDeleteProject: (
		group: ProjectSessionGroup,
		preview: ClientResult<"project/deletePreview">,
	) => Promise<void>;
	readonly onPinProject: (group: ProjectSessionGroup, pinned: boolean) => void;
	readonly onPreviewProjectDelete: (
		group: ProjectSessionGroup,
	) => Promise<ClientResult<"project/deletePreview">>;
	readonly onRenameProject: (group: ProjectSessionGroup, alias: string) => void;
	readonly onSettings: () => void;
	readonly onUpdate: () => void;
	readonly onSkills: () => void;
	readonly onSchedules: () => void;
	readonly onOpenSchedule: (taskId: string) => void;
	readonly onDeleteSchedule: MetisDesktopApi["deleteSchedule"];
	readonly onToggle: () => void;
	readonly onWidthChange: (width: number, persist?: boolean) => void;
	readonly projectBusy: (group: ProjectSessionGroup) => boolean;
	readonly preferences: ProjectPreferenceMap;
	readonly pinnedSessionIds: ReadonlySet<string>;
	readonly scheduleTasks: readonly ScheduleTaskView[];
	readonly selectedScheduleTaskId: string | null;
	readonly updateState: DesktopUpdateState;
	readonly width: number;
}

export interface ProjectSessionGroup {
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly name: string;
	readonly pinned: boolean;
	readonly sessions: readonly SessionSummary[];
}

export interface SessionTree {
	readonly projects: readonly ProjectSessionGroup[];
	readonly tasks: readonly SessionSummary[];
}

function projectName(cwd: string): string {
	return cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd;
}

export function buildSessionTree(
	state: AppStoreSnapshot,
	mode: AgentMode,
	preferences: ProjectPreferenceMap,
	excludedSessionIds: ReadonlySet<string> = new Set(),
): SessionTree {
	const modePreferences = new Map<string, ProjectPreference>();
	for (const preference of preferences.values()) {
		if (preference.mode === mode) modePreferences.set(preference.cwd, preference);
	}
	const projects = new Map<string, SessionSummary[]>();
	const tasks: SessionSummary[] = [];
	for (const session of sessionsForMode(state, mode)) {
		if (session.scheduled) continue;
		if (session.cwdOrigin === "managed" || !session.cwd) {
			if (!excludedSessionIds.has(session.sessionId)) tasks.push(session);
			continue;
		}
		const sessions = projects.get(session.cwd) ?? [];
		if (!excludedSessionIds.has(session.sessionId)) sessions.push(session);
		projects.set(session.cwd, sessions);
	}
	const groups = [...projects].map(([cwd, sessions]) => {
		const preference = modePreferences.get(cwd);
		return { mode, cwd, name: preference?.alias ?? projectName(cwd), pinned: preference?.pinned ?? false, sessions };
	});
	return {
		projects: [...groups.filter((group) => group.pinned), ...groups.filter((group) => !group.pinned)],
		tasks,
	};
}

export function taskTitle(session: SessionSummary, locale: Intl.LocalesArgument = "en-US", taskLabel = "Task"): string {
	if (session.name) return session.name;
	return `${taskLabel} · ${new Date(session.createdAt).toLocaleDateString(locale, { month: "short", day: "numeric" })}`;
}

interface RendererWindowView {
	readonly innerWidth?: number;
	readonly innerHeight?: number;
	readonly screen?: { readonly width: number; readonly height: number };
	addEventListener?(type: "resize", listener: () => void): void;
	removeEventListener?(type: "resize", listener: () => void): void;
}

function windowIsFullscreen(): boolean {
	const runtime = globalThis as RendererWindowView;
	return runtime.screen !== undefined && runtime.innerWidth === runtime.screen.width && runtime.innerHeight === runtime.screen.height;
}

function SessionButton({ busy, deleteDisabled, onDelete, onPin, onRename, pinned, selected, session, onOpen }: {
	readonly busy: boolean;
	readonly deleteDisabled: boolean;
	readonly onDelete: (session: SessionSummary) => Promise<void>;
	readonly onPin: (session: SessionSummary, pinned: boolean) => void;
	readonly onRename: (session: SessionSummary, name: string) => Promise<void>;
	readonly pinned: boolean;
	readonly selected: boolean;
	readonly session: SessionSummary;
	readonly onOpen: (sessionId: string) => Promise<void>;
}) {
	const { t, i18n } = useTranslation();
	const title = taskTitle(session, localeForIntl(i18n.resolvedLanguage), t("Task"));
	const running = session.state === "running";
	const notification = !selected && session.unread;
	const indicator = notification && session.attentionRequired
		? "attention"
		: notification && session.lastTurnOutcome === "failed"
			? "failed"
			: notification && session.lastTurnOutcome === "completed"
				? "completed"
				: running
					? "running"
					: notification
						? "unread"
						: undefined;
	const indicatorDescription = indicator === "attention"
		? t("Needs attention")
		: indicator === "running"
			? t("Running")
			: indicator === "failed"
				? t("Failed")
				: indicator === "completed"
					? t("Completed")
					: undefined;
	return (
		<div className="session-row" data-scheduled={session.scheduled ? "true" : undefined}>
			<button
				aria-busy={running || undefined}
				aria-current={selected ? "page" : undefined}
				aria-description={indicatorDescription}
				aria-label={title}
				className="session-button"
				disabled={busy}
				onClick={() => void onOpen(session.sessionId)}
				title={title}
				type="button"
			>
				<span className="session-button-title"><i aria-hidden="true" className={indicator} />{title}</span>
			</button>
			<SessionActions
				allowRename={!session.scheduled}
				deleteDisabled={deleteDisabled}
				disabled={busy}
				displayName={title}
				onDelete={onDelete}
				onPin={onPin}
				onRename={onRename}
				pinned={pinned}
				session={session}
			/>
		</div>
	);
}

function SessionSection({ children, label }: { readonly children: ReactNode; readonly label: string }) {
	const [open, setOpen] = useState(true);
	return (
		<section className="session-section" data-open={open}>
			<button aria-expanded={open} className="session-section-heading" onClick={() => setOpen((current) => !current)} type="button">
				<span>{label}</span>
				{open ? <CaretDown aria-hidden="true" size={12} /> : <CaretRight aria-hidden="true" size={12} />}
			</button>
			<div className="session-section-drawer" inert={!open}>
				<div className="session-section-items">{children}</div>
			</div>
		</section>
	);
}

function ProjectGroup({
	actionsActive,
	busy,
	group,
	onActivateActions,
	onCreateProjectSession,
	onDeactivateActions,
	onDeleteProject,
	onDeleteSession,
	onOpen,
	onPinSession,
	onPinProject,
	onPreviewProjectDelete,
	onRenameProject,
	onRenameSession,
	isDeleteDisabled,
	selectedSessionId,
}: {
	readonly actionsActive: boolean;
	readonly busy: boolean;
	readonly group: ProjectSessionGroup;
	readonly onActivateActions: () => void;
	readonly onCreateProjectSession: (group: ProjectSessionGroup) => Promise<void>;
	readonly onDeactivateActions: () => void;
	readonly onDeleteProject: (
		group: ProjectSessionGroup,
		preview: ClientResult<"project/deletePreview">,
	) => Promise<void>;
	readonly onDeleteSession: (session: SessionSummary) => Promise<void>;
	readonly onOpen: (sessionId: string) => Promise<void>;
	readonly onPinSession: (session: SessionSummary, pinned: boolean) => void;
	readonly onPinProject: (group: ProjectSessionGroup, pinned: boolean) => void;
	readonly onPreviewProjectDelete: (
		group: ProjectSessionGroup,
	) => Promise<ClientResult<"project/deletePreview">>;
	readonly onRenameProject: (group: ProjectSessionGroup, alias: string) => void;
	readonly onRenameSession: (session: SessionSummary, name: string) => Promise<void>;
	readonly isDeleteDisabled: (session: SessionSummary) => boolean;
	readonly selectedSessionId: string | null;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(true);
	return (
		<div className="project-group" data-open={open}>
			<button
				aria-expanded={open}
				aria-label={t(open ? "Collapse {{name}} project" : "Expand {{name}} project", { name: group.name })}
				className="project-heading"
				onClick={() => setOpen((current) => !current)}
				title={group.cwd}
				type="button"
			>
				<FolderSimple aria-hidden="true" size={17} />
				<span>{group.name}</span>
			</button>
			<ProjectActions
				active={actionsActive}
				busy={busy}
				group={group}
				onActivate={onActivateActions}
				onCreate={onCreateProjectSession}
				onDeactivate={onDeactivateActions}
				onDelete={onDeleteProject}
				onPin={onPinProject}
				onPreviewDelete={onPreviewProjectDelete}
				onRename={onRenameProject}
			/>
			<div className="project-drawer" inert={!open}>
				<div className="project-sessions">
					{group.sessions.map((session) => (
						<SessionButton busy={busy} deleteDisabled={isDeleteDisabled(session)} key={session.sessionId} onDelete={onDeleteSession} onOpen={onOpen} onPin={onPinSession} onRename={onRenameSession} pinned={false} selected={selectedSessionId === session.sessionId} session={session} />
					))}
				</div>
			</div>
		</div>
	);
}

export function SessionSidebar({
	state,
	platform,
	busy,
	mode,
	destination,
	newTaskOpen,
	onModeChange,
	onNewTask,
	onOpen,
	onDeleteSession,
	onPinSession,
	onCreateProjectSession,
	onDeleteProject,
	onPinProject,
	onPreviewProjectDelete,
	onRenameProject,
	onRenameSession,
	onSettings,
	onUpdate,
	onSkills,
	onSchedules,
	onOpenSchedule,
	onDeleteSchedule,
	onToggle,
	onWidthChange,
	projectBusy,
	preferences,
	pinnedSessionIds,
	scheduleTasks,
	selectedScheduleTaskId,
	updateState,
	width,
}: SessionSidebarProps) {
	const { t, i18n } = useTranslation();
	const locale = localeForIntl(i18n.resolvedLanguage);
	const scheduledTaskIds = useMemo(() => new Set(scheduleTasks.map(({ id }) => id)), [scheduleTasks]);
	const visibleScheduleTasks = scheduleTasks.filter(
		(task) => task.status === "active" || task.status === "paused",
	);
	const scheduledSessions = sessionsForMode(state, mode).filter(
		(session) => session.scheduled && !scheduledTaskIds.has(session.scheduled.taskId),
	);
	const tree = buildSessionTree(state, mode, preferences, pinnedSessionIds);
	const [fullscreen, setFullscreen] = useState(windowIsFullscreen);
	const resizeRef = useRef<{ readonly pointerId: number; readonly x: number; readonly width: number } | null>(null);
	const [activeProjectActions, setActiveProjectActions] = useState<string | null>(null);
	const [groupingByMode, setGroupingByMode] = useState(() => {
		try {
			return loadSessionGroupingPreferences(localStorage);
		} catch {
			return DEFAULT_SESSION_GROUPING;
		}
	});
	const grouping = groupingByMode[mode];
	const allSessions = sessionsForMode(state, mode).filter((session) => session.scheduled === undefined);
	const pinnedSessions = allSessions.filter((session) => pinnedSessionIds.has(session.sessionId));
	const sessions = allSessions.filter((session) => !pinnedSessionIds.has(session.sessionId));
	const hasSessions = allSessions.length > 0;
	useEffect(() => {
		const runtime = globalThis as RendererWindowView;
		const updateFullscreen = () => setFullscreen(windowIsFullscreen());
		runtime.addEventListener?.("resize", updateFullscreen);
		return () => runtime.removeEventListener?.("resize", updateFullscreen);
	}, []);
	useEffect(() => setActiveProjectActions(null), [destination, mode]);
	const isDeleteDisabled = (session: SessionSummary) =>
		session.state === "running" ||
		(state.activeSessionId === session.sessionId && state.activeTurnId !== null) ||
		state.interactionOrder.some((interactionId) =>
			state.interactionsById.get(interactionId)?.sessionId === session.sessionId,
		);
	const selectedSessionId = !newTaskOpen && destination === "tasks" ? state.activeSessionId : null;
	const updateLabel = updateState.status === "available"
		? t("Update to new version")
		: updateState.status === "downloading"
			? t("Downloading update {{progress}}%", { progress: updateState.progress })
			: updateState.status === "ready"
				? t("Open installer")
				: null;
	const renderSession = (session: SessionSummary) => (
		<SessionButton
			busy={busy}
			deleteDisabled={isDeleteDisabled(session)}
			key={session.sessionId}
			onDelete={onDeleteSession}
			onOpen={onOpen}
			onPin={onPinSession}
			onRename={onRenameSession}
			pinned={pinnedSessionIds.has(session.sessionId)}
			selected={selectedSessionId === session.sessionId}
			session={session}
		/>
	);

	return (
		<aside className="session-sidebar" aria-label={t("Tasks")} data-fullscreen={fullscreen || undefined} data-platform={platform}>
			<div className="window-drag-region">
				<div className="sidebar-titlebar-controls">
					<button aria-label={t("Hide sessions sidebar")} onClick={onToggle} type="button">
						<SidebarSimple aria-hidden="true" size={15} />
					</button>
				</div>
			</div>
			<div className="mode-switch" data-mode={mode} aria-label={t("Workspace mode")} role="group">
				<span aria-hidden="true" className="mode-switch-indicator" />
				<button aria-pressed={mode === "chat"} className={mode === "chat" ? "active" : ""} disabled={busy} onClick={() => onModeChange("chat")} type="button">
					<ChatCircleDots aria-hidden="true" size={15} />
					{t("Chat")}
				</button>
				<button aria-pressed={mode === "code"} className={mode === "code" ? "active" : ""} disabled={busy} onClick={() => onModeChange("code")} type="button">
					<Code aria-hidden="true" size={15} />
					{t("Code")}
				</button>
			</div>
			<button aria-current={newTaskOpen ? "page" : undefined} className="new-task-button" disabled={busy} onClick={onNewTask} type="button">
				<NotePencil aria-hidden="true" size={18} />
				{t("New task")}
			</button>
			<button aria-current={destination === "skills" ? "page" : undefined} className="sidebar-nav-button" disabled={busy} onClick={onSkills} type="button">
				<Sparkle aria-hidden="true" size={17} />
				{t("Customize")}
			</button>
			{mode === "chat" && <button aria-current={destination === "schedules" ? "page" : undefined} className="sidebar-nav-button" disabled={busy} onClick={onSchedules} type="button"><ClockCountdown aria-hidden="true" size={17} />{t("Scheduled tasks")}</button>}
			<nav aria-label={t("{{mode}} sessions", { mode: t(mode === "chat" ? "Chat" : "Code") })} className="project-list" data-empty={!hasSessions || undefined} data-grouping={grouping}>
				{grouping === "project" && <span className="session-grouping-label">{t("Projects")}</span>}
				<SessionGroupingMenu
					onChange={(nextGrouping: SessionGroupBy) => {
							setGroupingByMode((current) => {
								const next = { ...current, [mode]: nextGrouping };
								try {
									saveSessionGroupingPreferences(localStorage, next);
								} catch {
									// The preference remains renderer-local when storage is unavailable.
								}
								return next;
							});
					}}
					value={grouping}
				/>
				{!hasSessions && <p className="empty-copy">{t("No {{mode}} tasks yet.", { mode: t(mode === "chat" ? "Chat" : "Code") })}</p>}
				{pinnedSessions.length > 0 && (
					<SessionSection label={t("Pinned")}>
						{pinnedSessions.map(renderSession)}
					</SessionSection>
				)}
				{grouping === "project" && tree.projects.map((group) => (
					<ProjectGroup
						actionsActive={activeProjectActions === JSON.stringify([group.mode, group.cwd])}
						busy={busy || projectBusy(group)}
						group={group}
						key={JSON.stringify([group.mode, group.cwd])}
						onActivateActions={() => setActiveProjectActions(JSON.stringify([group.mode, group.cwd]))}
						onCreateProjectSession={onCreateProjectSession}
						onDeactivateActions={() => setActiveProjectActions(null)}
						onDeleteProject={onDeleteProject}
						onDeleteSession={onDeleteSession}
						isDeleteDisabled={isDeleteDisabled}
						onOpen={onOpen}
						onPinSession={onPinSession}
						onPinProject={onPinProject}
						onPreviewProjectDelete={onPreviewProjectDelete}
						onRenameProject={onRenameProject}
						onRenameSession={onRenameSession}
						selectedSessionId={selectedSessionId}
					/>
				))}
				{grouping === "project" && tree.tasks.length > 0 && (
					<section className="loose-tasks">
						<h2>{t("Tasks")}</h2>
						{tree.tasks.map(renderSession)}
					</section>
				)}
				{grouping === "date" && groupSessionsByDate(sessions, new Date(), locale).map((section) => (
					<SessionSection key={`${mode}:date:${section.key}`} label={t(section.label)}>
						{section.sessions.map(renderSession)}
					</SessionSection>
				))}
				{grouping === "unread" && groupSessionsByUnread(sessions).map((section) => (
					<SessionSection key={`${mode}:unread:${section.key}`} label={t(section.label)}>
						{section.sessions.map(renderSession)}
					</SessionSection>
				))}
				{grouping === "none" && sessions.map(renderSession)}
				{mode === "chat" && (visibleScheduleTasks.length > 0 || scheduledSessions.length > 0) && (
					<section aria-label={t("Scheduled tasks")} className="scheduled-task-quick-list">
						<h2>{t("Scheduled tasks")}</h2>
						{visibleScheduleTasks.slice(0, 6).map((task) => (
							<div className="session-row scheduled-task-quick-row" key={task.id}>
								<button
									aria-current={destination === "schedules" && task.id === selectedScheduleTaskId ? "page" : undefined}
									aria-label={task.name}
									className="scheduled-task-quick-open"
									disabled={busy}
									onClick={() => onOpenSchedule(task.id)}
									type="button"
								>
									<span className={`scheduled-task-quick-dot state-${task.status}`} />
									<span>{task.name}</span>
									<small>{t(task.schedule.kind === "once" ? "Once" : task.schedule.kind)}</small>
									{task.unreadCount > 0 && <i>{task.unreadCount}</i>}
								</button>
								<ScheduledTaskActions deleteDisabled={task.activeRunId !== undefined} disabled={busy} onDelete={onDeleteSchedule} task={task} />
							</div>
						))}
						{scheduledSessions.map(renderSession)}
					</section>
				)}
			</nav>
			{updateLabel && (
				<div className="sidebar-update-notice">
					<button
						aria-label={updateLabel}
						className="sidebar-update-button"
						disabled={updateState.status === "downloading"}
						onClick={onUpdate}
						type="button"
					>
						<span>{updateLabel}</span>
						<ArrowRight aria-hidden="true" size={15} />
					</button>
				</div>
			)}
			<div className="sidebar-footer"><AccountMenu onSettings={onSettings} /></div>
			<div
				aria-label={t("Resize sessions sidebar")}
				aria-orientation="vertical"
				className="session-sidebar-resizer"
				onKeyDown={(event) => {
					if (event.key === "ArrowLeft") onWidthChange(width - 16);
					else if (event.key === "ArrowRight") onWidthChange(width + 16);
					else return;
					event.preventDefault();
				}}
				onPointerDown={(event) => {
					resizeRef.current = { pointerId: event.pointerId, x: event.clientX, width };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					const start = resizeRef.current;
					if (!start || start.pointerId !== event.pointerId) return;
					onWidthChange(start.width + event.clientX - start.x, false);
				}}
				onPointerUp={(event) => {
					const start = resizeRef.current;
					if (start?.pointerId === event.pointerId) {
						onWidthChange(start.width + event.clientX - start.x);
						resizeRef.current = null;
					}
					if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
				}}
				onPointerCancel={(event) => {
					const start = resizeRef.current;
					if (start?.pointerId === event.pointerId) onWidthChange(start.width, false);
					resizeRef.current = null;
				}}
				onLostPointerCapture={(event) => {
					const start = resizeRef.current;
					if (start?.pointerId === event.pointerId) onWidthChange(start.width, false);
					resizeRef.current = null;
				}}
				role="separator"
				tabIndex={0}
			/>
		</aside>
	);
}
