import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "../icons.tsx";

/** Native modal: isolates focus/background, restores the trigger, and guards unsaved edits. */
export function MemoryDialog({
	title,
	description,
	children,
	footer,
	onClose,
	dirty = false,
	busy = false,
	className = "",
}: {
	readonly title: string;
	readonly description?: string;
	readonly children: ReactNode;
	readonly footer?: ReactNode;
	readonly onClose: () => void;
	readonly dirty?: boolean;
	readonly busy?: boolean;
	readonly className?: string;
}) {
	const { t } = useTranslation();
	const id = useId();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const close = () => {
		if (!busy) {
			if (dirty) setConfirmDiscard(true);
			else onClose();
		}
	};
	useEffect(() => {
		const dialog = dialogRef.current!;
		const previous = document.activeElement as HTMLElement | null;
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		(
			dialog.querySelector<HTMLElement>(
				".memory-dialog-body input:not(:disabled), .memory-dialog-body select:not(:disabled), .memory-dialog-body textarea:not(:disabled), .memory-dialog-body button:not(:disabled)",
			) ?? dialog.querySelector<HTMLElement>(".memory-dialog-close")
		)?.focus();
		return () => {
			if (typeof dialog.close === "function") dialog.close();
			else dialog.removeAttribute("open");
			if (previous?.isConnected) previous.focus();
		};
	}, []);
	return (
		<dialog
			aria-labelledby={`${id}-title`}
			aria-describedby={description ? `${id}-description` : undefined}
			aria-modal="true"
			className={`memory-dialog ${className}`}
			ref={dialogRef}
			onKeyDown={(event) => {
				if (
					event.key !== "Escape" ||
					event.defaultPrevented ||
					event.currentTarget.querySelector('[aria-haspopup][aria-expanded="true"]')
				)
					return;
				event.preventDefault();
				event.stopPropagation();
				if (confirmDiscard) setConfirmDiscard(false);
				else close();
			}}
			onCancel={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (confirmDiscard) setConfirmDiscard(false);
				else close();
			}}
			onMouseDown={(event) => {
				if (event.target !== event.currentTarget) return;
				const bounds = event.currentTarget.getBoundingClientRect();
				if (
					event.clientX < bounds.left ||
					event.clientX > bounds.right ||
					event.clientY < bounds.top ||
					event.clientY > bounds.bottom
				)
					close();
			}}
		>
			<header className="memory-dialog-header">
				<div>
					<h2 id={`${id}-title`}>{title}</h2>
					{description && <p id={`${id}-description`}>{description}</p>}
				</div>
				<button
					aria-label={t("Close {{dialog}}", { dialog: title })}
					className="memory-dialog-close"
					disabled={busy}
					onClick={close}
					type="button"
				>
					<X aria-hidden="true" size={18} />
				</button>
			</header>
			<div className="memory-dialog-body">{children}</div>
			{confirmDiscard ? (
				<footer className="memory-dialog-footer memory-dialog-discard">
					<p role="alert">{t("Discard unsaved changes?")}</p>
					<button className="settings-secondary-button" onClick={() => setConfirmDiscard(false)} type="button">
						{t("Keep editing")}
					</button>
					<button className="settings-danger-button" disabled={busy} onClick={onClose} type="button">
						{t("Discard changes")}
					</button>
				</footer>
			) : footer ? (
				<footer className="memory-dialog-footer">{footer}</footer>
			) : null}
		</dialog>
	);
}
