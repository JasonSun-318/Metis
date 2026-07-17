import { FolderSimple, NotePencil } from "@phosphor-icons/react";
import type { SessionSummary } from "@arcmind/app-protocol";
import { useState, type FormEvent } from "react";
import type { AppStoreSnapshot } from "../store/app-store.ts";

interface SessionSidebarProps {
	readonly state: AppStoreSnapshot;
	readonly busy: boolean;
	readonly onCreate: (cwd: string) => Promise<void>;
	readonly onOpen: (sessionId: string) => Promise<void>;
}

export interface ProjectSessionGroup {
	readonly cwd: string;
	readonly name: string;
	readonly sessions: readonly SessionSummary[];
}

function projectName(cwd: string): string {
	return cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd;
}

export function groupSessionsByProject(state: AppStoreSnapshot): ProjectSessionGroup[] {
	const groups = new Map<string, SessionSummary[]>();
	for (const sessionId of state.sessionOrder) {
		const session = state.sessionsById.get(sessionId);
		if (!session) continue;
		const cwd = session.cwd ?? "";
		const sessions = groups.get(cwd) ?? [];
		sessions.push(session);
		groups.set(cwd, sessions);
	}
	return [...groups].map(([cwd, sessions]) => ({ cwd, name: cwd ? projectName(cwd) : "Other", sessions }));
}

function taskTitle(session: SessionSummary): string {
	if (session.name) return session.name;
	return `Task · ${new Date(session.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

export function SessionSidebar({ state, busy, onCreate, onOpen }: SessionSidebarProps) {
	const [cwd, setCwd] = useState("");
	const [creating, setCreating] = useState(false);
	const groups = groupSessionsByProject(state);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const path = cwd.trim();
		if (!path) return;
		try {
			await onCreate(path);
			setCreating(false);
			setCwd("");
		} catch {
			// App owns the error toast; keep the form open so the path can be corrected or retried.
		}
	};

	return (
		<aside className="session-sidebar" aria-label="Projects and tasks">
			<div className="brand-row">
				<strong>ArcMind</strong>
				<span>Desktop</span>
			</div>
			<button className="new-task-button" disabled={busy} onClick={() => setCreating((value) => !value)} type="button">
				<NotePencil aria-hidden="true" size={19} weight="regular" />
				New task
			</button>
			{creating && (
				<form className="new-session" onSubmit={(event) => void submit(event)}>
					<label htmlFor="project-path">Project folder</label>
					<div className="new-session-row">
						<input
							autoComplete="off"
							autoFocus
							disabled={busy}
							id="project-path"
							onChange={(event) => setCwd((event.target as unknown as { value: string }).value)}
							placeholder="/path/to/project"
							value={cwd}
						/>
						<button disabled={busy || cwd.trim().length === 0} type="submit">Create</button>
					</div>
				</form>
			)}
			<nav className="project-list" aria-label="Recent tasks">
				{groups.length === 0 && <p className="empty-copy">No tasks yet. Start with a project folder.</p>}
				{groups.map((group) => (
					<section className="project-group" key={group.cwd}>
						<div className="project-heading" title={group.cwd}>
							<FolderSimple aria-hidden="true" size={18} />
							<span>{group.name}</span>
						</div>
						{group.sessions.map((session) => (
							<button
								aria-current={state.activeSessionId === session.sessionId ? "page" : undefined}
								className="session-button"
								disabled={busy}
								key={session.sessionId}
								onClick={() => void onOpen(session.sessionId)}
								type="button"
							>
								<span>{taskTitle(session)}</span>
								{session.state !== "idle" && <small>{session.state.replace("_", " ")}</small>}
							</button>
						))}
					</section>
				))}
			</nav>
		</aside>
	);
}
