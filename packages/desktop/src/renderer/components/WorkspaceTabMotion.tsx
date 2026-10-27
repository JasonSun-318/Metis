import { Component, type ReactNode } from "react";
import {
	sanitizeTabMotionGhost,
	TAB_MOTION_DURATION_MS,
	TAB_MOTION_EASING,
	TAB_MOTION_GHOST_CLASS,
	TAB_MOTION_KEY_ATTRIBUTE,
	tabMotionAnimationsSupported,
	tabMotionReduced,
	tabStripLayout,
} from "../workspace-tab-motion.ts";
import "../styles/workspace-tab-motion.css";

export interface WorkspaceTabMotionProps {
	/** Pane/tool strip identity; a different scope cancels motion instead of morphing between strips. */
	readonly scope: string;
	/** Ordered tab identities; content and streaming updates do not request layout motion. */
	readonly layoutKey: string;
	/** Drag, split-resize and drawer transitions own the layout; tab motion stays out of their way. */
	readonly suspended?: boolean;
	/** Called after the last animation settles so the strip's underline can snap to final geometry. */
	readonly onSettled?: () => void;
	/** Project strip geometry after DOM commit and before measuring animation targets. */
	readonly prepareLayout?: (host: HTMLElement) => void;
	readonly children: ReactNode;
}

interface SnapshotEntry {
	readonly el: HTMLElement;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	/** Layout-only coordinates that ignore in-flight transforms. */
	readonly layoutLeft: number;
	readonly layoutTop: number;
	readonly layoutWidth: number;
	readonly layoutHeight: number;
}

interface TabMotionSnapshot {
	readonly scope: string;
	readonly scrollLeft: number;
	readonly entries: Map<string, SnapshotEntry>;
}

interface TrackedEffect {
	readonly animation: Animation;
	readonly ghost?: HTMLElement;
}

/**
 * Snapshot boundary around one tab strip. Tab add/remove commits immediately;
 * surviving headers retarget from their current on-screen geometry, newly added
 * headers fade in, and a removed header leaves only an inert visual ghost.
 */
export class WorkspaceTabMotion extends Component<WorkspaceTabMotionProps> {
	private root: HTMLDivElement | null = null;
	private committedScope: string | null = null;
	private generation = 0;
	private effects = new Set<TrackedEffect>();
	private motionObserver: MutationObserver | null = null;
	private media: MediaQueryList | null = null;
	private mediaListener: (() => void) | null = null;

	override componentDidMount(): void {
		this.committedScope = this.props.scope;
		const host = this.host();
		if (host) this.props.prepareLayout?.(host);
		this.observeMotionPreference();
	}

	override componentWillUnmount(): void {
		this.cancelEffects();
		this.motionObserver?.disconnect();
		this.motionObserver = null;
		if (this.media && this.mediaListener) this.media.removeEventListener("change", this.mediaListener);
		this.media = null;
		this.mediaListener = null;
	}

	override getSnapshotBeforeUpdate(previous: Readonly<WorkspaceTabMotionProps>): TabMotionSnapshot | null {
		if (
			previous.scope === this.props.scope &&
			previous.layoutKey === this.props.layoutKey &&
			previous.suspended === this.props.suspended
		) {
			return null;
		}
		const root = this.root;
		if (!root) return null;
		const host = this.host();
		const entries = new Map<string, SnapshotEntry>();
		for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${TAB_MOTION_KEY_ATTRIBUTE}]`))) {
			const key = el.getAttribute(TAB_MOTION_KEY_ATTRIBUTE);
			if (key === null || entries.has(key)) continue;
			const rect = el.getBoundingClientRect();
			const layout = tabStripLayout(el, host);
			entries.set(key, {
				el,
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
				layoutLeft: layout.left,
				layoutTop: layout.top,
				layoutWidth: layout.width,
				layoutHeight: layout.height,
			});
		}
		return {
			scope: this.committedScope ?? this.props.scope,
			scrollLeft: this.host()?.scrollLeft ?? 0,
			entries,
		};
	}

	override componentDidUpdate(
		_previous: Readonly<WorkspaceTabMotionProps>,
		_state: Readonly<object>,
		snapshot: TabMotionSnapshot | null,
	): void {
		const host = this.host();
		if (host) this.props.prepareLayout?.(host);
		const scopeChanged = this.committedScope !== this.props.scope;
		this.committedScope = this.props.scope;
		// A scope switch never morphs between strips; motion simply stops.
		if (scopeChanged) {
			this.cancelEffects();
			return;
		}
		// Drag, resize and drawer transitions own geometry, and reduced motion
		// must cancel immediately even mid-animation.
		if (this.props.suspended || this.motionReduced() || !tabMotionAnimationsSupported()) {
			this.cancelEffects();
			return;
		}
		if (!snapshot) return;
		if (!host) return;
		const finals = this.finalTabs();
		// Streaming/content renders must not cut a running strip animation short.
		if (this.layoutUnchanged(snapshot, finals, host)) return;
		// Cancelling old effects first snaps survivors to the fresh flow layout;
		// the snapshot still holds their current visual coordinates.
		this.cancelEffects();
		this.preserveScroll(host, snapshot.scrollLeft);
		this.animateChanges(snapshot, host, finals);
	}

	override render() {
		return (
			<div
				className="tool-tab-motion"
				ref={(el) => {
					this.root = el;
				}}
				style={{ display: "contents" }}
			>
				{this.props.children}
			</div>
		);
	}

	private host(): HTMLElement | null {
		return this.root?.closest<HTMLElement>(".tool-tabs-scroll") ?? null;
	}

	private finalTabs(): Map<string, HTMLElement> {
		const finals = new Map<string, HTMLElement>();
		for (const el of Array.from(this.root?.querySelectorAll<HTMLElement>(`[${TAB_MOTION_KEY_ATTRIBUTE}]`) ?? [])) {
			const key = el.getAttribute(TAB_MOTION_KEY_ATTRIBUTE);
			if (key === null || finals.has(key)) continue;
			finals.set(key, el);
		}
		return finals;
	}

	private layoutUnchanged(
		snapshot: TabMotionSnapshot,
		finals: ReadonlyMap<string, HTMLElement>,
		host: HTMLElement,
	): boolean {
		if (finals.size !== snapshot.entries.size) return false;
		const beforeKeys = [...snapshot.entries.keys()];
		const afterKeys = [...finals.keys()];
		if (beforeKeys.join("\0") !== afterKeys.join("\0")) return false;
		for (const [key, el] of finals) {
			const before = snapshot.entries.get(key)!;
			if (before.el !== el) return false;
			const layout = tabStripLayout(el, host);
			if (
				Math.abs(layout.left - before.layoutLeft) > 0.5 ||
				Math.abs(layout.top - before.layoutTop) > 0.5 ||
				Math.abs(layout.width - before.layoutWidth) > 0.5 ||
				Math.abs(layout.height - before.layoutHeight) > 0.5
			) {
				return false;
			}
		}
		return true;
	}

	private motionReduced(): boolean {
		return tabMotionReduced();
	}

	private observeMotionPreference(): void {
		if (typeof document !== "undefined" && typeof MutationObserver === "function") {
			this.motionObserver = new MutationObserver(() => {
				if (this.motionReduced()) this.cancelEffects();
			});
			this.motionObserver.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ["data-motion"],
			});
		}
		if (typeof matchMedia !== "function") return;
		const media = matchMedia("(prefers-reduced-motion: reduce)");
		const listener = () => {
			if (this.motionReduced()) this.cancelEffects();
		};
		media.addEventListener?.("change", listener);
		this.media = media;
		this.mediaListener = listener;
	}

	private setAnimating(active: boolean): void {
		const host = this.host();
		if (!host) return;
		if (active) host.setAttribute("data-tab-motion-animating", "true");
		else host.removeAttribute("data-tab-motion-animating");
	}

	private cancelEffects(): void {
		this.generation += 1;
		for (const effect of this.effects) {
			try {
				effect.animation.cancel();
			} catch {
				// Animations may already be finished or orphaned.
			}
			effect.ghost?.remove();
		}
		this.effects.clear();
		this.setAnimating(false);
	}

	private trackEffect(effect: TrackedEffect): void {
		const generation = this.generation;
		this.effects.add(effect);
		this.setAnimating(true);
		const settle = () => {
			if (!this.effects.delete(effect)) return;
			effect.ghost?.remove();
			if (generation !== this.generation || this.effects.size > 0) return;
			this.setAnimating(false);
			this.props.onSettled?.();
		};
		effect.animation.finished.then(settle, settle).catch(() => undefined);
	}

	private preserveScroll(host: HTMLElement, scrollLeft: number): void {
		host.scrollLeft = Math.max(0, Math.min(scrollLeft, host.scrollWidth - host.clientWidth));
	}

	private animateChanges(
		snapshot: TabMotionSnapshot,
		host: HTMLElement,
		finals: ReadonlyMap<string, HTMLElement>,
	): void {
		// Read every final rect before writing animations so transforms applied to
		// one header never contaminate a sibling's measurement.
		const finalRects = new Map<string, DOMRect>();
		for (const [key, el] of finals) finalRects.set(key, el.getBoundingClientRect());
		for (const [key, el] of finals) {
			const before = snapshot.entries.get(key);
			const after = finalRects.get(key);
			if (!after) continue;
			if (!before) {
				this.appear(el);
				continue;
			}
			const dx = before.left - after.left;
			const dy = before.top - after.top;
			if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
			this.translate(el, dx, dy);
		}
		const hostRect = host.getBoundingClientRect();
		for (const [key, entry] of snapshot.entries) {
			if (finals.has(key) || entry.el.isConnected) continue;
			this.leaveGhost(entry, host, hostRect, snapshot.scrollLeft);
		}
	}

	private appear(el: HTMLElement): void {
		const animation = el.animate(
			[
				{ opacity: "0", transform: "translateY(-2px)" },
				{ opacity: "1", transform: "translateY(0px)" },
			],
			{ duration: TAB_MOTION_DURATION_MS, easing: TAB_MOTION_EASING },
		);
		this.trackEffect({ animation });
	}

	private translate(el: HTMLElement, dx: number, dy: number): void {
		const animation = el.animate(
			[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
			{ duration: TAB_MOTION_DURATION_MS, easing: TAB_MOTION_EASING },
		);
		this.trackEffect({ animation });
	}

	private leaveGhost(entry: SnapshotEntry, host: HTMLElement, hostRect: DOMRect, scrollLeft: number): void {
		const ghost = entry.el.cloneNode(true) as HTMLElement;
		sanitizeTabMotionGhost(ghost);
		ghost.classList.add(TAB_MOTION_GHOST_CLASS);
		// Remnants are absolutely positioned against the strip's scroll surface.
		if (getComputedStyle(host).position === "static") host.style.position = "relative";
		ghost.style.position = "absolute";
		ghost.style.left = `${entry.left - hostRect.left + scrollLeft}px`;
		ghost.style.top = `${entry.top - hostRect.top}px`;
		ghost.style.width = `${entry.width}px`;
		ghost.style.height = `${entry.height}px`;
		ghost.style.margin = "0";
		ghost.style.pointerEvents = "none";
		ghost.style.zIndex = "1";
		host.append(ghost);
		const animation = ghost.animate(
			[
				{ opacity: "1", transform: "translateY(0px)" },
				{ opacity: "0", transform: "translateY(-2px)" },
			],
			{ duration: TAB_MOTION_DURATION_MS, easing: TAB_MOTION_EASING },
		);
		this.trackEffect({ animation, ghost });
	}
}
