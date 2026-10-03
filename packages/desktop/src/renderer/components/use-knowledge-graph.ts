import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { graphLabels } from "./knowledge-graph-labels.ts";
import {
	fitGraph,
	type GraphSize,
	type GraphView,
	graphPoint,
	type KnowledgeGraphData,
	KnowledgeGraphLayout,
	nodeRadius,
	zoomGraph,
} from "./knowledge-graph-layout.ts";

type Gesture = {
	pointerId: number;
	path: string | null;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	offsetX: number;
	offsetY: number;
	moved: boolean;
};

export function graphEdgeKey(source: string, target: string): string {
	return `${source}\0${target}`;
}

export function useKnowledgeGraph(graph: KnowledgeGraphData, active: boolean) {
	const [layout] = useState(() => new KnowledgeGraphLayout());
	const stage = useRef<HTMLDivElement>(null);
	const canvas = useRef<SVGSVGElement>(null);
	const viewport = useRef<SVGGElement>(null);
	const nodes = useRef(new Map<string, SVGGElement>());
	const edges = useRef(new Map<string, SVGLineElement>());
	const size = useRef<GraphSize>({ width: 0, height: 0 });
	const view = useRef<GraphView>({ x: 0, y: 0, zoom: 1 });
	const autoFit = useRef(true);
	const enabled = useRef(active);
	const frame = useRef<number | null>(null);
	const gesture = useRef<Gesture | null>(null);
	const suppressClick = useRef<string | null>(null);
	const hover = useRef<string | null>(null);
	const [highlighted, setHighlighted] = useState<string | null>(null);

	const draw = useCallback(() => {
		const { width, height } = size.current;
		if (!width || !height) return;
		if (autoFit.current) view.current = fitGraph(layout.nodes, size.current);
		const current = view.current;
		const labels = graphLabels(layout.nodes, current, size.current, hover.current);
		canvas.current?.setAttribute("viewBox", `0 0 ${width} ${height}`);
		viewport.current?.setAttribute("transform", `translate(${current.x} ${current.y}) scale(${current.zoom})`);
		for (const node of layout.nodes) {
			const element = nodes.current.get(node.path);
			if (!element) continue;
			element.setAttribute("transform", `translate(${node.x} ${node.y})`);
			const radius = nodeRadius(node.degree, layout.nodes.length > 300);
			element.querySelector(".knowledge-node-dot")?.setAttribute("r", String(radius / current.zoom));
			element.querySelector(".knowledge-node-hit")?.setAttribute("r", String(12 / current.zoom));
			const label = element.querySelector("text");
			if (label) {
				const position = labels.get(node.path);
				label.setAttribute("opacity", position ? "1" : "0");
				if (position) {
					label.textContent = position.text;
					label.setAttribute("x", String(position.x));
					label.setAttribute("y", String(position.y));
					label.setAttribute("font-size", String(11 / current.zoom));
				}
			}
		}
		for (const edge of layout.edges) {
			const source = layout.byPath.get(edge.source);
			const target = layout.byPath.get(edge.target);
			const element = edges.current.get(graphEdgeKey(edge.source, edge.target));
			if (!element || !source || !target) continue;
			element.setAttribute("x1", String(source.x));
			element.setAttribute("y1", String(source.y));
			element.setAttribute("x2", String(target.x));
			element.setAttribute("y2", String(target.y));
		}
	}, [layout]);

	const pause = useCallback(() => {
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = null;
	}, []);
	const animate = useCallback(() => {
		if (
			frame.current !== null ||
			!enabled.current ||
			!layout.nodes.length ||
			!size.current.width ||
			!size.current.height ||
			document.visibilityState === "hidden"
		)
			return;
		if (layout.simulation.alpha() < layout.simulation.alphaMin() && !layout.simulation.alphaTarget()) return;
		let painted = 0;
		const tick = (time: number) => {
			frame.current = null;
			if (!enabled.current || document.visibilityState === "hidden") return;
			const interval = layout.nodes.length > 400 ? 32 : 16;
			let moving = true;
			if (time - painted >= interval) {
				moving = layout.step();
				draw();
				painted = time;
			}
			if (moving) frame.current = requestAnimationFrame(tick);
		};
		frame.current = requestAnimationFrame(tick);
	}, [draw, layout]);

	useLayoutEffect(() => {
		enabled.current = active;
		layout.update(graph);
		draw();
		if (active) animate();
		else {
			if (gesture.current?.path) layout.release(gesture.current.path);
			gesture.current = null;
			pause();
		}
	}, [active, animate, draw, graph, layout, pause]);
	useLayoutEffect(() => {
		const element = stage.current;
		if (!element) return;
		const measure = () => {
			const rect = element.getBoundingClientRect();
			const previous = size.current;
			const next = { width: rect.width, height: rect.height };
			if (!autoFit.current && previous.width && previous.height && next.width && next.height) {
				view.current = {
					...view.current,
					x: view.current.x + (next.width - previous.width) / 2,
					y: view.current.y + (next.height - previous.height) / 2,
				};
			}
			size.current = next;
			draw();
			if (next.width && next.height) animate();
			else pause();
		};
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		measure();
		return () => observer.disconnect();
	}, [animate, draw, pause]);
	useEffect(() => {
		const visibility = () => (document.visibilityState === "hidden" ? pause() : animate());
		document.addEventListener("visibilitychange", visibility);
		return () => {
			document.removeEventListener("visibilitychange", visibility);
			pause();
			layout.stop();
		};
	}, [animate, layout, pause]);
	// React owns note content and accessibility; animation only writes geometry.
	useLayoutEffect(draw);

	const screenPoint = useCallback((clientX: number, clientY: number) => {
		const rect = canvas.current!.getBoundingClientRect();
		return {
			x: ((clientX - rect.left) * size.current.width) / (rect.width || size.current.width),
			y: ((clientY - rect.top) * size.current.height) / (rect.height || size.current.height),
		};
	}, []);
	const zoomAt = useCallback(
		(factor: number, point: { x: number; y: number }) => {
			autoFit.current = false;
			view.current = zoomGraph(view.current, factor, point);
			draw();
		},
		[draw],
	);
	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			zoomAt(
				Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.002),
				screenPoint(event.clientX, event.clientY),
			);
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, [screenPoint, zoomAt]);

	const endGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId) return;
		gesture.current = null;
		if (current.path) {
			layout.release(current.path);
			if (current.moved) suppressClick.current = current.path;
			animate();
		}
	};
	return {
		stage,
		canvas,
		viewport,
		nodes,
		edges,
		highlighted,
		highlight: (path: string | null) => {
			hover.current = path;
			setHighlighted(path);
		},
		fit: () => {
			autoFit.current = true;
			draw();
		},
		zoom: (factor: number) => zoomAt(factor, { x: size.current.width / 2, y: size.current.height / 2 }),
		allowOpen: (path: string) => {
			if (suppressClick.current !== path) return true;
			suppressClick.current = null;
			return false;
		},
		onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => {
			if (event.button !== 0 || gesture.current || !size.current.width || !size.current.height) return;
			const target = (event.target as Element).closest<SVGGElement>("[data-knowledge-path]");
			const path = target?.getAttribute("data-knowledge-path") ?? null;
			const point = screenPoint(event.clientX, event.clientY);
			const node = path ? layout.byPath.get(path) : undefined;
			if (path && !node) return;
			autoFit.current = false;
			suppressClick.current = null;
			gesture.current = {
				pointerId: event.pointerId,
				path,
				startX: point.x,
				startY: point.y,
				lastX: point.x,
				lastY: point.y,
				offsetX: node ? node.x * view.current.zoom + view.current.x - point.x : 0,
				offsetY: node ? node.y * view.current.zoom + view.current.y - point.y : 0,
				moved: false,
			};
			if (node) {
				layout.pin(node.path, node.x, node.y);
				animate();
			}
			(target ?? event.currentTarget).setPointerCapture?.(event.pointerId);
		},
		onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => {
			const current = gesture.current;
			if (!current || current.pointerId !== event.pointerId) return;
			const point = screenPoint(event.clientX, event.clientY);
			current.moved ||= Math.hypot(point.x - current.startX, point.y - current.startY) > 3;
			if (current.path) {
				const position = graphPoint(view.current, { x: point.x + current.offsetX, y: point.y + current.offsetY });
				layout.pin(current.path, position.x, position.y);
				animate();
			} else
				view.current = {
					...view.current,
					x: view.current.x + point.x - current.lastX,
					y: view.current.y + point.y - current.lastY,
				};
			current.lastX = point.x;
			current.lastY = point.y;
			draw();
		},
		onPointerUp: endGesture,
		onPointerCancel: endGesture,
		onLostPointerCapture: endGesture,
	};
}
