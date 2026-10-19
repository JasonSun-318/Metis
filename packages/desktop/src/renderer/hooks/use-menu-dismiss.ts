import { type RefObject, useEffect } from "react";

export function useMenuDismiss(
	open: boolean,
	rootRef: RefObject<HTMLElement | null>,
	close: (restoreFocus?: boolean) => void,
): void {
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close(true);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [close, open, rootRef]);
}
