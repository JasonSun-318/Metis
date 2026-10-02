import type { ClientResult } from "@metis/app-protocol";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type Graph = ClientResult<"knowledge/scan">;
export function KnowledgeGraph({ graph, onOpen }: { readonly graph: Graph; readonly onOpen: (path: string) => void }) {
	const { t } = useTranslation();
	const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
	const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
	const points = useMemo(() => {
		const total = graph.notes.length;
		const extent = Math.max(360, Math.sqrt(total) * 55);
		return {
			extent,
			byPath: new Map(
				graph.notes.map((note, index) => {
					const angle = index * Math.PI * (3 - Math.sqrt(5));
					const radius = total <= 1 ? 0 : Math.sqrt(index / (total - 1)) * extent * 0.36;
					return [
						note.path,
						{ x: extent / 2 + Math.cos(angle) * radius, y: extent / 2 + Math.sin(angle) * radius },
					];
				}),
			),
		};
	}, [graph.notes]);
	const zoom = (factor: number) =>
		setView((current) => ({ ...current, zoom: Math.max(0.25, Math.min(6, current.zoom * factor)) }));
	return (
		<div className="knowledge-graph">
			<div className="knowledge-graph-controls">
				<button type="button" aria-label={t("Zoom out")} onClick={() => zoom(0.8)}>
					−
				</button>
				<button type="button" aria-label={t("Zoom in")} onClick={() => zoom(1.25)}>
					+
				</button>
				<button type="button" onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>
					{t("Reset view")}
				</button>
				<span>
					{t("{{count}} notes", { count: graph.notes.length })} ·{" "}
					{t("{{count}} links", { count: graph.edges.length })}
				</span>
			</div>
			<svg
				aria-label={t("Knowledge graph")}
				className="knowledge-graph-canvas"
				role="group"
				viewBox={`0 0 ${points.extent} ${points.extent}`}
				onWheel={(event) => zoom(event.deltaY > 0 ? 0.9 : 1.1)}
				onPointerDown={(event) => {
					if ((event.target as Element).closest(".knowledge-node")) return;
					drag.current = { x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
					event.currentTarget.setPointerCapture?.(event.pointerId);
				}}
				onPointerMove={(event) => {
					if (!drag.current) return;
					const bounds = event.currentTarget.getBoundingClientRect();
					const scale = points.extent / Math.max(1, Math.min(bounds.width, bounds.height));
					setView((current) => ({
						...current,
						x: drag.current!.originX + (event.clientX - drag.current!.x) * scale,
						y: drag.current!.originY + (event.clientY - drag.current!.y) * scale,
					}));
				}}
				onPointerUp={() => {
					drag.current = null;
				}}
				onPointerCancel={() => {
					drag.current = null;
				}}
			>
				<g
					transform={`translate(${view.x + points.extent / 2} ${view.y + points.extent / 2}) scale(${view.zoom}) translate(${-points.extent / 2} ${-points.extent / 2})`}
				>
					{graph.edges.map((edge) => {
						const source = points.byPath.get(edge.source);
						const target = points.byPath.get(edge.target);
						return source && target ? (
							<line
								className="knowledge-edge"
								key={`${edge.source}\0${edge.target}`}
								x1={source.x}
								y1={source.y}
								x2={target.x}
								y2={target.y}
							/>
						) : null;
					})}
					{graph.notes.map((note) => {
						const point = points.byPath.get(note.path)!;
						return (
							<g
								className="knowledge-node"
								key={note.path}
								transform={`translate(${point.x} ${point.y})`}
								role="button"
								tabIndex={0}
								aria-label={note.title}
								onClick={() => onOpen(note.path)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										onOpen(note.path);
									}
								}}
							>
								<title>{note.path}</title>
								<circle r={graph.notes.length > 300 ? 3 : 5} />
								{graph.notes.length <= 150 && (
									<text
										x={point.x > points.extent / 2 ? -9 : 9}
										y={4}
										textAnchor={point.x > points.extent / 2 ? "end" : "start"}
									>
										{note.title.length > 24 ? `${note.title.slice(0, 24)}…` : note.title}
									</text>
								)}
							</g>
						);
					})}
				</g>
			</svg>
		</div>
	);
}
