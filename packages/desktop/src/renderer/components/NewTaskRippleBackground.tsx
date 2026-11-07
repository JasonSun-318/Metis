import { useEffect, useRef } from "react";
import { RippleField } from "../new-task-ripple-field.ts";

const FRAME_INTERVAL = 1000 / 60;
const FOREGROUND =
	".new-task-home-heading, .new-task-home-composer, .new-task-more-drawer, button, a, [role=button], [role=menu], [role=dialog]";

export function NewTaskRippleBackground() {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const home = canvas?.parentElement;
		if (!canvas || !home) return;
		let field: RippleField | undefined;
		let frame: number | undefined;
		let width = 0;
		let height = 0;
		let density = 0;
		let elapsed = 0;
		let previousTime: number | undefined;
		let nextPaint = 0;

		function sync() {
			if (field && width > 0 && height > 0 && !document.hidden) {
				frame ??= requestAnimationFrame(tick);
				return;
			}
			if (frame !== undefined) cancelAnimationFrame(frame);
			frame = undefined;
			previousTime = undefined;
			nextPaint = 0;
			field?.clearRipples();
		}

		function tick(time: number) {
			if (previousTime !== undefined) elapsed += time - previousTime;
			previousTime = time;
			if (time >= nextPaint - 0.5 && field) {
				// Use a deadline instead of rounding the interval to a number of screen refreshes.
				nextPaint =
					nextPaint === 0
						? time + FRAME_INTERVAL
						: nextPaint + (1 + Math.floor(Math.max(0, time - nextPaint) / FRAME_INTERVAL)) * FRAME_INTERVAL;
				const scale = Math.min(window.devicePixelRatio || 1, 2);
				if (scale !== density) {
					density = scale;
					field.resize(width, height, density);
				}
				field.paint(elapsed, document.documentElement.dataset.theme ?? "");
			}
			frame = requestAnimationFrame(tick);
		}

		const resize = new ResizeObserver(([entry]) => {
			if (!entry) return;
			({ width, height } = entry.contentRect);
			if (width > 0 && height > 0) {
				if (!field) {
					const context = canvas.getContext("2d");
					if (!context) return;
					field = new RippleField(canvas, context);
				}
				density = Math.min(window.devicePixelRatio || 1, 2);
				field.resize(width, height, density);
			}
			sync();
		});

		const onClick = (event: MouseEvent) => {
			if (
				!field ||
				frame === undefined ||
				document.hidden ||
				event.defaultPrevented ||
				event.button !== 0 ||
				event.detail === 0 ||
				!(event.target instanceof Element) ||
				event.target.closest(FOREGROUND)
			)
				return;
			const bounds = canvas.getBoundingClientRect();
			const x = (event.clientX - bounds.left) / bounds.width;
			const y = (event.clientY - bounds.top) / bounds.height;
			if (x >= 0 && x <= 1 && y >= 0 && y <= 1) field.addRipple(x, y, elapsed);
		};

		resize.observe(canvas);
		home.addEventListener("click", onClick, { passive: true });
		document.addEventListener("visibilitychange", sync);
		return () => {
			resize.disconnect();
			home.removeEventListener("click", onClick);
			document.removeEventListener("visibilitychange", sync);
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, []);

	return <canvas className="new-task-ripple-background" inert ref={canvasRef} />;
}
