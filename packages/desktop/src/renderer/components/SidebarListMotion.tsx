import type { ReactNode } from "react";
import { Component } from "react";

const MOTION_DURATION_MS = 230;
const MOTION_EASING = "cubic-bezier(.22,.8,.24,1)";
const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SCROLLER_SELECTOR = ".project-list";

export interface SidebarListMotionProps {
	readonly children: ReactNode;
	/** mode/grouping/destination/closing identity; changing it cancels all motion. */
	readonly scope: string;
	/**
	 * Additional owner boundary; changing it cancels motion within the same scope.
	 */
	readonly ownerKey?: string;
}

interface SnapshotEntry {
	readonly el: HTMLElement;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	/** Offsets ignore in-flight transforms, so content updates are not moves. */
	readonly layoutLeft: number;
	readonly layoutTop: number;
	readonly layoutWidth: number;
	readonly layoutHeight: number;
	readonly exit: boolean;
}

interface MotionSnapshot {
	readonly scope: string;
	readonly scrollTop: number;
	readonly entries: Map<string, SnapshotEntry>;
	readonly focus: { key: string; index: number; el: HTMLElement } | null;
}

interface TrackedEffect {
	readonly animation: { cancel(): void; finished?: Promise<unknown> } | null;
	readonly remnant?: HTMLElement;
	/** Layout updates retarget positions while opacity effects keep their progress. */
	readonly continuity: "position" | "opacity";
}

function motionKeyOf(el: Element): string | null {
	return el.getAttribute("data-sidebar-motion-key");
}

function focusablesOf(scope: ParentNode): HTMLElement[] {
	return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Parent-relative flow geometry, unaffected by in-flight transforms. */
function layoutOf(el: HTMLElement): { left: number; top: number; width: number; height: number } {
	return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
}

/**
 * Sidebar-local snapshot boundary that keeps session/project reordering visually
 * continuous. Children opt in with unique `data-sidebar-motion-key`; elements
 * additionally marked `data-sidebar-motion-exit` (section headers) may leave a
 * short inert visual remnant when they disappear.
 */
export class SidebarListMotion extends Component<SidebarListMotionProps> {
	private root: HTMLDivElement | null = null;
	private committedScope: string | null = null;
	private committedOwnerKey: string | undefined = undefined;
	private generation = 0;
	private effects = new Set<TrackedEffect>();
	private observer: MutationObserver | null = null;
	private media: {
		addEventListener(type: string, l: () => void): void;
		removeEventListener(t: string, l: () => void): void;
	} | null = null;
	private mediaListener: (() => void) | null = null;

	override componentDidMount(): void {
		this.committedScope = this.props.scope;
		this.committedOwnerKey = this.props.ownerKey;
		this.observeMotionPreference();
	}

	override componentWillUnmount(): void {
		this.cancelEffects();
		this.observer?.disconnect();
		this.observer = null;
		if (this.media && this.mediaListener) {
			this.media.removeEventListener("change", this.mediaListener);
		}
		this.media = null;
		this.mediaListener = null;
	}

	override getSnapshotBeforeUpdate(): MotionSnapshot | null {
		const root = this.root;
		if (!root) return null;
		const entries = new Map<string, SnapshotEntry>();
		for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-motion-key]"))) {
			const key = motionKeyOf(el);
			if (key === null || entries.has(key)) continue;
			const layout = layoutOf(el);
			const rect = el.getBoundingClientRect();
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
				exit: el.hasAttribute("data-sidebar-motion-exit"),
			});
		}
		let focus: MotionSnapshot["focus"] = null;
		const active = document.activeElement as HTMLElement | null;
		if (active && root.contains(active)) {
			const container = active.closest<HTMLElement>("[data-sidebar-motion-key]");
			if (container && root.contains(container)) {
				const key = motionKeyOf(container);
				const index = focusablesOf(container).indexOf(active);
				if (key !== null && index >= 0) focus = { key, index, el: active };
			}
		}
		return { scope: this.props.scope, scrollTop: this.scroller()?.scrollTop ?? 0, entries, focus };
	}

	override componentDidUpdate(
		_previous: Readonly<SidebarListMotionProps>,
		_state: Readonly<object>,
		snapshot: MotionSnapshot | null,
	): void {
		const root = this.root;
		if (!root || !snapshot) return;
		const reduced = this.motionReduced();
		// The snapshot was taken with the new props already applied, so scope
		// switches are detected against the previously committed scope.
		const scopeChanged = this.committedScope !== this.props.scope || this.committedOwnerKey !== this.props.ownerKey;
		this.committedScope = this.props.scope;
		this.committedOwnerKey = this.props.ownerKey;
		// Re-anchor scroll before measuring final rects so browser layout or
		// scroll anchoring cannot shift coordinates between reads.
		this.preserveScroll(snapshot);
		if (scopeChanged || reduced) {
			// Reduced motion, including a preference flipped mid-flight, drops every
			// animation and remnant; focus and scroll stay.
			this.cancelEffects();
			this.restoreFocus(snapshot, root);
			return;
		}
		const finals = this.finalElements(root);
		// Content updates must not cut a running header/exit/position animation short.
		if (this.layoutUnchanged(snapshot, finals)) {
			this.restoreFocus(snapshot, root);
			return;
		}
		// Position effects restart from the freshly measured visual coordinates.
		// Opacity and exit remnants stay so a layout change cannot flash them.
		this.cancelEffects((effect) => effect.continuity === "position");
		this.runFlip(snapshot, root, finals);
		this.restoreFocus(snapshot, root);
	}

	override render() {
		return (
			<div
				className="sidebar-list-motion"
				data-sidebar-motion-owner={this.props.ownerKey}
				ref={(el) => {
					this.root = el;
				}}
			>
				{this.props.children}
			</div>
		);
	}

	private scroller(): HTMLElement | null {
		return this.root?.closest<HTMLElement>(SCROLLER_SELECTOR) ?? null;
	}

	private motionReduced(): boolean {
		const preference = document.documentElement?.dataset?.motion;
		if (preference === "reduced") return true;
		if (preference === "full") return false;
		return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
	}

	private observeMotionPreference(): void {
		if (typeof MutationObserver !== "function") return;
		this.observer = new MutationObserver(() => {
			if (this.motionReduced()) this.cancelEffects();
		});
		this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
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
		if (!this.root) return;
		if (active) this.root.setAttribute("data-animating", "true");
		else this.root.removeAttribute("data-animating");
	}

	private cancelEffects(include: (effect: TrackedEffect) => boolean = () => true): void {
		const targeted = [...this.effects].filter(include);
		if (targeted.length === this.effects.size) this.generation += 1;
		for (const effect of targeted) {
			try {
				effect.animation?.cancel();
			} catch {
				// Animations may already be finished or orphaned.
			}
			effect.remnant?.remove();
			this.effects.delete(effect);
		}
		if (this.effects.size === 0) this.setAnimating(false);
	}

	private trackEffect(effect: TrackedEffect): void {
		this.effects.add(effect);
		this.setAnimating(true);
	}

	private finalElements(root: HTMLDivElement): Map<string, HTMLElement> {
		const finals = new Map<string, HTMLElement>();
		for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-motion-key]"))) {
			const key = motionKeyOf(el);
			if (key === null || finals.has(key)) continue;
			finals.set(key, el);
		}
		return finals;
	}

	/**
	 * True when every motion identity is the same node in the same order and its
	 * transform-independent layout matches. In-flight translations are ignored so
	 * a content update cannot look like a move and restart the animation.
	 */
	private layoutUnchanged(snapshot: MotionSnapshot, finals: ReadonlyMap<string, HTMLElement>): boolean {
		if (finals.size !== snapshot.entries.size) return false;
		const beforeKeys = [...snapshot.entries.keys()];
		const afterKeys = [...finals.keys()];
		if (beforeKeys.join("\0") !== afterKeys.join("\0")) return false;
		for (const [key, el] of finals) {
			const before = snapshot.entries.get(key);
			if (!before || before.el !== el || before.exit !== el.hasAttribute("data-sidebar-motion-exit")) return false;
			const layout = layoutOf(el);
			if (
				Math.abs(layout.left - before.layoutLeft) >= 1 ||
				Math.abs(layout.top - before.layoutTop) >= 1 ||
				Math.abs(layout.width - before.layoutWidth) >= 1 ||
				Math.abs(layout.height - before.layoutHeight) >= 1
			) {
				return false;
			}
		}
		return true;
	}

	private runFlip(snapshot: MotionSnapshot, root: HTMLDivElement, finals: ReadonlyMap<string, HTMLElement>): void {
		// Read every final rect before writing any animation: once a parent's
		// transform is applied, its descendants' getBoundingClientRect would
		// already include it and the ancestor subtraction would double-count.
		const finalRects = new Map<string, DOMRect>();
		for (const [key, el] of finals) finalRects.set(key, el.getBoundingClientRect());
		// Raw before→final displacement per node; each child subtracts the raw
		// total of its nearest motion ancestor, never a previously computed
		// residual, so grandchildren stay accurate as well.
		const raws = new Map<string, { dx: number; dy: number }>();
		const moves: { el: HTMLElement; dx: number; dy: number }[] = [];
		const fades: HTMLElement[] = [];
		for (const [key, el] of finals) {
			const before = snapshot.entries.get(key);
			const after = finalRects.get(key);
			if (!after) continue;
			if (!before) {
				// Fresh headers and explicitly entering rows fade in. Whole groups
				// that already contain known sessions appear immediately.
				if (el.hasAttribute("data-sidebar-motion-exit") || el.hasAttribute("data-sidebar-motion-enter"))
					fades.push(el);
				continue;
			}
			let dx = before.left - after.left;
			let dy = before.top - after.top;
			raws.set(key, { dx, dy });
			let parent = el.parentElement;
			while (parent && parent !== root) {
				const parentKey = motionKeyOf(parent);
				if (parentKey !== null && raws.has(parentKey)) {
					const raw = raws.get(parentKey);
					if (raw) {
						dx -= raw.dx;
						dy -= raw.dy;
						break;
					}
				}
				parent = parent.parentElement;
			}
			if (Math.abs(dx) + Math.abs(dy) < 1) continue;
			moves.push({ el, dx, dy });
		}
		for (const move of moves) this.translate(move.el, move.dx, move.dy);
		for (const el of fades) this.fadeIn(el);
		this.leaveExitRemnants(snapshot, root, new Set(finals.keys()));
	}

	private fadeIn(el: HTMLElement): void {
		if (typeof el.animate !== "function") return;
		const generation = this.generation;
		const animation = el.animate([{ opacity: "0" }, { opacity: "1" }], {
			duration: MOTION_DURATION_MS,
			easing: MOTION_EASING,
		});
		const effect: TrackedEffect = { animation, continuity: "opacity" };
		const settle = () => {
			this.effects.delete(effect);
			if (generation === this.generation && this.effects.size === 0) this.setAnimating(false);
		};
		animation.finished?.then(settle, settle).catch(() => undefined);
		this.trackEffect(effect);
	}

	private translate(el: HTMLElement, dx: number, dy: number): void {
		if (typeof el.animate !== "function") return;
		const generation = this.generation;
		const animation = el.animate(
			[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
			{ duration: MOTION_DURATION_MS, easing: MOTION_EASING },
		);
		const effect: TrackedEffect = { animation, continuity: "position" };
		const settle = () => {
			this.effects.delete(effect);
			if (generation === this.generation && this.effects.size === 0) this.setAnimating(false);
		};
		animation.finished?.then(settle, settle).catch(() => undefined);
		animation.oncancel = settle;
		this.trackEffect(effect);
	}

	private leaveExitRemnants(snapshot: MotionSnapshot, root: HTMLDivElement, liveKeys: ReadonlySet<string>): void {
		if (typeof (HTMLElement.prototype as { animate?: unknown }).animate !== "function") return;
		const rootRect = root.getBoundingClientRect();
		// Remnants are absolutely positioned against the boundary root.
		if (getComputedStyle(root).position === "static") root.style.position = "relative";
		const generation = this.generation;
		for (const [key, entry] of snapshot.entries) {
			if (!entry.exit || liveKeys.has(key)) continue;
			const remnant = entry.el.cloneNode(true) as HTMLElement;
			remnant.removeAttribute("id");
			for (const nested of Array.from(remnant.querySelectorAll("[id]"))) nested.removeAttribute("id");
			remnant.removeAttribute("data-sidebar-motion-key");
			for (const nested of Array.from(remnant.querySelectorAll("[data-sidebar-motion-key]")))
				nested.removeAttribute("data-sidebar-motion-key");
			remnant.setAttribute("aria-hidden", "true");
			remnant.setAttribute("inert", "");
			remnant.style.pointerEvents = "none";
			remnant.style.position = "absolute";
			remnant.style.left = `${entry.left - rootRect.left}px`;
			remnant.style.top = `${entry.top - rootRect.top}px`;
			remnant.style.width = `${entry.width}px`;
			remnant.style.height = `${entry.height}px`;
			remnant.style.margin = "0";
			root.append(remnant);
			const animation = remnant.animate([{ opacity: "1" }, { opacity: "0" }], {
				duration: MOTION_DURATION_MS,
				easing: MOTION_EASING,
			});
			const effect: TrackedEffect = { animation, remnant, continuity: "opacity" };
			const settle = () => {
				this.effects.delete(effect);
				remnant.remove();
				if (generation === this.generation && this.effects.size === 0) this.setAnimating(false);
			};
			animation.finished?.then(settle, settle).catch(() => undefined);
			this.trackEffect(effect);
		}
	}

	private restoreFocus(snapshot: MotionSnapshot, root: HTMLDivElement): void {
		const focus = snapshot.focus;
		if (!focus || focus.el.isConnected) return;
		// Any real control keeps the focus, whether inside the list or moved to
		// another surface such as a dialog; restore only from body/document.
		const current = document.activeElement;
		if (current && current !== document.body && current !== document.documentElement) return;
		for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-motion-key]"))) {
			if (motionKeyOf(el) !== focus.key) continue;
			const target = focusablesOf(el)[focus.index];
			if (target?.closest('[hidden], [inert], [aria-hidden="true"]')) {
				const heading = target
					.closest(".session-section")
					?.querySelector<HTMLElement>(":scope > .session-section-heading");
				if (heading && !heading.closest('[hidden], [inert], [aria-hidden="true"]'))
					heading.focus({ preventScroll: true });
			} else target?.focus({ preventScroll: true });
			return;
		}
	}

	private preserveScroll(snapshot: MotionSnapshot): void {
		const scroller = this.scroller();
		if (!scroller) return;
		scroller.scrollTop = Math.max(0, Math.min(snapshot.scrollTop, scroller.scrollHeight - scroller.clientHeight));
	}
}
