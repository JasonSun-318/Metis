import { type ReactNode, useLayoutEffect, useRef } from "react";

export function ComposerPanelStack({ children }: { readonly children: ReactNode }) {
	const stack = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const element = stack.current;
		if (!element) return;
		const pane = element.closest<HTMLElement>(".conversation-column");
		const composer = element.parentElement?.querySelector<HTMLElement>(".composer");
		let previousInteraction: Element | null = null;
		let previousOffset = -1;
		let previousHeight = -1;
		let previousLimit = -1;
		const resize = () => {
			const height = pane?.clientHeight || window.innerHeight;
			const composerHeight = composer?.getBoundingClientRect().height ?? 0;
			const limit = Math.max(40, Math.min(360, height * 0.45, height - composerHeight - 120));
			element.style.setProperty("--composer-panels-limit", `${Math.floor(limit)}px`);
			const interaction = element.querySelector<HTMLElement>(
				".ask-user-slot, .ask-user-resume, .permission-approval-slot",
			);
			if (!interaction) {
				previousInteraction = null;
				return;
			}
			const bounds = element.getBoundingClientRect();
			const target = interaction.getBoundingClientRect();
			const offset = target.top - bounds.top + element.scrollTop;
			// Reveal new/changed requests without undoing the user's manual scroll on unrelated updates.
			if (
				interaction !== previousInteraction ||
				Math.abs(offset - previousOffset) > 0.5 ||
				Math.abs(target.height - previousHeight) > 0.5 ||
				limit !== previousLimit
			) {
				element.scrollTop +=
					target.height <= element.clientHeight ? target.bottom - bounds.bottom : target.top - bounds.top;
			}
			previousInteraction = interaction;
			previousOffset = offset;
			previousHeight = target.height;
			previousLimit = limit;
		};
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
		if (pane) observer?.observe(pane);
		if (composer) observer?.observe(composer);
		observer?.observe(element);
		let observed: Element[] = [];
		const observePanels = () => {
			for (const panel of observed) observer?.unobserve(panel);
			observed = Array.from(element.children);
			for (const panel of observed) observer?.observe(panel);
			resize();
		};
		const mutations = new MutationObserver(observePanels);
		mutations.observe(element, { childList: true });
		observePanels();
		window.addEventListener("resize", resize);
		return () => {
			observer?.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", resize);
		};
	}, []);

	return (
		<div className="composer-panels" ref={stack}>
			{children}
		</div>
	);
}
