import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

function focusable(dialog: HTMLElement): HTMLElement[] {
	return Array.from(
		dialog.querySelectorAll<HTMLElement>(
			"button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
		),
	);
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
	const handleKeyDown = useCallback((event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault" | "target">) => {
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
	}, []);
	useLayoutEffect(() => {
		queueMicrotask(() => initialFocus.current?.focus());
		const node = dialog.current;
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
