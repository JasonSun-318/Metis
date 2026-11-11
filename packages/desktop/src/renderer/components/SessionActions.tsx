import type { SessionSummary } from "@metis/app-protocol";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Archive, CaretDown, CopySimple, DotsThree, PencilSimple, PushPin, PushPinSimple, Trash } from "../icons.tsx";
import { iconSize } from "../ui/icon-size.ts";
import { actionMenuPosition } from "./action-menu-position.ts";
import { DialogFrame } from "./DialogFrame.tsx";
import { useSidebarMotionPosition } from "./use-sidebar-motion-position.ts";

interface SessionActionsProps {
	readonly allowRename?: boolean;
	readonly deleteDisabled: boolean;
	readonly disabled: boolean;
	readonly displayName: string;
	readonly onDelete: (session: SessionSummary) => Promise<void>;
	readonly onArchive?: (session: SessionSummary) => Promise<void>;
	readonly archiveDisabled?: boolean;
	readonly onCopy?: (displayName: string) => Promise<void>;
	readonly onPin?: (session: SessionSummary, pinned: boolean) => void;
	readonly onRename: (session: SessionSummary, name: string) => Promise<void>;
	readonly pinned?: boolean;
	readonly session: SessionSummary;
	readonly variant?: "sidebar" | "header";
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The session could not be changed.";
}

export function SessionActions({ session, onDelete, onRename, onArchive, onPin, ...props }: SessionActionsProps) {
	return (
		<ConversationActions
			{...props}
			onDelete={() => onDelete(session)}
			onRename={(name) => onRename(session, name)}
			onArchive={onArchive ? () => onArchive(session) : undefined}
			onPin={onPin ? (pinned) => onPin(session, pinned) : undefined}
		/>
	);
}

export interface ConversationActionsProps {
	readonly allowRename?: boolean;
	readonly archiveDisabled?: boolean;
	readonly deleteDisabled: boolean;
	readonly disabled: boolean;
	readonly displayName: string;
	readonly kind?: "session" | "agent";
	readonly onArchive?: () => Promise<void>;
	readonly onDelete: () => Promise<void>;
	readonly onCopy?: (displayName: string) => Promise<void>;
	readonly onPin?: (pinned: boolean) => void;
	readonly onRename: (name: string) => Promise<void>;
	readonly pinned?: boolean;
	readonly variant?: "sidebar" | "header";
}

/** Both tree levels share the same menu, focus restoration, and mutation dialogs. */
export function ConversationActions({
	allowRename = true,
	archiveDisabled = false,
	deleteDisabled,
	disabled,
	displayName,
	kind = "session",
	onArchive,
	onDelete,
	onCopy,
	onPin,
	onRename,
	pinned = false,
	variant = "sidebar",
}: ConversationActionsProps) {
	const { t } = useTranslation();
	const [menuOpen, setMenuOpen] = useState(false);
	const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
	const [name, setName] = useState(displayName);
	const [pending, setPending] = useState(false);
	const [archiving, setArchiving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const renameInput = useRef<HTMLInputElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const updateMenuPosition = useCallback(() => {
		if (trigger.current) {
			const itemCount =
				Number(Boolean(onPin)) + Number(Boolean(onCopy)) + Number(allowRename) + Number(Boolean(onArchive)) + 1;
			setMenuPosition(actionMenuPosition(trigger.current.getBoundingClientRect(), 200, itemCount));
		}
	}, [allowRename, onArchive, onCopy, onPin]);
	useSidebarMotionPosition(trigger, menuOpen, updateMenuPosition);

	const closeMenu = useCallback((restoreFocus = true) => {
		setMenuOpen(false);
		if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
	}, []);
	const cancelDialog = () => {
		if (pending) return;
		setDialog(null);
		setError(null);
		setMenuOpen(true);
	};

	useEffect(() => {
		if (!menuOpen) return;
		queueMicrotask(() => menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
		const onPointerDown = (event: PointerEvent) => {
			if (pending) return;
			const node = event.target as Node;
			if (!root.current?.contains(node) && !menu.current?.contains(node)) closeMenu(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || pending) return;
			event.preventDefault();
			closeMenu();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", updateMenuPosition);
		window.addEventListener("scroll", updateMenuPosition, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", updateMenuPosition);
			window.removeEventListener("scroll", updateMenuPosition, true);
		};
	}, [closeMenu, menuOpen, updateMenuPosition, pending]);
	useLayoutEffect(() => {
		if (menuOpen) updateMenuPosition();
	}, [menuOpen, updateMenuPosition]);

	const submitRename = async (event: FormEvent) => {
		event.preventDefault();
		const next = name.trim();
		if (!next || pending) return;
		setPending(true);
		setError(null);
		try {
			await onRename(next);
			setDialog(null);
			closeMenu();
		} catch (cause) {
			setError(message(cause));
		} finally {
			setPending(false);
		}
	};
	const copyTitle = async () => {
		if (!onCopy || pending) return;
		setPending(true);
		setError(null);
		try {
			await onCopy(displayName);
			closeMenu();
		} catch (cause) {
			setError(message(cause));
		} finally {
			setPending(false);
		}
	};
	const archive = async () => {
		if (!onArchive || archiveDisabled || pending) return;
		setPending(true);
		setArchiving(true);
		setError(null);
		try {
			await onArchive();
			closeMenu();
		} catch (cause) {
			setError(message(cause));
		} finally {
			setPending(false);
			setArchiving(false);
		}
	};
	const confirmDelete = async () => {
		if (deleteDisabled || pending) return;
		setPending(true);
		setError(null);
		try {
			await onDelete();
			setDialog(null);
			closeMenu();
		} catch (cause) {
			setError(message(cause));
		} finally {
			setPending(false);
		}
	};

	return (
		<div
			className={`session-actions${variant === "header" ? " session-actions-header" : ""}`}
			data-open={menuOpen}
			ref={root}
		>
			<button
				aria-expanded={menuOpen}
				aria-haspopup="menu"
				aria-label={t("Actions for {{name}}", { name: displayName })}
				disabled={disabled || pending}
				onClick={() => {
					setError(null);
					setMenuOpen((open) => !open);
				}}
				ref={trigger}
				type="button"
			>
				{variant === "header" ? (
					<CaretDown aria-hidden="true" size={iconSize.md} />
				) : (
					<DotsThree aria-hidden="true" size={iconSize.xl} weight="bold" />
				)}
			</button>
			{menuOpen &&
				createPortal(
					<div
						aria-label={t(kind === "agent" ? "{{name}} agent actions" : "{{name}} session actions", {
							name: displayName,
						})}
						className="session-action-menu"
						onKeyDown={(event) => {
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
							event.preventDefault();
							const items = Array.from(
								event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
							);
							const current = items.indexOf(document.activeElement as HTMLButtonElement);
							const target =
								event.key === "Home"
									? items[0]
									: event.key === "End"
										? items.at(-1)
										: event.key === "ArrowDown"
											? items[(current + 1) % items.length]
											: items[(current <= 0 ? items.length : current) - 1];
							target?.focus();
						}}
						ref={menu}
						role="menu"
						style={menuPosition}
					>
						{onPin && (
							<button
								disabled={pending}
								onClick={() => {
									onPin(!pinned);
									closeMenu();
								}}
								role="menuitem"
								type="button"
							>
								{pinned ? (
									<PushPin aria-hidden="true" size={iconSize.lg} />
								) : (
									<PushPinSimple aria-hidden="true" size={iconSize.lg} />
								)}
								{t(pinned ? "Unpin" : "Pin")}
							</button>
						)}
						{onCopy && (
							<button disabled={pending} onClick={() => void copyTitle()} role="menuitem" type="button">
								<CopySimple aria-hidden="true" size={iconSize.lg} /> {t("Copy title")}
							</button>
						)}
						{allowRename && (
							<button
								disabled={pending}
								onClick={() => {
									setName(displayName);
									setError(null);
									setMenuOpen(false);
									setDialog("rename");
								}}
								role="menuitem"
								type="button"
							>
								<PencilSimple aria-hidden="true" size={iconSize.lg} /> {t("Rename")}
							</button>
						)}
						{onArchive && (
							<button
								type="button"
								role="menuitem"
								disabled={archiveDisabled || pending}
								title={
									archiveDisabled
										? t(
												kind === "agent"
													? "Stop this agent and its running subtasks before archiving."
													: "Stop the current reply before archiving.",
											)
										: undefined
								}
								onClick={() => void archive()}
							>
								<Archive size={iconSize.lg} aria-hidden="true" />
								{t(archiving ? "Archiving conversation…" : "Archive conversation")}
							</button>
						)}
						<button
							className="session-delete-menu-item"
							disabled={deleteDisabled || pending}
							onClick={() => {
								setError(null);
								setMenuOpen(false);
								setDialog("delete");
							}}
							role="menuitem"
							type="button"
						>
							<Trash aria-hidden="true" size={iconSize.lg} /> {t("Delete")}
						</button>
						{error && (
							<p className="session-action-menu-error" role="alert">
								{t(error)}
							</p>
						)}
					</div>,
					document.body,
				)}
			{dialog === "rename" && (
				<DialogFrame
					cancellable={!pending}
					descriptionId="session-rename-description"
					initialFocus={renameInput}
					onCancel={cancelDialog}
					titleId="session-rename-title"
				>
					<h2 id="session-rename-title">{t(kind === "agent" ? "Rename agent conversation" : "Rename session")}</h2>
					<p id="session-rename-description">
						{t("Change the session name shown in Metis. Messages are unchanged.")}
					</p>
					<form onSubmit={(event) => void submitRename(event)}>
						<label htmlFor="session-rename-input">{t("Session name")}</label>
						<input
							autoComplete="off"
							id="session-rename-input"
							maxLength={kind === "agent" ? 128 : undefined}
							onChange={(event) =>
								setName(kind === "agent" ? event.target.value : [...event.target.value].slice(0, 80).join(""))
							}
							ref={renameInput}
							value={name}
						/>
						{error && <p role="alert">{t(error)}</p>}
						<div className="project-dialog-actions">
							<button className="button-secondary" disabled={pending} onClick={cancelDialog} type="button">
								{t("Cancel")}
							</button>
							<button disabled={pending || !name.trim()} type="submit">
								{t(pending ? "Renaming…" : "Rename")}
							</button>
						</div>
					</form>
				</DialogFrame>
			)}
			{dialog === "delete" && (
				<DialogFrame
					cancellable={!pending}
					descriptionId="session-delete-description"
					initialFocus={cancelButton}
					onCancel={cancelDialog}
					titleId="session-delete-title"
				>
					<h2 id="session-delete-title">
						{t(kind === "agent" ? "Delete agent conversation?" : "Delete session?")}
					</h2>
					<div id="session-delete-description">
						{kind === "agent" ? (
							<p>
								{t(
									"Delete {{name}} and all its subtasks? Running tasks will be stopped and their conversation data will be removed.",
									{ name: displayName },
								)}
							</p>
						) : (
							<>
								<p>{t("{{name}} and its session-owned data will move to Trash.", { name: displayName })}</p>
								<ul>
									<li>
										{t(
											"Images, attachments, tool outputs, Subagents, document work, and recovery files are included.",
										)}
									</li>
									<li>
										{t("Project memory, Skills, schedules, other sessions, and source files are unchanged.")}
									</li>
								</ul>
							</>
						)}
						{error && <p role="alert">{t(error)}</p>}
						{pending && (
							<output className="status-paragraph">
								{t(kind === "agent" ? "Deleting agent conversations…" : "Moving session data to Trash…")}
							</output>
						)}
					</div>
					<div className="project-dialog-actions">
						<button
							className="button-secondary"
							disabled={pending}
							onClick={cancelDialog}
							ref={cancelButton}
							type="button"
						>
							{t("Cancel")}
						</button>
						<button
							className="project-delete-confirm"
							disabled={pending || deleteDisabled}
							onClick={() => void confirmDelete()}
							type="button"
						>
							{t(pending ? "Deleting…" : kind === "agent" ? "Delete" : "Move to Trash")}
						</button>
					</div>
				</DialogFrame>
			)}
		</div>
	);
}
