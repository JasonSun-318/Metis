import { useEffect, useRef } from "react";
import { AddSquare, AlarmClock, Customize, Folder, FolderOpen } from "../icons.tsx";

type SidebarIconKind = "task" | "customize" | "folder" | "schedule" | "chat" | "code";

interface PartMotion {
	readonly part: number;
	readonly frames: Keyframe[];
	readonly duration: number;
	readonly delay?: number;
}

const rest = { transform: "none", opacity: 1 };
const partMotions: Record<SidebarIconKind, readonly PartMotion[]> = {
	task: [1, 2].map((part) => ({
		part,
		frames: [rest, { transform: "scale(1.25)", offset: 0.6 }, { transform: "scale(1.16)" }],
		duration: 280,
	})),
	customize: [1, 2, 3, 4].map((part, index) => ({
		part,
		frames: [rest, { transform: "scale(.82)", opacity: 0.82, offset: 0.5 }, { transform: "scale(.9)", opacity: 1 }],
		duration: 280,
		delay: index * 35,
	})),
	folder: [
		{
			part: 1,
			frames: [rest, { transform: "translateY(-2px)", offset: 0.6 }, { transform: "translateY(-1px)" }],
			duration: 240,
		},
	],
	schedule: [
		{
			part: 1,
			frames: [rest, { transform: "rotate(-14deg)", offset: 0.6 }, { transform: "rotate(-8deg)" }],
			duration: 280,
		},
		{
			part: 2,
			frames: [rest, { transform: "rotate(14deg)", offset: 0.6 }, { transform: "rotate(8deg)" }],
			duration: 280,
		},
		{
			part: 3,
			frames: [rest, { transform: "rotate(28deg)", offset: 0.6 }, { transform: "rotate(18deg)" }],
			duration: 340,
		},
	],
	chat: [2, 3, 4].map((part, index) => ({
		part,
		frames: [
			rest,
			{ transform: "translateY(-3px)", opacity: 0.8, offset: 0.6 },
			{ transform: "translateY(-2px)", opacity: 1 },
		],
		duration: 250,
		delay: index * 40,
	})),
	code: [
		{ part: 1, frames: [rest, { opacity: 0.6, offset: 0.6 }, { opacity: 0.8 }], duration: 280 },
		{
			part: 2,
			frames: [rest, { transform: "translateX(3px)", offset: 0.6 }, { transform: "translateX(2px)" }],
			duration: 260,
		},
		{
			part: 3,
			frames: [rest, { transform: "translateX(-3px)", offset: 0.6 }, { transform: "translateX(-2px)" }],
			duration: 260,
		},
	],
};

/** Animate the installed library's existing parts, only within enabled sidebar controls. */
export function useSidebarIconMotion(kind: SidebarIconKind, expanded = false) {
	const ref = useRef<SVGSVGElement>(null);
	useEffect(() => {
		const svg = ref.current;
		const button = svg?.closest("button");
		if (!svg || !button?.closest(".session-sidebar") || typeof svg.animate !== "function") return;
		if (kind === "folder" && svg.dataset.folderState !== (expanded ? "open" : "closed")) return;
		const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
		const effects = new Map<Animation, SVGElement>();
		let hovered = button.matches(":hover");
		let focused = button.matches(":focus-visible");
		let engaged = false;
		const unavailable = () =>
			button.matches(":disabled") ||
			button.getAttribute("aria-disabled") === "true" ||
			document.documentElement.dataset.motion === "reduced" ||
			media?.matches === true;
		const cancel = () => {
			const animations = [...effects.keys()];
			effects.clear();
			for (const animation of animations) animation.cancel();
		};
		const current = (part: SVGElement) => {
			const style = getComputedStyle(part);
			return { transform: style.transform || "none", opacity: style.opacity || "1" };
		};
		const animate = (part: SVGElement, frames: Keyframe[], options: KeyframeAnimationOptions, hold = false) => {
			const animation = part.animate(frames, options);
			effects.set(animation, part);
			const settle = () => effects.delete(animation);
			// Keep finished hover effects attached until leave can recover from their held pose.
			animation.finished.then(hold ? () => undefined : settle, settle).catch(() => undefined);
		};
		const play = () => {
			const motions = partMotions[kind].flatMap((motion) => {
				const part = svg.querySelector<SVGElement>(`:scope > path:nth-of-type(${motion.part})`);
				return part ? [{ motion, part, start: current(part) }] : [];
			});
			cancel();
			for (const { motion, part, start } of motions) {
				animate(
					part,
					[start, ...motion.frames.slice(1)],
					{
						duration: motion.duration,
						delay: motion.delay ?? 0,
						easing: "cubic-bezier(.2,.7,.3,1)",
						fill: "both",
					},
					true,
				);
			}
		};
		const recover = () => {
			const parts = [...new Set(effects.values())].map((part) => ({ part, start: current(part) }));
			cancel();
			for (const { part, start } of parts) {
				if (start.transform === "none" && Number(start.opacity) === 1) continue;
				animate(part, [start, rest], { duration: 180, easing: "ease-out" });
			}
		};
		const update = () => {
			if (unavailable()) {
				engaged = false;
				cancel();
				return;
			}
			const next = hovered || focused;
			if (engaged === next) return;
			engaged = next;
			if (next) play();
			else recover();
		};
		const enter = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			hovered = true;
			focused = button.matches(":focus-visible");
			update();
		};
		const leave = () => {
			hovered = false;
			focused = button.matches(":focus-visible");
			update();
		};
		const focus = () => {
			focused = button.matches(":focus-visible");
			update();
		};
		const blur = (event: FocusEvent) => {
			if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
			focused = false;
			update();
		};
		const stopIfUnavailable = () => {
			if (!unavailable()) return;
			engaged = false;
			cancel();
		};
		const observer = new MutationObserver(stopIfUnavailable);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
		observer.observe(button, { attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
		media?.addEventListener("change", stopIfUnavailable);
		button.addEventListener("pointerenter", enter);
		button.addEventListener("pointerleave", leave);
		button.addEventListener("focusin", focus);
		button.addEventListener("focusout", blur);
		update();
		return () => {
			cancel();
			observer.disconnect();
			media?.removeEventListener("change", stopIfUnavailable);
			button.removeEventListener("pointerenter", enter);
			button.removeEventListener("pointerleave", leave);
			button.removeEventListener("focusin", focus);
			button.removeEventListener("focusout", blur);
		};
	}, [kind, expanded]);
	return ref;
}

interface AnimatedNavIconProps {
	readonly kind: "task" | "customize" | "folder" | "schedule";
	readonly size?: number;
	readonly className?: string;
	readonly expanded?: boolean;
}

export function AnimatedNavIcon({
	kind,
	size = kind === "folder" ? 14 : 15,
	className = "",
	expanded = false,
}: AnimatedNavIconProps) {
	const ref = useSidebarIconMotion(kind, expanded);
	const classes = `sidebar-semantic-icon animated-nav-icon animated-nav-icon-${kind} ${className}`;
	if (kind === "folder") {
		return (
			<span
				aria-hidden="true"
				className="sidebar-folder-icon"
				data-expanded={expanded}
				style={{ width: size, height: size }}
			>
				<Folder className={classes} data-folder-state="closed" ref={expanded ? undefined : ref} size={size} />
				<FolderOpen className={classes} data-folder-state="open" ref={expanded ? ref : undefined} size={size} />
			</span>
		);
	}
	const Icon = kind === "task" ? AddSquare : kind === "customize" ? Customize : AlarmClock;
	return <Icon aria-hidden="true" className={classes} data-expanded={expanded || undefined} ref={ref} size={size} />;
}
