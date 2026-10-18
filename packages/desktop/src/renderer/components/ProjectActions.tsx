import type { ClientResult } from "@metis/app-protocol";
import { DotsThree, NotePencil, PencilSimple, PushPin, PushPinSimple, Trash } from "@phosphor-icons/react";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ProjectSessionGroup } from "../session-groups.ts";
import { actionMenuPosition } from "./action-menu-position.ts";
import { DialogFrame } from "./DialogFrame.tsx";

export { DialogFrame } from "./DialogFrame.tsx";

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
	const { t } = useTranslation();
	const [menuOpen, setMenuOpen] = useState(false);
	const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
	const [deleteState, setDeleteState] = useState<DeleteDialogState>({ status: "loading" });
	const [alias, setAlias] = useState(group.name);
	const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
	const root = useRef<HTMLDivElement>(null);
	const actionsButton = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const renameMenuItem = useRef<HTMLButtonElement>(null);
	const deleteMenuItem = useRef<HTMLButtonElement>(null);
	const renameInput = useRef<HTMLInputElement>(null);
	const deleteInitialFocus = useRef<HTMLButtonElement>(null);
	const restoreMenuItem = useRef<"rename" | "delete" | null>(null);
	const previewGeneration = useRef(0);
	const updateMenuPosition = useCallback(() => {
		if (actionsButton.current)
			setMenuPosition(actionMenuPosition(actionsButton.current.getBoundingClientRect(), 146, 3));
	}, []);

	const closeMenu = useCallback(
		(restoreFocus = true) => {
			setMenuOpen(false);
			onDeactivate();
			if (restoreFocus) queueMicrotask(() => actionsButton.current?.focus());
		},
		[onDeactivate],
	);
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
	const modeLabel = t(group.mode === "chat" ? "Chat" : "Code");
	const otherModeLabel = t(group.mode === "chat" ? "Code" : "Chat");

	return (
		<div className="project-actions" data-open={menuOpen} ref={root}>
			<div className="project-action-buttons">
				<button
					aria-expanded={menuOpen}
					aria-haspopup="menu"
					aria-label={t("Project actions")}
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
					aria-label={t("New task in {{name}}", { name: group.name })}
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
			{menuOpen &&
				createPortal(
					<div
						aria-label={t("{{name}} project actions", { name: group.name })}
						className="project-action-menu"
						onKeyDown={(event) => {
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
							event.preventDefault();
							const items = Array.from(
								event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
							);
							if (items.length === 0) return;
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
							<PencilSimple aria-hidden="true" size={15} /> {t("Rename")}
						</button>
						<button
							onClick={() => {
								onPin(group, !group.pinned);
								closeMenu();
							}}
							role="menuitem"
							type="button"
						>
							{group.pinned ? (
								<PushPin aria-hidden="true" size={15} />
							) : (
								<PushPinSimple aria-hidden="true" size={15} />
							)}
							{t(group.pinned ? "Unpin" : "Pin")}
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
							<Trash aria-hidden="true" size={15} /> {t("Delete")}
						</button>
					</div>,
					document.body,
				)}
			{dialog === "rename" &&
				createPortal(
					<DialogFrame
						cancellable
						descriptionId="project-rename-description"
						initialFocus={renameInput}
						onCancel={cancelDialog}
						titleId="project-rename-title"
					>
						<h2 id="project-rename-title">{t("Rename project")}</h2>
						<p id="project-rename-description">
							{t("Change this Desktop display name only. The folder and sessions are unchanged.")}
						</p>
						<form onSubmit={submitRename}>
							<label htmlFor="project-rename-input">{t("Display name")}</label>
							<input
								autoComplete="off"
								id="project-rename-input"
								onChange={(event) => setAlias([...event.target.value].slice(0, 80).join(""))}
								ref={renameInput}
								value={alias}
							/>
							<div className="project-dialog-actions">
								<button className="button-secondary" onClick={cancelDialog} type="button">
									{t("Cancel")}
								</button>
								<button type="submit">{t("Rename")}</button>
							</div>
						</form>
					</DialogFrame>,
					document.body,
				)}
			{dialog === "delete" &&
				createPortal(
					<DialogFrame
						cancellable={deleteState.status !== "deleting"}
						descriptionId="project-delete-description"
						initialFocus={deleteInitialFocus}
						onCancel={cancelDialog}
						titleId="project-delete-title"
					>
						<h2 id="project-delete-title">{t("Delete {{mode}} project?", { mode: modeLabel })}</h2>
						<div id="project-delete-description">
							{deleteState.status === "loading" && (
								<output className="status-paragraph">{t("Checking project data…")}</output>
							)}
							{deleteState.status === "error" && (
								<>
									<p role="alert">{t(deleteState.message)}</p>
									<p>{t("No data was removed. Retry to load a fresh preview.")}</p>
								</>
							)}
							{(deleteState.status === "ready" || deleteState.status === "deleting") && (
								<>
									<p>
										{t("{{count}} {{mode}} sessions, including archived sessions, will move to Trash.", {
											count: deleteState.preview.sessionCount,
											mode: modeLabel,
										})}
									</p>
									<p className="project-delete-path">
										<code>{deleteState.preview.cwd}</code>
									</p>
									<ul>
										<li>
											{t(
												"Matching attachments, images, tool outputs, Subagents, document work, and {{mode}} project memory are included.",
												{ mode: modeLabel },
											)}
										</li>
										<li>
											{t("The {{mode}} project and its memory are unchanged.", { mode: otherModeLabel })}
										</li>
										<li>{t("The source folder and its files are unchanged.")}</li>
										<li>{t("Schedules are not deleted automatically.")}</li>
									</ul>
									{deleteState.preview.blockingScheduleCount > 0 && (
										<p className="project-delete-blocker" role="alert">
											{t(
												"{{count}} fixed-workspace schedules block deletion. Delete them from the schedule workflow first.",
												{ count: deleteState.preview.blockingScheduleCount },
											)}
										</p>
									)}
									{deleteState.status === "deleting" && (
										<output className="status-paragraph">{t("Moving project data to Trash…")}</output>
									)}
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
								{t("Cancel")}
							</button>
							{deleteState.status === "error" && (
								<button onClick={loadDeletePreview} type="button">
									{t("Retry")}
								</button>
							)}
							{(deleteState.status === "ready" || deleteState.status === "deleting") && (
								<button
									className="project-delete-confirm"
									disabled={deleteState.status === "deleting" || deleteState.preview.blockingScheduleCount > 0}
									onClick={() => void confirmDelete()}
									type="button"
								>
									{t(deleteState.status === "deleting" ? "Deleting…" : "Move to Trash")}
								</button>
							)}
						</div>
					</DialogFrame>,
					document.body,
				)}
		</div>
	);
}
