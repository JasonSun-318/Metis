import type { ClientResult } from "@arcmind/app-protocol";
import { DotsThree, NotePencil, PencilSimple, PushPin, PushPinSimple, Trash } from "@phosphor-icons/react";
import { type FormEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectSessionGroup } from "./SessionSidebar.tsx";

type ProjectDeletePreview = ClientResult<"project/deletePreview">;

export type DeleteDialogState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly preview: ProjectDeletePreview }
	| { readonly status: "deleting"; readonly preview: ProjectDeletePreview };

interface ProjectActionsProps {
	readonly active: boolean;
	readonly busy: boolean;
	readonly group: ProjectSessionGroup;
	readonly onActivate: () => void;
	readonly onCreate: (group: ProjectSessionGroup) => Promise<void>;
	readonly onDeactivate: () => void;
	readonly onDelete: (group: ProjectSessionGroup, preview: ProjectDeletePreview) => Promise<void>;
	readonly onPin: (group: ProjectSessionGroup, pinned: boolean) => void;
	readonly onPreviewDelete: (group: ProjectSessionGroup) => Promise<ProjectDeletePreview>;
	readonly onRename: (group: ProjectSessionGroup, alias: string) => void;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The project could not be changed.";
}

function focusable(dialog: HTMLElement): HTMLElement[] {
	return Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
}

export function DialogFrame({
	cancellable,
	children,
	className = "project-dialog",
	descriptionId,
	initialFocus,
	onCancel,
	titleId,
}: {
	readonly cancellable: boolean;
	readonly children: React.ReactNode;
	readonly className?: string;
	readonly descriptionId: string;
	readonly initialFocus: RefObject<HTMLElement | null>;
	readonly onCancel: () => void;
	readonly titleId: string;
}) {
	const dialog = useRef<HTMLElement>(null);
	const cancel = useRef(onCancel);
	const canCancel = useRef(cancellable);
	cancel.current = onCancel;
	canCancel.current = cancellable;
	const handleKeyDown = (event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">) => {
		if (event.key === "Escape" && canCancel.current) {
			event.preventDefault();
			cancel.current();
			return;
		}
		if (event.key !== "Tab" || !dialog.current) return;
		const controls = focusable(dialog.current);
		if (controls.length === 0) return;
		const first = controls[0]!;
		const last = controls.at(-1)!;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};
	useLayoutEffect(() => {
		queueMicrotask(() => initialFocus.current?.focus());
		const node = dialog.current;
		const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
		node?.addEventListener("keydown", onKeyDown);
		return () => node?.removeEventListener("keydown", onKeyDown);
	}, [initialFocus]);
	return (
		<div
			className="modal-backdrop"
			onPointerDown={(event) => {
				if (cancellable && event.target === event.currentTarget) onCancel();
			}}
		>
			<section
				aria-describedby={descriptionId}
				aria-labelledby={titleId}
				aria-modal="true"
				className={className}
				ref={dialog}
				role="dialog"
			>
				{children}
			</section>
		</div>
	);
}

export function ProjectActions({
	active,
	busy,
	group,
	onActivate,
	onCreate,
	onDeactivate,
	onDelete,
	onPin,
	onPreviewDelete,
	onRename,
}: ProjectActionsProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
	const [deleteState, setDeleteState] = useState<DeleteDialogState>({ status: "loading" });
	const [alias, setAlias] = useState(group.name);
	const root = useRef<HTMLDivElement>(null);
	const actionsButton = useRef<HTMLButtonElement>(null);
	const renameMenuItem = useRef<HTMLButtonElement>(null);
	const deleteMenuItem = useRef<HTMLButtonElement>(null);
	const renameInput = useRef<HTMLInputElement>(null);
	const deleteInitialFocus = useRef<HTMLButtonElement>(null);
	const restoreMenuItem = useRef<"rename" | "delete" | null>(null);
	const previewGeneration = useRef(0);

	const closeMenu = (restoreFocus = true) => {
		setMenuOpen(false);
		onDeactivate();
		if (restoreFocus) queueMicrotask(() => actionsButton.current?.focus());
	};
	const cancelDialog = () => {
		if (dialog === "delete" && deleteState.status === "deleting") return;
		previewGeneration.current += 1;
		restoreMenuItem.current = dialog;
		setDialog(null);
		setMenuOpen(true);
	};
	const loadDeletePreview = () => {
		const generation = ++previewGeneration.current;
		setDeleteState({ status: "loading" });
		void onPreviewDelete(group).then(
			(preview) => {
				if (generation === previewGeneration.current) setDeleteState({ status: "ready", preview });
			},
			(cause) => {
				if (generation === previewGeneration.current) {
					setDeleteState({ status: "error", message: errorMessage(cause) });
				}
			},
		);
	};

	useEffect(() => {
		if (active) return;
		previewGeneration.current += 1;
		setMenuOpen(false);
		setDialog(null);
	}, [active]);
	useEffect(() => {
		if (!menuOpen) return;
		const restore = restoreMenuItem.current;
		restoreMenuItem.current = null;
		queueMicrotask(() => {
			if (restore === "rename") renameMenuItem.current?.focus();
			else if (restore === "delete") deleteMenuItem.current?.focus();
			else renameMenuItem.current?.focus();
		});
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
	useEffect(() => {
		if (dialog !== "rename") return;
		queueMicrotask(() => {
			renameInput.current?.focus();
			renameInput.current?.select();
		});
	}, [dialog]);

	const submitRename = (event: FormEvent) => {
		event.preventDefault();
		onRename(group, alias);
		cancelDialog();
	};
	const confirmDelete = async () => {
		if (deleteState.status !== "ready" || deleteState.preview.blockingScheduleCount > 0) return;
		const preview = deleteState.preview;
		setDeleteState({ status: "deleting", preview });
		try {
			await onDelete(group, preview);
			setDialog(null);
			setMenuOpen(false);
			onDeactivate();
		} catch (cause) {
			setDeleteState({ status: "error", message: errorMessage(cause) });
		}
	};
	const modeLabel = group.mode === "chat" ? "Chat" : "Code";
	const otherModeLabel = group.mode === "chat" ? "Code" : "Chat";

	return (
		<div className="project-actions" ref={root}>
			<div className="project-action-buttons">
				<button
					aria-expanded={menuOpen}
					aria-haspopup="menu"
					aria-label="Project actions"
					onClick={(event) => {
						event.stopPropagation();
						if (menuOpen) closeMenu();
						else {
							onActivate();
							setMenuOpen(true);
						}
					}}
					onPointerDown={(event) => event.stopPropagation()}
					ref={actionsButton}
					type="button"
				>
					<DotsThree aria-hidden="true" size={17} weight="bold" />
				</button>
				<button
					aria-label={`New task in ${group.name}`}
					disabled={busy}
					onClick={(event) => {
						event.stopPropagation();
						closeMenu(false);
						void onCreate(group).catch(() => undefined);
					}}
					onPointerDown={(event) => event.stopPropagation()}
					type="button"
				>
					<NotePencil aria-hidden="true" size={15} />
				</button>
			</div>
			{menuOpen && (
				<div
					aria-label={`${group.name} project actions`}
					className="project-action-menu"
					onKeyDown={(event) => {
						if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
						event.preventDefault();
						const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
						if (items.length === 0) return;
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
							setAlias(group.name);
							setMenuOpen(false);
							setDialog("rename");
						}}
						ref={renameMenuItem}
						role="menuitem"
						type="button"
					>
						<PencilSimple aria-hidden="true" size={15} /> Rename
					</button>
					<button
						onClick={() => {
							onPin(group, !group.pinned);
							closeMenu();
						}}
						role="menuitem"
						type="button"
					>
						{group.pinned
							? <PushPin aria-hidden="true" size={15} />
							: <PushPinSimple aria-hidden="true" size={15} />}
						{group.pinned ? "Unpin" : "Pin"}
					</button>
					<button
						className="project-delete-menu-item"
						disabled={busy}
						onClick={() => {
							setMenuOpen(false);
							setDialog("delete");
							loadDeletePreview();
						}}
						ref={deleteMenuItem}
						role="menuitem"
						type="button"
					>
						<Trash aria-hidden="true" size={15} /> Delete
					</button>
				</div>
			)}
			{dialog === "rename" && (
				<DialogFrame
					cancellable
					descriptionId="project-rename-description"
					initialFocus={renameInput}
					onCancel={cancelDialog}
					titleId="project-rename-title"
				>
					<h2 id="project-rename-title">Rename project</h2>
					<p id="project-rename-description">Change this Desktop display name only. The folder and sessions are unchanged.</p>
					<form onSubmit={submitRename}>
						<label htmlFor="project-rename-input">Display name</label>
						<input
							autoComplete="off"
							id="project-rename-input"
							onChange={(event) => setAlias([...event.target.value].slice(0, 80).join(""))}
							ref={renameInput}
							value={alias}
						/>
						<div className="project-dialog-actions">
							<button className="button-secondary" onClick={cancelDialog} type="button">Cancel</button>
							<button type="submit">Rename</button>
						</div>
					</form>
				</DialogFrame>
			)}
			{dialog === "delete" && (
				<DialogFrame
					cancellable={deleteState.status !== "deleting"}
					descriptionId="project-delete-description"
					initialFocus={deleteInitialFocus}
					onCancel={cancelDialog}
					titleId="project-delete-title"
				>
					<h2 id="project-delete-title">Delete {modeLabel} project?</h2>
					<div id="project-delete-description">
						{deleteState.status === "loading" && <p role="status">Checking project data…</p>}
						{deleteState.status === "error" && (
							<><p role="alert">{deleteState.message}</p><p>No data was removed. Retry to load a fresh preview.</p></>
						)}
						{(deleteState.status === "ready" || deleteState.status === "deleting") && (
							<>
								<p><strong>{deleteState.preview.sessionCount} {modeLabel} sessions</strong>, including archived sessions, will move to Trash.</p>
								<p className="project-delete-path"><code>{deleteState.preview.cwd}</code></p>
								<ul>
									<li>Matching attachments, images, tool outputs, Subagents, document work, and {modeLabel} project memory are included.</li>
									<li>The {otherModeLabel} project and its memory are unchanged.</li>
									<li>The source folder and its files are unchanged.</li>
									<li>Schedules are not deleted automatically.</li>
								</ul>
								{deleteState.preview.blockingScheduleCount > 0 && (
									<p className="project-delete-blocker" role="alert">
										{deleteState.preview.blockingScheduleCount} fixed-workspace schedules block deletion. Delete them from the schedule workflow first.
									</p>
								)}
								{deleteState.status === "deleting" && <p role="status">Moving project data to Trash…</p>}
							</>
						)}
					</div>
					<div className="project-dialog-actions">
						<button
							className="button-secondary"
							disabled={deleteState.status === "deleting"}
							onClick={cancelDialog}
							ref={deleteInitialFocus}
							type="button"
						>
							Cancel
						</button>
						{deleteState.status === "error" && <button onClick={loadDeletePreview} type="button">Retry</button>}
						{(deleteState.status === "ready" || deleteState.status === "deleting") && (
							<button
								className="project-delete-confirm"
								disabled={deleteState.status === "deleting" || deleteState.preview.blockingScheduleCount > 0}
								onClick={() => void confirmDelete()}
								type="button"
							>
								{deleteState.status === "deleting" ? "Deleting…" : "Move to Trash"}
							</button>
						)}
					</div>
				</DialogFrame>
			)}
		</div>
	);
}
