import {
	cloneElement,
	isValidElement,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

const DEFAULT_DELAY_MS = 350;
const TRIGGER_GAP = 6;
const VIEWPORT_MARGIN = 8;

interface ToolbarTooltipProps {
	readonly active?: boolean;
	readonly children: ReactNode;
	readonly delayMs?: number;
	readonly label: string;
}

interface TooltipPosition {
	readonly left: number;
	readonly top: number;
}

/**
 * Adds a delayed, viewport-clamped hint around a single true toolbar button.
 * The wrapper receives hover events even when the button itself is disabled.
 */
export function ToolbarTooltip({ active = true, children, delayMs = DEFAULT_DELAY_MS, label }: ToolbarTooltipProps) {
	const anchorRef = useRef<HTMLSpanElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const timerRef = useRef<number | null>(null);
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<TooltipPosition | null>(null);
	const tooltipId = useId();

	const clearTimer = useCallback(() => {
		if (timerRef.current === null) return;
		window.clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);

	const close = useCallback(() => {
		clearTimer();
		setOpen(false);
		setPosition(null);
	}, [clearTimer]);

	const scheduleOpen = useCallback(() => {
		if (!active || open || timerRef.current !== null) return;
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			setOpen(true);
		}, delayMs);
	}, [active, delayMs, open]);

	useEffect(() => {
		if (!active) close();
	}, [active, close]);

	useEffect(() => {
		if (!active) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
		};
		const onScroll = () => close();
		const onResize = () => close();
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
		};
	}, [active, close]);

	useEffect(
		() => () => {
			clearTimer();
		},
		[clearTimer],
	);

	useEffect(() => {
		const anchor = anchorRef.current;
		if (!anchor) return;
		const onPointerEnter = (event: PointerEvent) => {
			if (event.pointerType !== "touch") scheduleOpen();
		};
		const onPointerLeave = () => close();
		const onFocus = () => scheduleOpen();
		const onBlur = () => close();
		const onClick = () => close();
		anchor.addEventListener("pointerenter", onPointerEnter);
		anchor.addEventListener("pointerleave", onPointerLeave);
		anchor.addEventListener("focusin", onFocus);
		anchor.addEventListener("focusout", onBlur);
		anchor.addEventListener("click", onClick);
		return () => {
			anchor.removeEventListener("pointerenter", onPointerEnter);
			anchor.removeEventListener("pointerleave", onPointerLeave);
			anchor.removeEventListener("focusin", onFocus);
			anchor.removeEventListener("focusout", onBlur);
			anchor.removeEventListener("click", onClick);
		};
	}, [close, scheduleOpen]);

	useLayoutEffect(() => {
		if (!open) return;
		const trigger = anchorRef.current?.getBoundingClientRect();
		const tooltip = tooltipRef.current?.getBoundingClientRect();
		if (!trigger || !tooltip) return;
		const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
		const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
		const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - tooltip.width);
		const left = Math.min(Math.max(VIEWPORT_MARGIN, trigger.left + trigger.width / 2 - tooltip.width / 2), maxLeft);
		const below = trigger.bottom + TRIGGER_GAP;
		const top =
			below + tooltip.height <= viewportHeight - VIEWPORT_MARGIN
				? below
				: Math.max(VIEWPORT_MARGIN, trigger.top - TRIGGER_GAP - tooltip.height);
		setPosition((current) => (current?.left === left && current.top === top ? current : { left, top }));
	});

	const trigger = isValidElement<{ "aria-describedby"?: string }>(children)
		? cloneElement(children, {
				"aria-describedby": open
					? [children.props["aria-describedby"], tooltipId].filter(Boolean).join(" ")
					: children.props["aria-describedby"],
			})
		: children;

	return (
		<>
			<span className="toolbar-tooltip-anchor" ref={anchorRef}>
				{trigger}
			</span>
			{active &&
				open &&
				createPortal(
					<div
						className="toolbar-tooltip"
						id={tooltipId}
						ref={tooltipRef}
						role="tooltip"
						style={
							position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: "hidden" }
						}
					>
						{label}
					</div>,
					document.body,
				)}
		</>
	);
}
