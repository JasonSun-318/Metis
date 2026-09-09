import type { ScheduleTaskView } from "@metis/app-protocol";
import { DotsThree, Trash } from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { actionMenuPosition } from "./action-menu-position.ts";
import { ScheduledTaskDeleteDialog } from "./ScheduledTaskDeleteDialog.tsx";

interface ScheduledTaskActionsProps {
	readonly deleteDisabled: boolean;
	readonly disabled: boolean;
	readonly onDelete: MetisDesktopApi["deleteSchedule"];
	readonly task: ScheduleTaskView;
}

export function ScheduledTaskActions({ deleteDisabled, disabled, onDelete, task }: ScheduledTaskActionsProps) {
	const { t } = useTranslation();
	const [menuOpen, setMenuOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const deleteItem = useRef<HTMLButtonElement>(null);
	const updateMenuPosition = useCallback(() => {
		if (trigger.current) setMenuPosition(actionMenuPosition(trigger.current.getBoundingClientRect(), 200, 1));
	}, []);
	const closeMenu = (restoreFocus = true) => {
		setMenuOpen(false);
		if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
	};
	const closeDialog = () => {
		setConfirmDelete(false);
		queueMicrotask(() => trigger.current?.focus());
	};

	useEffect(() => {
		if (!menuOpen) return;
		queueMicrotask(() => deleteItem.current?.focus());
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
	}, [menuOpen, updateMenuPosition]);
	useLayoutEffect(() => {
		if (menuOpen) updateMenuPosition();
	}, [menuOpen, updateMenuPosition]);

	return (
		<div className="session-actions" data-open={menuOpen} ref={root}>
			<button
				aria-expanded={menuOpen}
				aria-haspopup="menu"
				aria-label={t("Actions for {{name}}", { name: task.name })}
				disabled={disabled}
				onClick={() => setMenuOpen((open) => !open)}
				ref={trigger}
				type="button"
			>
				<DotsThree aria-hidden="true" size={17} weight="bold" />
			</button>
			{menuOpen && createPortal((
				<div
					aria-label={t("Actions for {{name}}", { name: task.name })}
					className="session-action-menu"
					ref={menu}
					role="menu"
					style={menuPosition}
				>
					<button
						className="session-delete-menu-item"
						disabled={deleteDisabled}
						onClick={() => {
							setMenuOpen(false);
							setConfirmDelete(true);
						}}
						ref={deleteItem}
						role="menuitem"
						type="button"
					>
						<Trash aria-hidden="true" size={15} /> {t("Delete")}
					</button>
				</div>
			), document.body)}
			{confirmDelete && (
				<ScheduledTaskDeleteDialog
					deleteSchedule={onDelete}
					forceDeleteSessions
					onClose={closeDialog}
					onDeleted={() => setConfirmDelete(false)}
					task={task}
				/>
			)}
		</div>
	);
}
