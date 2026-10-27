import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { clampGraphDrag, constrainGraphView, graphZoomLimits } from "./knowledge-graph-camera.ts";
import { type GraphLabel, graphLabels } from "./knowledge-graph-labels.ts";
import {
	fitGraph,
	type GraphView,
	graphPoint,
	type KnowledgeGraphData,
	nodeRadius,
	zoomGraph,
} from "./knowledge-graph-layout.ts";
import { type GraphSession, graphNeighbors, graphScope } from "./knowledge-graph-session.ts";

type Gesture = {
	pointerId: number;
	path: string | null;
	target: Element;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	offsetX: number;
	offsetY: number;
	moved: boolean;
};
type CameraTransition = { from: GraphView; to: GraphView; start: number | null };

export function graphEdgeKey(source: string, target: string): string {
	return `${source}\0${target}`;
}

export function useKnowledgeGraph(
	graph: KnowledgeGraphData,
	active: boolean,
	session: GraphSession,
	selected: string | null,
	visible: ReadonlySet<string>,
) {
	const { layout } = session;
	const stage = useRef<HTMLDivElement>(null);
	const canvas = useRef<SVGSVGElement>(null);
	const viewport = useRef<SVGGElement>(null);
	const nodes = useRef(new Map<string, SVGGElement>());
	const edges = useRef(new Map<string, SVGLineElement>());
	const enabled = useRef(active);
	const frame = useRef<number | null>(null);
	const gesture = useRef<Gesture | null>(null);
	const suppressClick = useRef(false);
	const hover = useRef<string | null>(null);
	const [hovered, setHovered] = useState<string | null>(null);
	const labels = useRef(new Map<string, GraphLabel>());
	const transition = useRef<CameraTransition | null>(null);
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	const neighbors = useMemo(() => graphNeighbors(graph), [graph]);
	const neighborsRef = useRef(neighbors);
	neighborsRef.current = neighbors;
	const reduced = useCallback(
		() =>
			document.documentElement.dataset.motion === "reduced" ||
			(!document.documentElement.dataset.motion && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
		[],
	);
	const visibleNodes = useCallback(() => layout.nodes.filter((node) => visibleRef.current.has(node.path)), [layout]);

	const draw = useCallback(() => {
		const { width, height } = session.size;
		if (!width || !height) return;
		const shown = visibleNodes();
		if (!session.initialized && shown.length) {
			for (let i = 0; i < (layout.nodes.length > 400 ? 24 : 60); i++) layout.step();
			session.view = fitGraph(shown, session.size);
			session.initialized = true;
		}
		if (shown.length) session.view = constrainGraphView(session.view, shown, session.size);
		const current = session.view;
		const highlighted = hover.current ?? selectedRef.current;
		labels.current = graphLabels(shown, current, session.size, highlighted, {
			selected: selectedRef.current,
			related: graphScope(neighborsRef.current, highlighted, 1),
			previous: labels.current,
			moving: Boolean(
				gesture.current || transition.current || layout.simulation.alpha() >= layout.simulation.alphaMin(),
			),
		});
		canvas.current?.setAttribute("viewBox", `0 0 ${width} ${height}`);
		viewport.current?.setAttribute("transform", `translate(${current.x} ${current.y}) scale(${current.zoom})`);
		for (const node of shown) {
			const element = nodes.current.get(node.path);
			if (!element) continue;
			element.setAttribute("transform", `translate(${node.x} ${node.y})`);
			const radius = nodeRadius(node.degree, layout.nodes.length > 300);
			element.querySelector(".knowledge-node-dot")?.setAttribute("r", String(radius / current.zoom));
			element.querySelector(".knowledge-node-hit")?.setAttribute("r", String(14 / current.zoom));
			const label = element.querySelector("text");
			if (label) {
				const position = labels.current.get(node.path);
				label.setAttribute("opacity", String(position?.opacity ?? (position ? 1 : 0)));
				if (position) {
					label.textContent = position.text;
					label.setAttribute("x", String(position.x));
					label.setAttribute("y", String(position.y));
					label.setAttribute("font-size", String(12 / current.zoom));
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
	}, [layout, session, visibleNodes]);

	const pause = useCallback(() => {
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = null;
	}, []);
	const animate = useCallback(() => {
		if (
			frame.current !== null ||
			!enabled.current ||
			!layout.nodes.length ||
			!session.size.width ||
			!session.size.height ||
			document.visibilityState === "hidden"
		)
			return;
		if (
			!transition.current &&
			layout.simulation.alpha() < layout.simulation.alphaMin() &&
			!layout.simulation.alphaTarget()
		)
			return;
		let painted = 0;
		const tick = (time: number) => {
			frame.current = null;
			if (!enabled.current || document.visibilityState === "hidden") return;
			let moving =
				layout.simulation.alpha() >= layout.simulation.alphaMin() || Boolean(layout.simulation.alphaTarget());
			if (time - painted >= (layout.nodes.length > 400 ? 32 : 16)) {
				if (moving) moving = layout.step();
				const camera = transition.current;
				if (camera) {
					camera.start ??= time;
					const progress = reduced() ? 1 : Math.min(1, (time - camera.start) / 160);
					const eased = 1 - (1 - progress) ** 3;
					session.view = {
						x: camera.from.x + (camera.to.x - camera.from.x) * eased,
						y: camera.from.y + (camera.to.y - camera.from.y) * eased,
						zoom: camera.from.zoom + (camera.to.zoom - camera.from.zoom) * eased,
					};
					if (progress === 1) transition.current = null;
				}
				draw();
				painted = time;
			}
			if (moving || transition.current) frame.current = requestAnimationFrame(tick);
		};
		frame.current = requestAnimationFrame(tick);
	}, [draw, layout, reduced, session]);
	const finishGesture = useCallback(
		(cancelled = false) => {
			const current = gesture.current;
			if (!current) return;
			gesture.current = null;
			suppressClick.current = current.moved || cancelled;
			if (current.path) layout.release(current.path);
			if (current.target.hasPointerCapture?.(current.pointerId))
				current.target.releasePointerCapture(current.pointerId);
			canvas.current?.removeAttribute("data-dragging");
			animate();
		},
		[animate, layout],
	);
	const moveCamera = useCallback(
		(next: GraphView, smooth = true) => {
			const shown = visibleNodes();
			if (!shown.length) return;
			const to = constrainGraphView(next, shown, session.size);
			transition.current = null;
			if (smooth && !reduced() && enabled.current) {
				transition.current = { from: { ...session.view }, to, start: null };
				animate();
			} else {
				session.view = to;
				draw();
			}
		},
		[animate, draw, reduced, session, visibleNodes],
	);

	useLayoutEffect(() => {
		enabled.current = active;
		layout.update(graph);
		draw();
		if (active) animate();
		else {
			finishGesture(true);
			pause();
		}
	}, [active, animate, draw, finishGesture, graph, layout, pause]);
	useLayoutEffect(() => {
		const element = stage.current;
		if (!element) return;
		const measure = () => {
			const rect = element.getBoundingClientRect();
			const previous = session.size;
			const next = { width: rect.width, height: rect.height };
			if (!next.width || !next.height) {
				finishGesture(true);
				pause();
				return;
			}
			transition.current = null;
			if (session.initialized && previous.width && previous.height) {
				session.view = {
					...session.view,
					x: session.view.x + (next.width - previous.width) / 2,
					y: session.view.y + (next.height - previous.height) / 2,
				};
			}
			session.size = next;
			draw();
			animate();
		};
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		measure();
		return () => observer.disconnect();
	}, [animate, draw, finishGesture, pause, session]);
	useEffect(() => {
		const blur = () => finishGesture(true);
		const exit = (event: PointerEvent) => {
			if (!event.relatedTarget) finishGesture(true);
		};
		const visibility = () => {
			if (document.visibilityState === "hidden") {
				finishGesture(true);
				pause();
			} else animate();
		};
		window.addEventListener("blur", blur);
		window.addEventListener("pointerout", exit);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			window.removeEventListener("blur", blur);
			window.removeEventListener("pointerout", exit);
			document.removeEventListener("visibilitychange", visibility);
			finishGesture(true);
			pause();
			layout.stop();
		};
	}, [animate, finishGesture, layout, pause]);
	useLayoutEffect(draw);
	const screenPoint = useCallback(
		(clientX: number, clientY: number) => {
			const rect = canvas.current!.getBoundingClientRect();
			return {
				x: ((clientX - rect.left) * session.size.width) / (rect.width || session.size.width),
				y: ((clientY - rect.top) * session.size.height) / (rect.height || session.size.height),
			};
		},
		[session],
	);
	const zoomAt = useCallback(
		(factor: number, point: { x: number; y: number }, smooth = false) => {
			moveCamera(zoomGraph(session.view, factor, point, graphZoomLimits(visibleNodes(), session.size)), smooth);
		},
		[moveCamera, session, visibleNodes],
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
		if (gesture.current?.pointerId === event.pointerId) finishGesture(event.type !== "pointerup");
	};
	return {
		stage,
		canvas,
		viewport,
		nodes,
		edges,
		highlighted: hovered ?? selected,
		highlight: (path: string | null) => {
			hover.current = path;
			setHovered(path);
			draw();
		},
		fit: () => moveCamera(fitGraph(visibleNodes(), session.size)),
		pan: (x: number, y: number) => moveCamera({ ...session.view, x: session.view.x + x, y: session.view.y + y }),
		locate: (paths: ReadonlySet<string>) => {
			const matches = layout.nodes.filter((node) => paths.has(node.path) && visibleRef.current.has(node.path));
			if (matches.length) moveCamera(fitGraph(matches, session.size));
		},
		reflow: () => {
			finishGesture(true);
			layout.reflow();
			for (let i = 0; i < (layout.nodes.length > 400 ? 24 : 60); i++) layout.step();
			moveCamera(fitGraph(visibleNodes(), session.size));
			animate();
		},
		zoom: (factor: number) => zoomAt(factor, { x: session.size.width / 2, y: session.size.height / 2 }, true),
		allowClick: () => !suppressClick.current,
		onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => {
			if (event.button !== 0 || gesture.current || !session.size.width || !session.size.height) return;
			const target = (event.target as Element).closest<SVGGElement>("[data-knowledge-path]");
			const path = target?.getAttribute("data-knowledge-path") ?? null;
			const point = screenPoint(event.clientX, event.clientY);
			const node = path ? layout.byPath.get(path) : undefined;
			if (path && !node) return;
			transition.current = null;
			suppressClick.current = false;
			gesture.current = {
				pointerId: event.pointerId,
				path,
				target: target ?? event.currentTarget,
				startX: point.x,
				startY: point.y,
				lastX: point.x,
				lastY: point.y,
				offsetX: node ? node.x * session.view.zoom + session.view.x - point.x : 0,
				offsetY: node ? node.y * session.view.zoom + session.view.y - point.y : 0,
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
			if (current.moved) canvas.current?.setAttribute("data-dragging", current.path ? "node" : "pan");
			if (current.path) {
				const position = graphPoint(
					session.view,
					clampGraphDrag({ x: point.x + current.offsetX, y: point.y + current.offsetY }, session.size),
				);
				layout.pin(current.path, position.x, position.y);
				animate();
			} else
				session.view = constrainGraphView(
					{
						...session.view,
						x: session.view.x + point.x - current.lastX,
						y: session.view.y + point.y - current.lastY,
					},
					visibleNodes(),
					session.size,
				);
			current.lastX = point.x;
			current.lastY = point.y;
			draw();
		},
		onPointerUp: endGesture,
		onPointerCancel: endGesture,
		onLostPointerCapture: endGesture,
	};
}
