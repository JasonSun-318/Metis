import type { AgentMode, ClientResult, SessionSummary } from "@arcmind/app-protocol";
import { ChatCircleDots, ClockCountdown, Code, FolderSimple, MagnifyingGlass, NotePencil, SidebarSimple, Sparkle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { AppStoreSnapshot } from "../store/app-store.ts";
import type { ProjectPreference, ProjectPreferenceMap } from "../store/project-preferences.ts";
import { ProjectActions } from "./ProjectActions.tsx";
import { SessionActions } from "./SessionActions.tsx";

export type SidebarDestination = "tasks" | "skills";

interface SessionSidebarProps {
	readonly state: AppStoreSnapshot;
	readonly busy: boolean;
	readonly mode: AgentMode;
	readonly destination: SidebarDestination;
	readonly newTaskOpen: boolean;
	readonly onModeChange: (mode: AgentMode) => void;
	readonly onNewTask: () => void;
	readonly onOpen: (sessionId: string) => Promise<void>;
	readonly onDeleteSession: (session: SessionSummary) => Promise<void>;
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
	readonly onSkills: () => void;
	readonly onToggle: () => void;
	readonly projectBusy: (group: ProjectSessionGroup) => boolean;
	readonly preferences: ProjectPreferenceMap;
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
): SessionTree {
	const modePreferences = new Map<string, ProjectPreference>();
	for (const preference of preferences.values()) {
		if (preference.mode === mode) modePreferences.set(preference.cwd, preference);
	}
	const projects = new Map<string, SessionSummary[]>();
	const tasks: SessionSummary[] = [];
	for (const sessionId of state.sessionOrder) {
		const session = state.sessionsById.get(sessionId);
		if (!session || session.mode !== mode) continue;
		if (session.cwdOrigin === "managed" || !session.cwd) {
			tasks.push(session);
			continue;
		}
		const sessions = projects.get(session.cwd) ?? [];
		sessions.push(session);
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

export function taskTitle(session: SessionSummary): string {
	if (session.name) return session.name;
	return `Task · ${new Date(session.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}`;
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

function SessionButton({ busy, deleteDisabled, onDelete, onRename, selected, session, onOpen }: {
	readonly busy: boolean;
	readonly deleteDisabled: boolean;
	readonly onDelete: (session: SessionSummary) => Promise<void>;
	readonly onRename: (session: SessionSummary, name: string) => Promise<void>;
	readonly selected: boolean;
	readonly session: SessionSummary;
	readonly onOpen: (sessionId: string) => Promise<void>;
}) {
	const title = taskTitle(session);
	return (
		<div className="session-row" data-scheduled={session.scheduled ? "true" : undefined}>
			<button
				aria-current={selected ? "page" : undefined}
				aria-label={title}
				className="session-button"
				disabled={busy}
				onClick={() => void onOpen(session.sessionId)}
				title={title}
				type="button"
			>
				<span>{title}</span>
				{session.scheduled
					? <small className="session-scheduled-badge"><ClockCountdown aria-hidden="true" size={11} /> Scheduled</small>
					: session.state !== "idle" && <small>{session.state.replace("_", " ")}</small>}
			</button>
			{!session.scheduled && (
				<SessionActions
					deleteDisabled={deleteDisabled}
					disabled={busy}
					displayName={title}
					onDelete={onDelete}
					onRename={onRename}
					session={session}
				/>
			)}
		</div>
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
	readonly onPinProject: (group: ProjectSessionGroup, pinned: boolean) => void;
	readonly onPreviewProjectDelete: (
		group: ProjectSessionGroup,
	) => Promise<ClientResult<"project/deletePreview">>;
	readonly onRenameProject: (group: ProjectSessionGroup, alias: string) => void;
	readonly onRenameSession: (session: SessionSummary, name: string) => Promise<void>;
	readonly isDeleteDisabled: (session: SessionSummary) => boolean;
	readonly selectedSessionId: string | null;
}) {
	const [open, setOpen] = useState(true);
	return (
		<div className="project-group" data-open={open}>
			<button
				aria-expanded={open}
				aria-label={`${open ? "Collapse" : "Expand"} ${group.name} project`}
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
						<SessionButton busy={busy} deleteDisabled={isDeleteDisabled(session)} key={session.sessionId} onDelete={onDeleteSession} onOpen={onOpen} onRename={onRenameSession} selected={selectedSessionId === session.sessionId} session={session} />
					))}
				</div>
			</div>
		</div>
	);
}

export function SessionSidebar({
	state,
	busy,
	mode,
	destination,
	newTaskOpen,
	onModeChange,
	onNewTask,
	onOpen,
	onDeleteSession,
	onCreateProjectSession,
	onDeleteProject,
	onPinProject,
	onPreviewProjectDelete,
	onRenameProject,
	onRenameSession,
	onSkills,
	onToggle,
	projectBusy,
	preferences,
}: SessionSidebarProps) {
	const tree = buildSessionTree(state, mode, preferences);
	const hasSessions = tree.projects.length > 0 || tree.tasks.length > 0;
	const [fullscreen, setFullscreen] = useState(windowIsFullscreen);
	const [activeProjectActions, setActiveProjectActions] = useState<string | null>(null);
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

	return (
		<aside className="session-sidebar" aria-label="Tasks" data-fullscreen={fullscreen || undefined}>
			<div className="window-drag-region">
				<div className="sidebar-titlebar-controls">
					<button aria-label="Hide sessions sidebar" onClick={onToggle} type="button">
						<SidebarSimple aria-hidden="true" size={15} />
					</button>
					<button aria-label="Search" title="Search (coming soon)" type="button">
						<MagnifyingGlass aria-hidden="true" size={15} />
					</button>
				</div>
			</div>
			<div className="mode-switch" data-mode={mode} aria-label="Workspace mode" role="group">
				<span aria-hidden="true" className="mode-switch-indicator" />
				<button aria-pressed={mode === "chat"} className={mode === "chat" ? "active" : ""} disabled={busy} onClick={() => onModeChange("chat")} type="button">
					<ChatCircleDots aria-hidden="true" size={15} />
					Chat
				</button>
				<button aria-pressed={mode === "code"} className={mode === "code" ? "active" : ""} disabled={busy} onClick={() => onModeChange("code")} type="button">
					<Code aria-hidden="true" size={15} />
					Code
				</button>
			</div>
			<button aria-current={newTaskOpen ? "page" : undefined} className="new-task-button" disabled={busy} onClick={onNewTask} type="button">
				<NotePencil aria-hidden="true" size={18} />
				New task
			</button>
			<button aria-current={destination === "skills" ? "page" : undefined} className="sidebar-nav-button" disabled={busy} onClick={onSkills} type="button">
				<Sparkle aria-hidden="true" size={17} />
				Skills
			</button>
			<nav className="project-list" aria-label={`${mode === "chat" ? "Chat" : "Code"} sessions`}>
				{!hasSessions && <p className="empty-copy">No {mode} tasks yet.</p>}
				{tree.projects.map((group) => (
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
						onPinProject={onPinProject}
						onPreviewProjectDelete={onPreviewProjectDelete}
						onRenameProject={onRenameProject}
						onRenameSession={onRenameSession}
						selectedSessionId={!newTaskOpen && destination === "tasks" ? state.activeSessionId : null}
					/>
				))}
				{tree.tasks.length > 0 && (
					<section className="loose-tasks">
						<h2>Tasks</h2>
						{tree.tasks.map((session) => (
							<SessionButton busy={busy} deleteDisabled={isDeleteDisabled(session)} key={session.sessionId} onDelete={onDeleteSession} onOpen={onOpen} onRename={onRenameSession} selected={!newTaskOpen && destination === "tasks" && state.activeSessionId === session.sessionId} session={session} />
						))}
					</section>
				)}
			</nav>
			<div className="sidebar-footer">
				<span className="account-mark">A</span>
				ArcMind
			</div>
		</aside>
	);
}
