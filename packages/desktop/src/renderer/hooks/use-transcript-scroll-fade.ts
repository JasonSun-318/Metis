import { type RefObject, useLayoutEffect } from "react";

export function useTranscriptScrollFade(
	scrollRef: RefObject<HTMLDivElement | null>,
	contentRef: RefObject<HTMLDivElement | null>,
): void {
	useLayoutEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		let frame: number | undefined;

		const update = () => {
			const height = scroll.clientHeight;
			const overflow = Math.max(0, scroll.scrollHeight - height);
			const top = Math.max(0, Math.min(overflow, scroll.scrollTop));
			const remaining = overflow - top;
			const visible = height > 0 && overflow > 1;
			const topFade = visible && top > 1 ? Math.min(48, top) : 0;
			const bottomFade = visible && remaining > 1 ? Math.min(56, remaining) : 0;
			scroll.style.setProperty("--transcript-fade-top", `${topFade}px`);
			scroll.style.setProperty("--transcript-fade-bottom", `${bottomFade}px`);
			scroll.dataset.scrollFade = topFade > 0 || bottomFade > 0 ? "true" : "false";
		};
		const schedule = () => {
			if (frame !== undefined) return;
			frame = requestAnimationFrame(() => {
				frame = undefined;
				update();
			});
		};

		update();
		scroll.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(schedule);
		observer.observe(scroll);
		if (contentRef.current) observer.observe(contentRef.current);

		return () => {
			scroll.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame !== undefined) cancelAnimationFrame(frame);
			scroll.style.removeProperty("--transcript-fade-top");
			scroll.style.removeProperty("--transcript-fade-bottom");
			delete scroll.dataset.scrollFade;
		};
	}, [scrollRef, contentRef]);
}
