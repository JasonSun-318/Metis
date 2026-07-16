import { useState, type FormEvent } from "react";
import type { AppStoreSnapshot } from "../store/app-store.ts";

interface SessionSidebarProps {
	readonly state: AppStoreSnapshot;
	readonly busy: boolean;
	readonly onCreate: (cwd: string) => Promise<void>;
	readonly onOpen: (sessionId: string) => Promise<void>;
}

export function SessionSidebar({ state, busy, onCreate, onOpen }: SessionSidebarProps) {
	const [cwd, setCwd] = useState("");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const path = cwd.trim();
		if (path) void onCreate(path);
	};

	return (
		<aside className="session-sidebar" aria-label="Sessions">
		<div className="brand-row">
			<div className="brand-mark" aria-hidden="true">A</div>
			<div>
				<strong>ArcMind</strong>
				<span>Desktop</span>
			</div>
		</div>
		<form className="new-session" onSubmit={submit}>
			<label htmlFor="project-path">Project folder</label>
			<div className="new-session-row">
				<input
					autoComplete="off"
					disabled={busy}
					id="project-path"
					onChange={(event) => setCwd(event.target.value)}
					placeholder="/path/to/project"
					value={cwd}
				/>
				<button disabled={busy || cwd.trim().length === 0} type="submit">New</button>
			</div>
		</form>
		<nav className="session-list" aria-label="Recent sessions">
			{state.sessionOrder.length === 0 && <p className="empty-copy">No sessions yet.</p>}
			{state.sessionOrder.map((sessionId) => {
				const session = state.sessionsById.get(sessionId);
				if (!session) return null;
				return (
					<button
						aria-current={state.activeSessionId === sessionId ? "page" : undefined}
						className="session-button"
						disabled={busy}
						key={sessionId}
						onClick={() => void onOpen(sessionId)}
						type="button"
					>
						<span>{session.name || session.cwd || "Untitled session"}</span>
						<small>{session.state.replace("_", " ")}</small>
					</button>
				);
			})}
		</nav>
	</aside>
	);
}
