import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { trapDialogTab } from "./dialog-focus.ts";

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
	const openingFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const cancel = useRef(onCancel);
	const canCancel = useRef(cancellable);
	cancel.current = onCancel;
	canCancel.current = cancellable;
	const handleKeyDown = useCallback(
		(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault" | "target" | "defaultPrevented">) => {
			if (event.defaultPrevented || dialog.current?.querySelector("dialog[open]")) return;
			if (event.key === "Escape" && canCancel.current) {
				if (
					dialog.current?.querySelector('[aria-haspopup][aria-expanded="true"]') ||
					(event.target instanceof Element && event.target.closest('[role="listbox"], [role="menu"]'))
				)
					return;
				event.preventDefault();
				cancel.current();
				return;
			}
			if (dialog.current) trapDialogTab(event, dialog.current);
		},
		[],
	);
	useLayoutEffect(() => {
		return () => {
			if (openingFocus.current?.isConnected) openingFocus.current.focus();
		};
	}, []);
	useLayoutEffect(() => {
		const node = dialog.current;
		queueMicrotask(() => {
			if (node?.isConnected) initialFocus.current?.focus();
		});
		const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
		node?.addEventListener("keydown", onKeyDown);
		return () => node?.removeEventListener("keydown", onKeyDown);
	}, [handleKeyDown, initialFocus]);
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
