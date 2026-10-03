import type { ClientResult } from "@metis/app-protocol";
import { ArrowsOut, Minus, Plus } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { graphEdgeKey, useKnowledgeGraph } from "./use-knowledge-graph.ts";

type Graph = ClientResult<"knowledge/scan">;
export function KnowledgeGraph({
	graph,
	onOpen,
	active = true,
}: {
	readonly graph: Graph;
	readonly onOpen: (path: string) => void;
	readonly active?: boolean;
}) {
	const { t } = useTranslation();
	const interaction = useKnowledgeGraph(graph, active);
	const related = useMemo(() => {
		const paths = new Set<string>();
		if (interaction.highlighted) {
			paths.add(interaction.highlighted);
			for (const edge of graph.edges) {
				if (edge.source === interaction.highlighted) paths.add(edge.target);
				if (edge.target === interaction.highlighted) paths.add(edge.source);
			}
		}
		return paths;
	}, [graph.edges, interaction.highlighted]);
	return (
		<div className="knowledge-graph">
			<div className="knowledge-graph-controls">
				<button
					className="knowledge-icon-button"
					type="button"
					title={t("Zoom out")}
					aria-label={t("Zoom out")}
					onClick={() => interaction.zoom(0.8)}
				>
					<Minus aria-hidden="true" size={15} />
				</button>
				<button
					className="knowledge-icon-button"
					type="button"
					title={t("Zoom in")}
					aria-label={t("Zoom in")}
					onClick={() => interaction.zoom(1.25)}
				>
					<Plus aria-hidden="true" size={15} />
				</button>
				<button
					className="knowledge-icon-button"
					type="button"
					title={t("Fit graph to panel")}
					aria-label={t("Reset view")}
					onClick={interaction.fit}
				>
					<ArrowsOut aria-hidden="true" size={15} />
				</button>
				<span>{t("{{count}} links", { count: graph.edges.length })}</span>
			</div>
			<div className="knowledge-graph-stage" ref={interaction.stage}>
				{/* biome-ignore lint/a11y/useSemanticElements: The SVG graph cannot use an HTML fieldset. */}
				<svg
					aria-label={t("Knowledge graph")}
					aria-description={t("Drag nodes to rearrange, drag the background to pan, and scroll to zoom.")}
					className="knowledge-graph-canvas"
					ref={interaction.canvas}
					role="group"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: The graph supports keyboard zoom and fit.
					tabIndex={0}
					viewBox="0 0 1 1"
					onPointerDown={interaction.onPointerDown}
					onPointerMove={interaction.onPointerMove}
					onPointerUp={interaction.onPointerUp}
					onPointerCancel={interaction.onPointerCancel}
					onLostPointerCapture={interaction.onLostPointerCapture}
					onKeyDown={(event) => {
						if (event.target !== event.currentTarget) return;
						if (event.key === "+" || event.key === "=") {
							event.preventDefault();
							interaction.zoom(1.25);
						} else if (event.key === "-") {
							event.preventDefault();
							interaction.zoom(0.8);
						} else if (event.key === "0") {
							event.preventDefault();
							interaction.fit();
						}
					}}
				>
					<g className="knowledge-graph-viewport" ref={interaction.viewport}>
						{graph.edges.map((edge) => {
							const key = graphEdgeKey(edge.source, edge.target);
							const highlighted =
								edge.source === interaction.highlighted || edge.target === interaction.highlighted;
							return (
								<line
									className={`knowledge-edge${highlighted ? " is-highlighted" : interaction.highlighted ? " is-muted" : ""}`}
									key={key}
									ref={(element) => {
										if (element) interaction.edges.current.set(key, element);
										else interaction.edges.current.delete(key);
									}}
									vectorEffect="non-scaling-stroke"
								/>
							);
						})}
						{graph.notes.map((note) => (
							// biome-ignore lint/a11y/useSemanticElements: Native HTML buttons cannot be used inside the SVG graph.
							<g
								className={`knowledge-node${interaction.highlighted && !related.has(note.path) ? " is-muted" : ""}`}
								data-knowledge-path={note.path}
								key={note.path}
								ref={(element) => {
									if (element) interaction.nodes.current.set(note.path, element);
									else interaction.nodes.current.delete(note.path);
								}}
								role="button"
								tabIndex={0}
								aria-label={note.title}
								onClick={() => {
									if (interaction.allowOpen(note.path)) onOpen(note.path);
								}}
								onPointerEnter={() => interaction.highlight(note.path)}
								onPointerLeave={() => interaction.highlight(null)}
								onFocus={() => interaction.highlight(note.path)}
								onBlur={() => interaction.highlight(null)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										onOpen(note.path);
									}
								}}
							>
								<title>
									{note.title}
									{"\n"}
									{note.path}
								</title>
								<circle className="knowledge-node-hit" r={12} />
								<circle className="knowledge-node-dot" r={5} vectorEffect="non-scaling-stroke" />
								{(graph.notes.length <= 150 || interaction.highlighted === note.path) && (
									<text>{note.title}</text>
								)}
							</g>
						))}
					</g>
				</svg>
			</div>
		</div>
	);
}
