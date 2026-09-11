export function animateNewTaskComposer(
	target: HTMLFormElement,
	source: DOMRectReadOnly,
	reducedMotion: boolean,
): Animation | null {
	if (reducedMotion || !target.isConnected || typeof target.animate !== "function") return null;
	const destination = target.getBoundingClientRect();
	if (source.width <= 0 || source.height <= 0 || destination.width <= 0 || destination.height <= 0) return null;
	try {
		const animation = target.animate(
			[
				{ transform: `translate(${source.left - destination.left}px, ${source.top - destination.top}px)` },
				{ transform: "translate(0px, 0px)" },
			],
			{ duration: 360, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "none" },
		);
		target.dataset.homeTransition = "running";
		void animation.finished
			.catch(() => undefined)
			.finally(() => {
				delete target.dataset.homeTransition;
			});
		return animation;
	} catch {
		return null;
	}
}
