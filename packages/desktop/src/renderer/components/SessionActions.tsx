import type { SessionSummary } from "@metis/app-protocol";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CaretDown, CopySimple, DotsThree, PencilSimple, PushPin, PushPinSimple, Trash } from "../icons.tsx";
import { actionMenuPosition } from "./action-menu-position.ts";
import { DialogFrame } from "./DialogFrame.tsx";
import { useSidebarMotionPosition } from "./use-sidebar-motion-position.ts";

interface SessionActionsProps {
	readonly allowRename?: boolean;
	readonly deleteDisabled: boolean;
	readonly disabled: boolean;
	readonly displayName: string;
	readonly onDelete: (session: SessionSummary) => Promise<void>;
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

export function SessionActions({
	allowRename = true,
	deleteDisabled,
	disabled,
	displayName,
	onDelete,
	onCopy,
	onPin,
	onRename,
	pinned = false,
	session,
	variant = "sidebar",
}: SessionActionsProps) {
	const { t } = useTranslation();
	const [menuOpen, setMenuOpen] = useState(false);
	const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
	const [name, setName] = useState(displayName);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const renameInput = useRef<HTMLInputElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const updateMenuPosition = useCallback(() => {
		if (trigger.current) {
			const itemCount = Number(Boolean(onPin)) + Number(Boolean(onCopy)) + Number(allowRename) + 1;
			setMenuPosition(actionMenuPosition(trigger.current.getBoundingClientRect(), 200, itemCount));
		}
	}, [allowRename, onCopy, onPin]);
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
			const node = event.target as Node;
			if (!root.current?.contains(node) && !menu.current?.contains(node)) closeMenu(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
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
	}, [closeMenu, menuOpen, updateMenuPosition]);
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
			await onRename(session, next);
			setDialog(null);
			setMenuOpen(false);
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
		<div
			className={`session-actions${variant === "header" ? " session-actions-header" : ""}`}
			data-open={menuOpen}
			ref={root}
		>
			<button
				aria-expanded={menuOpen}
				aria-haspopup="menu"
				aria-label={t("Actions for {{name}}", { name: displayName })}
				disabled={disabled}
				onClick={() => {
					setError(null);
					setMenuOpen((open) => !open);
				}}
				ref={trigger}
				type="button"
			>
				{variant === "header" ? (
					<CaretDown aria-hidden="true" size={13} />
				) : (
					<DotsThree aria-hidden="true" size={17} weight="bold" />
				)}
			</button>
			{menuOpen &&
				createPortal(
					<div
						aria-label={t("{{name}} session actions", { name: displayName })}
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
									onPin(session, !pinned);
									closeMenu();
								}}
								role="menuitem"
								type="button"
							>
								{pinned ? (
									<PushPin aria-hidden="true" size={15} />
								) : (
									<PushPinSimple aria-hidden="true" size={15} />
								)}
								{t(pinned ? "Unpin" : "Pin")}
							</button>
						)}
						{onCopy && (
							<button disabled={pending} onClick={() => void copyTitle()} role="menuitem" type="button">
								<CopySimple aria-hidden="true" size={15} /> {t("Copy title")}
							</button>
						)}
						{allowRename && (
							<button
								onClick={() => {
									setName(displayName);
									setError(null);
									setMenuOpen(false);
									setDialog("rename");
								}}
								role="menuitem"
								type="button"
							>
								<PencilSimple aria-hidden="true" size={15} /> {t("Rename")}
							</button>
						)}
						<button
							className="session-delete-menu-item"
							disabled={deleteDisabled}
							onClick={() => {
								setError(null);
								setMenuOpen(false);
								setDialog("delete");
							}}
							role="menuitem"
							type="button"
						>
							<Trash aria-hidden="true" size={15} /> {t("Delete")}
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
					<h2 id="session-rename-title">{t("Rename session")}</h2>
					<p id="session-rename-description">
						{t("Change the session name shown in Metis. Messages are unchanged.")}
					</p>
					<form onSubmit={(event) => void submitRename(event)}>
						<label htmlFor="session-rename-input">{t("Session name")}</label>
						<input
							autoComplete="off"
							id="session-rename-input"
							onChange={(event) => setName([...event.target.value].slice(0, 80).join(""))}
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
					<h2 id="session-delete-title">{t("Delete session?")}</h2>
					<div id="session-delete-description">
						<p>{t("{{name}} and its session-owned data will move to Trash.", { name: displayName })}</p>
						<ul>
							<li>
								{t(
									"Images, attachments, tool outputs, Subagents, document work, and recovery files are included.",
								)}
							</li>
							<li>{t("Project memory, Skills, schedules, other sessions, and source files are unchanged.")}</li>
						</ul>
						{error && <p role="alert">{t(error)}</p>}
						{pending && <output className="status-paragraph">{t("Moving session data to Trash…")}</output>}
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
							{t(pending ? "Deleting…" : "Move to Trash")}
						</button>
					</div>
				</DialogFrame>
			)}
		</div>
	);
}
