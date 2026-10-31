import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/workspace-tab-menu.css";

/** Distance kept between the menu and the viewport edges. */
const VIEWPORT_MARGIN = 8;
/** Gap between a keyboard anchor's tab rectangle and the menu. */
const ANCHOR_GAP = 4;

export interface WorkspaceTabMenuItem {
	readonly key: string;
	readonly label: string;
	readonly title?: string;
	readonly disabled?: boolean;
	readonly onSelect: () => void;
}

/** A pointer point stays fixed; an element anchor tracks its tab rectangle. */
export type WorkspaceTabMenuAnchor =
	| { readonly kind: "point"; readonly x: number; readonly y: number }
	| { readonly kind: "element"; readonly element: HTMLElement };

interface WorkspaceTabMenuProps {
	readonly anchor: WorkspaceTabMenuAnchor;
	readonly ariaLabel: string;
	readonly items: readonly WorkspaceTabMenuItem[];
	readonly onClose: (options?: { readonly restoreFocus?: boolean }) => void;
	readonly restoreFocusTo?: HTMLElement | null;
	readonly portalContainer?: HTMLElement;
}

const enabledItems = (menu: HTMLElement): HTMLButtonElement[] => [
	...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
];

const clamp = (value: number, maximum: number): number => Math.max(VIEWPORT_MARGIN, Math.min(maximum, value));

/**
 * Body-portal tab action menu with fixed viewport positioning. It measures
 * itself before appearing, flips at the 8px viewport margin, scrolls when
 * taller than the viewport, and restores focus to its trigger on Escape.
 */
export function WorkspaceTabMenu({
	anchor,
	ariaLabel,
	items,
	onClose,
	restoreFocusTo = null,
	portalContainer = document.body,
}: WorkspaceTabMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

	// Recomputes the anchored position; false means the anchor is gone and the
	// menu must close instead of floating over nothing.
	const measure = useCallback((): boolean => {
		const menu = menuRef.current;
		if (!menu) return false;
		const width = menu.offsetWidth;
		const height = menu.offsetHeight;
		let left: number;
		let top: number;
		if (anchor.kind === "element") {
			if (!anchor.element.isConnected) return false;
			const rect = anchor.element.getBoundingClientRect();
			left = rect.left;
			top = rect.bottom + ANCHOR_GAP;
			if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = rect.top - height - ANCHOR_GAP;
		} else {
			left = anchor.x;
			top = anchor.y;
			if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = anchor.y - height;
		}
		if (left + width > window.innerWidth - VIEWPORT_MARGIN) left -= width;
		setPosition({
			left: clamp(left, window.innerWidth - VIEWPORT_MARGIN - width),
			top: clamp(top, window.innerHeight - VIEWPORT_MARGIN - height),
		});
		return true;
	}, [anchor]);

	// The parent re-anchors the menu on each open, so anchor identity drives
	// re-measurement; menu items only change across open/close cycles.
	useLayoutEffect(() => {
		measure();
	}, [measure]);

	const close = useCallback(
		(restoreFocus: boolean) => {
			if (restoreFocus && restoreFocusTo) restoreFocusTo.focus();
			onClose({ restoreFocus });
		},
		[onClose, restoreFocusTo],
	);

	const enabledMenuItems = useCallback(
		(): HTMLButtonElement[] => (menuRef.current ? enabledItems(menuRef.current) : []),
		[],
	);

	const opened = position !== null;
	useEffect(() => {
		if (opened) enabledMenuItems()[0]?.focus();
	}, [opened, enabledMenuItems]);

	useEffect(() => {
		if (!opened) return;
		const onPointerDown = (event: PointerEvent) => {
			// An outside press closes without stealing the new target's focus.
			if (menuRef.current?.contains(event.target as Node)) return;
			close(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close(true);
		};
		const onUpdate = () => {
			if (!measure()) close(false);
		};
		const onBlur = () => close(false);
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", onUpdate);
		window.addEventListener("scroll", onUpdate, true);
		window.addEventListener("blur", onBlur);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", onUpdate);
			window.removeEventListener("scroll", onUpdate, true);
			window.removeEventListener("blur", onBlur);
		};
	}, [opened, measure, close]);

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close(true);
			return;
		}
		if (event.key === "Tab") {
			close(false);
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		const enabled = enabledMenuItems();
		if (enabled.length === 0) return;
		const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			event.key === "Home"
				? enabled[0]!
				: event.key === "End"
					? enabled[enabled.length - 1]!
					: event.key === "ArrowDown"
						? enabled[(current + 1 + enabled.length) % enabled.length]!
						: enabled[(current - 1 + enabled.length) % enabled.length]!;
		next.focus();
	};

	const style: CSSProperties = position
		? { left: `${position.left}px`, top: `${position.top}px` }
		: // Hidden until measured so the menu never flashes at the viewport corner.
			{ visibility: "hidden" };

	return createPortal(
		<div
			aria-label={ariaLabel}
			className="workspace-tab-menu"
			data-open="true"
			onKeyDown={handleKeyDown}
			ref={menuRef}
			role="menu"
			style={style}
		>
			{items.map((item) => (
				<button
					disabled={item.disabled}
					key={item.key}
					onClick={() => {
						item.onSelect();
						close(true);
					}}
					role="menuitem"
					title={item.title}
					type="button"
				>
					<span>{item.label}</span>
				</button>
			))}
		</div>,
		portalContainer,
	);
}
