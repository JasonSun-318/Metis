import type { SessionSummary } from "@arcmind/app-protocol";
import { DotsThree, PencilSimple, Trash } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { DialogFrame } from "./ProjectActions.tsx";

interface SessionActionsProps {
	readonly deleteDisabled: boolean;
	readonly disabled: boolean;
	readonly displayName: string;
	readonly onDelete: (session: SessionSummary) => Promise<void>;
	readonly onRename: (session: SessionSummary, name: string) => Promise<void>;
	readonly session: SessionSummary;
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The session could not be changed.";
}

export function SessionActions({
	deleteDisabled,
	disabled,
	displayName,
	onDelete,
	onRename,
	session,
}: SessionActionsProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
	const [name, setName] = useState(displayName);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const renameItem = useRef<HTMLButtonElement>(null);
	const deleteItem = useRef<HTMLButtonElement>(null);
	const renameInput = useRef<HTMLInputElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);

	const closeMenu = (restoreFocus = true) => {
		setMenuOpen(false);
		if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
	};
	const cancelDialog = () => {
		if (pending) return;
		setDialog(null);
		setError(null);
		setMenuOpen(true);
	};

	useEffect(() => {
		if (!menuOpen) return;
		queueMicrotask(() => renameItem.current?.focus());
		const onPointerDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) closeMenu(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			closeMenu();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen]);

	const submitRename = async (event: FormEvent) => {
		event.preventDefault();
		const next = name.trim();
		if (!next || pending) return;
		setPending(true);
		setError(null);
		try {
			await onRename(session, next);
			setDialog(null);
			setMenuOpen(false);
		} catch (cause) {
			setError(message(cause));
		} finally {
			setPending(false);
		}
	};
	const confirmDelete = async () => {
		if (deleteDisabled || pending) return;
		setPending(true);
		setError(null);
		try {
			await onDelete(session);
			setDialog(null);
			setMenuOpen(false);
		} catch (cause) {
			setError(message(cause));
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="session-actions" ref={root}>
			<button
				aria-expanded={menuOpen}
				aria-haspopup="menu"
				aria-label={`Actions for ${displayName}`}
				disabled={disabled}
				onClick={() => setMenuOpen((open) => !open)}
				ref={trigger}
				type="button"
			>
				<DotsThree aria-hidden="true" size={17} weight="bold" />
			</button>
			{menuOpen && (
				<div
					aria-label={`${displayName} session actions`}
					className="session-action-menu"
					onKeyDown={(event) => {
						if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
						event.preventDefault();
						const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
						const current = items.indexOf(document.activeElement as HTMLButtonElement);
						const target = event.key === "Home"
							? items[0]
							: event.key === "End"
								? items.at(-1)
								: event.key === "ArrowDown"
									? items[(current + 1) % items.length]
									: items[(current <= 0 ? items.length : current) - 1];
						target?.focus();
					}}
					role="menu"
				>
					<button
						onClick={() => {
							setName(displayName);
							setError(null);
							setMenuOpen(false);
							setDialog("rename");
						}}
						ref={renameItem}
						role="menuitem"
						type="button"
					>
						<PencilSimple aria-hidden="true" size={15} /> Rename
					</button>
					<button
						className="session-delete-menu-item"
						disabled={deleteDisabled}
						onClick={() => {
							setError(null);
							setMenuOpen(false);
							setDialog("delete");
						}}
						ref={deleteItem}
						role="menuitem"
						type="button"
					>
						<Trash aria-hidden="true" size={15} /> Delete
					</button>
				</div>
			)}
			{dialog === "rename" && (
				<DialogFrame cancellable={!pending} descriptionId="session-rename-description" initialFocus={renameInput} onCancel={cancelDialog} titleId="session-rename-title">
					<h2 id="session-rename-title">Rename session</h2>
					<p id="session-rename-description">Change the session name shown in ArcMind. Messages are unchanged.</p>
					<form onSubmit={(event) => void submitRename(event)}>
						<label htmlFor="session-rename-input">Session name</label>
						<input autoComplete="off" id="session-rename-input" onChange={(event) => setName([...event.target.value].slice(0, 80).join(""))} ref={renameInput} value={name} />
						{error && <p role="alert">{error}</p>}
						<div className="project-dialog-actions">
							<button className="button-secondary" disabled={pending} onClick={cancelDialog} type="button">Cancel</button>
							<button disabled={pending || !name.trim()} type="submit">{pending ? "Renaming…" : "Rename"}</button>
						</div>
					</form>
				</DialogFrame>
			)}
			{dialog === "delete" && (
				<DialogFrame cancellable={!pending} descriptionId="session-delete-description" initialFocus={cancelButton} onCancel={cancelDialog} titleId="session-delete-title">
					<h2 id="session-delete-title">Delete session?</h2>
					<div id="session-delete-description">
						<p><strong>{displayName}</strong> and its session-owned data will move to Trash.</p>
						<ul>
							<li>Images, attachments, tool outputs, Subagents, document work, and recovery files are included.</li>
							<li>Project memory, Skills, schedules, other sessions, and source files are unchanged.</li>
						</ul>
						{error && <p role="alert">{error}</p>}
						{pending && <p role="status">Moving session data to Trash…</p>}
					</div>
					<div className="project-dialog-actions">
						<button className="button-secondary" disabled={pending} onClick={cancelDialog} ref={cancelButton} type="button">Cancel</button>
						<button className="project-delete-confirm" disabled={pending || deleteDisabled} onClick={() => void confirmDelete()} type="button">{pending ? "Deleting…" : "Move to Trash"}</button>
					</div>
				</DialogFrame>
			)}
		</div>
	);
}
