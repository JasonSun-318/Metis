import type { AgentMode, SessionSummary } from "@arcmind/app-protocol";
import { ChatCircleDots, Code, FolderSimple, MagnifyingGlass, NotePencil, SidebarSimple, Sparkle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { AppStoreSnapshot } from "../store/app-store.ts";

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
	readonly onSkills: () => void;
	readonly onToggle: () => void;
}

export interface ProjectSessionGroup {
	readonly cwd: string;
	readonly name: string;
	readonly sessions: readonly SessionSummary[];
}

export interface SessionTree {
	readonly projects: readonly ProjectSessionGroup[];
	readonly tasks: readonly SessionSummary[];
}

function projectName(cwd: string): string {
	return cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd;
}

export function buildSessionTree(state: AppStoreSnapshot, mode: AgentMode): SessionTree {
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
	return {
		projects: [...projects].map(([cwd, sessions]) => ({ cwd, name: projectName(cwd), sessions })),
		tasks,
	};
}

function taskTitle(session: SessionSummary): string {
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

function SessionButton({ busy, selected, session, onOpen }: {
	readonly busy: boolean;
	readonly selected: boolean;
	readonly session: SessionSummary;
	readonly onOpen: (sessionId: string) => Promise<void>;
}) {
	return (
		<button
			aria-current={selected ? "page" : undefined}
			className="session-button"
			disabled={busy}
			onClick={() => void onOpen(session.sessionId)}
			title={taskTitle(session)}
			type="button"
		>
			<span>{taskTitle(session)}</span>
			{session.state !== "idle" && <small>{session.state.replace("_", " ")}</small>}
		</button>
	);
}

function ProjectGroup({ busy, group, onOpen, selectedSessionId }: {
	readonly busy: boolean;
	readonly group: ProjectSessionGroup;
	readonly onOpen: (sessionId: string) => Promise<void>;
	readonly selectedSessionId: string | null;
}) {
	const [open, setOpen] = useState(true);
	return (
		<details className="project-group" onToggle={(event) => setOpen((event.currentTarget as unknown as { open: boolean }).open)} open={open}>
			<summary className="project-heading" title={group.cwd}>
				<FolderSimple aria-hidden="true" size={17} />
				<span>{group.name}</span>
			</summary>
			<div className="project-sessions">
				{group.sessions.map((session) => (
					<SessionButton busy={busy} key={session.sessionId} onOpen={onOpen} selected={selectedSessionId === session.sessionId} session={session} />
				))}
			</div>
		</details>
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
	onSkills,
	onToggle,
}: SessionSidebarProps) {
	const tree = buildSessionTree(state, mode);
	const hasSessions = tree.projects.length > 0 || tree.tasks.length > 0;
	const [fullscreen, setFullscreen] = useState(windowIsFullscreen);
	useEffect(() => {
		const runtime = globalThis as RendererWindowView;
		const updateFullscreen = () => setFullscreen(windowIsFullscreen());
		runtime.addEventListener?.("resize", updateFullscreen);
		return () => runtime.removeEventListener?.("resize", updateFullscreen);
	}, []);

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
						busy={busy}
						group={group}
						key={group.cwd}
						onOpen={onOpen}
						selectedSessionId={!newTaskOpen && destination === "tasks" ? state.activeSessionId : null}
					/>
				))}
				{tree.tasks.length > 0 && (
					<section className="loose-tasks">
						<h2>Tasks</h2>
						{tree.tasks.map((session) => (
							<SessionButton busy={busy} key={session.sessionId} onOpen={onOpen} selected={!newTaskOpen && destination === "tasks" && state.activeSessionId === session.sessionId} session={session} />
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
