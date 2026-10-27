import { useCallback, useEffect, useRef } from "react";
import { resizeAdjacentPaneSizes } from "../workspace-layout.ts";

const KEYBOARD_STEP_PX = 16;

type PaneDragState = {
	pointerId: number;
	startCoordinate: number;
	startSizes: readonly number[];
	lastSizes: readonly number[];
};

export function WorkspacePaneResizer({
	axis,
	label,
	sizes,
	boundary,
	minimum,
	onChange,
	onCommit,
	onResizingChange,
	onReset,
	focusable = true,
	groupKey,
}: {
	readonly axis: "column" | "row";
	readonly label: string;
	readonly sizes: readonly number[];
	readonly boundary: number;
	readonly minimum: number;
	readonly onChange: (sizes: readonly number[]) => void;
	readonly onCommit: () => void;
	readonly onResizingChange: (active: boolean) => void;
	readonly onReset: () => void;
	readonly focusable?: boolean;
	readonly groupKey?: string;
}) {
	const separator = useRef<HTMLHRElement>(null);
	const drag = useRef<PaneDragState | null>(null);
	const detachListeners = useRef<(() => void) | null>(null);
	// Keep the latest callbacks so mid-drag re-renders never reset drag state or fire stale handlers.
	const callbacks = useRef({ onChange, onCommit, onResizingChange, onReset, axis, boundary, minimum });
	callbacks.current = { onChange, onCommit, onResizingChange, onReset, axis, boundary, minimum };

	const endDrag = useCallback((nextSizes: readonly number[] | null, commit: boolean) => {
		const state = drag.current;
		drag.current = null;
		detachListeners.current?.();
		detachListeners.current = null;
		if (!state) return;
		try {
			separator.current?.releasePointerCapture?.(state.pointerId);
		} catch {
			// Capture may already be lost; nothing to release.
		}
		if (nextSizes && nextSizes !== state.lastSizes) callbacks.current.onChange(nextSizes);
		callbacks.current.onResizingChange(false);
		if (commit) callbacks.current.onCommit();
	}, []);

	const attachWindowListeners = useCallback(
		(pointerId: number) => {
			const handleMove = (event: PointerEvent) => {
				const state = drag.current;
				if (!state || event.pointerId !== state.pointerId) return;
				const coordinate = callbacks.current.axis === "column" ? event.clientX : event.clientY;
				const delta = coordinate - state.startCoordinate;
				const nextSizes = resizeAdjacentPaneSizes(
					state.startSizes,
					callbacks.current.boundary,
					delta,
					callbacks.current.minimum,
				);
				state.lastSizes = nextSizes;
				callbacks.current.onChange(nextSizes);
			};
			const isSamePointer = (event: Event) => !(event instanceof PointerEvent) || event.pointerId === pointerId;
			const handleFinish = (event: Event) => {
				if (!isSamePointer(event)) return;
				endDrag(drag.current ? drag.current.lastSizes : null, true);
			};
			const handleBlur = () => endDrag(drag.current ? drag.current.lastSizes : null, true);
			const handleKeyDown = (event: KeyboardEvent) => {
				if (event.key !== "Escape" || !drag.current) return;
				event.preventDefault();
				endDrag(drag.current.startSizes, true);
			};
			window.addEventListener("pointermove", handleMove);
			window.addEventListener("pointerup", handleFinish);
			window.addEventListener("pointercancel", handleFinish);
			window.addEventListener("blur", handleBlur);
			window.addEventListener("keydown", handleKeyDown);
			detachListeners.current = () => {
				window.removeEventListener("pointermove", handleMove);
				window.removeEventListener("pointerup", handleFinish);
				window.removeEventListener("pointercancel", handleFinish);
				window.removeEventListener("blur", handleBlur);
				window.removeEventListener("keydown", handleKeyDown);
			};
		},
		[endDrag],
	);

	// A groupKey change must tear down any live drag completely, without committing foreign-pointer state.
	const lastGroupKey = useRef(groupKey);
	useEffect(() => {
		if (lastGroupKey.current === groupKey) return;
		lastGroupKey.current = groupKey;
		endDrag(null, false);
	}, [endDrag, groupKey]);
	useEffect(() => {
		return () => {
			if (drag.current) endDrag(null, false);
		};
	}, [endDrag]);

	const handlePointerDown = (event: React.PointerEvent<HTMLHRElement>) => {
		if (event.button !== 0 || !event.isPrimary || event.altKey || event.metaKey || event.ctrlKey) return;
		event.preventDefault();
		endDrag(null, false);
		drag.current = {
			pointerId: event.pointerId,
			startCoordinate: axis === "column" ? event.clientX : event.clientY,
			startSizes: sizes,
			lastSizes: sizes,
		};
		try {
			event.currentTarget.setPointerCapture?.(event.pointerId);
		} catch {
			// Window listeners still backstop the drag without capture.
		}
		attachWindowListeners(event.pointerId);
		callbacks.current.onResizingChange(true);
	};

	const pairBudget = (sizes[boundary - 1] ?? 0) + (sizes[boundary] ?? 0);
	const softMinimum = Math.min(minimum, pairBudget / 2);
	const currentValue = sizes[boundary - 1] ?? 0;

	const handleKeyDown = (event: React.KeyboardEvent<HTMLHRElement>) => {
		if (focusable === false) return;
		const decrease = axis === "column" ? "ArrowLeft" : "ArrowUp";
		const increase = axis === "column" ? "ArrowRight" : "ArrowDown";
		if (event.key !== decrease && event.key !== increase && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		if (event.key === "Home") {
			onChange(resizeAdjacentPaneSizes(sizes, boundary, softMinimum - currentValue, minimum));
			onCommit();
			return;
		}
		if (event.key === "End") {
			onChange(resizeAdjacentPaneSizes(sizes, boundary, pairBudget - softMinimum - currentValue, minimum));
			onCommit();
			return;
		}
		const step = event.key === increase ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX;
		onChange(resizeAdjacentPaneSizes(sizes, boundary, step, minimum));
		onCommit();
	};

	return (
		<hr
			ref={separator}
			aria-hidden={focusable === false || undefined}
			aria-label={focusable === false ? undefined : label}
			aria-orientation={axis === "column" ? "vertical" : "horizontal"}
			aria-valuemax={focusable === false ? undefined : Math.round(pairBudget - softMinimum)}
			aria-valuemin={focusable === false ? undefined : Math.round(softMinimum)}
			aria-valuenow={focusable === false ? undefined : Math.round(currentValue)}
			aria-valuetext={focusable === false ? undefined : `${Math.round(currentValue)}px`}
			className={`workspace-pane-resizer workspace-pane-resizer--${axis}`}
			onDoubleClick={onReset}
			onKeyDown={focusable === false ? undefined : handleKeyDown}
			onPointerDown={handlePointerDown}
			role={focusable === false ? undefined : "separator"}
			tabIndex={focusable === false ? -1 : 0}
			title={focusable === false ? undefined : label}
		/>
	);
}
