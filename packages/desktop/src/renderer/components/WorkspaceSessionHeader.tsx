import type { SessionSummary } from "@metis/app-protocol";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SessionActions } from "./SessionActions.tsx";

interface WorkspaceSessionHeaderProps {
	readonly deleteDisabled: boolean;
	readonly disabled: boolean;
	readonly displayName: string;
	readonly onCopy: (displayName: string) => Promise<void>;
	readonly onDelete: (session: SessionSummary) => Promise<void>;
	readonly onPin: (session: SessionSummary, pinned: boolean) => void;
	readonly onRename: (session: SessionSummary, name: string) => Promise<void>;
	readonly pinned: boolean;
	readonly session: SessionSummary;
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The session could not be changed.";
}

export function WorkspaceSessionHeader({
	deleteDisabled,
	disabled,
	displayName,
	onCopy,
	onDelete,
	onPin,
	onRename,
	pinned,
	session,
}: WorkspaceSessionHeaderProps) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(displayName);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setEditing(false);
		setName(displayName);
		setError(null);
	}, [session.sessionId]);
	useEffect(() => {
		if (!editing) setName(displayName);
	}, [displayName, editing]);
	useLayoutEffect(() => {
		if (!editing) return;
		input.current?.focus();
		input.current?.select();
	}, [editing]);

	const cancel = () => {
		if (pending) return;
		setName(displayName);
		setError(null);
		setEditing(false);
	};
	const save = async () => {
		const next = name.trim();
		if (pending) return;
		if (!next || next === displayName) {
			cancel();
			return;
		}
		setPending(true);
		setError(null);
		try {
			await onRename(session, next);
			setEditing(false);
		} catch (cause) {
			setError(message(cause));
		} finally {
			setPending(false);
		}
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void save();
	};

	return (
		<header className="workspace-header" data-active-session-id={session.sessionId}>
			<div className="workspace-title">
				{editing ? (
					<form className="workspace-title-editor" onSubmit={submit}>
						<input
							aria-label={t("Session name")}
							autoComplete="off"
							disabled={pending}
							onBlur={() => void save()}
							onChange={(event) => setName([...event.target.value].slice(0, 80).join(""))}
							onKeyDown={(event) => {
								if (event.key !== "Escape") return;
								event.preventDefault();
								cancel();
							}}
							ref={input}
							value={name}
						/>
						{error && <p className="workspace-title-error" role="alert">{t(error)}</p>}
					</form>
				) : session.scheduled ? (
					<h1>{displayName}</h1>
				) : (
					<h1>
						<button
							aria-label={displayName}
							disabled={disabled}
							onClick={() => {
								setName(displayName);
								setError(null);
								setEditing(true);
							}}
							title={t("Rename {{name}}", { name: displayName })}
							type="button"
						>
							{displayName}
						</button>
					</h1>
				)}
				<SessionActions
					allowRename={false}
					deleteDisabled={deleteDisabled}
					disabled={disabled}
					displayName={displayName}
					onCopy={onCopy}
					onDelete={onDelete}
					onPin={session.scheduled ? undefined : onPin}
					onRename={onRename}
					pinned={pinned}
					session={session}
					variant="header"
				/>
			</div>
		</header>
	);
}
