import type { ClientResult } from "@metis/app-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowsOut, DotsThree, Minus, Plus } from "../icons.tsx";
import {
	createGraphSession,
	type GraphSession,
	graphDirectoryColor,
	graphNeighbors,
	graphScope,
} from "./knowledge-graph-session.ts";
import { graphEdgeKey, useKnowledgeGraph } from "./use-knowledge-graph.ts";

type Graph = ClientResult<"knowledge/scan">;
export function KnowledgeGraph({
	graph,
	onOpen,
	active = true,
	session: suppliedSession,
	query = "",
}: {
	readonly graph: Graph;
	readonly onOpen: (path: string) => void;
	readonly active?: boolean;
	readonly session?: GraphSession;
	readonly query?: string;
}) {
	const { t } = useTranslation();
	const [localSession] = useState(createGraphSession);
	const session = suppliedSession ?? localSession;
	const [selected, setSelected] = useState(session.selected);
	const [scope, setScope] = useState(session.scope);
	const [grouped, setGrouped] = useState(session.grouped);
	const [matchingOnly, setMatchingOnly] = useState(session.matchingOnly);
	const root = useRef<HTMLDivElement>(null);
	const select = useCallback(
		(path: string | null) => {
			session.selected = path;
			setSelected(path);
			if (!path) {
				session.scope = "all";
				setScope("all");
			}
		},
		[session],
	);
	const neighbors = useMemo(() => graphNeighbors(graph), [graph]);
	const matches = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		return new Set(
			graph.notes
				.filter((note) => !needle || `${note.title} ${note.path}`.toLocaleLowerCase().includes(needle))
				.map((note) => note.path),
		);
	}, [graph, query]);
	const visible = useMemo(() => {
		const paths =
			scope === "all" || !selected
				? new Set(graph.notes.map((note) => note.path))
				: graphScope(neighbors, selected, Number(scope));
		return matchingOnly && query.trim() ? new Set([...paths].filter((path) => matches.has(path))) : paths;
	}, [graph, matches, matchingOnly, neighbors, query, scope, selected]);
	const matchCount = [...matches].filter((path) => visible.has(path)).length;
	const interaction = useKnowledgeGraph(graph, active, session, selected, visible);
	const currentInteraction = useRef(interaction);
	currentInteraction.current = interaction;
	const clearSelection = useCallback(() => {
		select(null);
		currentInteraction.current.highlight(null);
	}, [select]);
	useEffect(() => {
		if (!active || !root.current) return;
		const boundary = root.current.closest("[data-knowledge-explorer]") ?? root.current;
		const clearOutside = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Node) || boundary.contains(target)) return;
			// Knowledge controls can own menus rendered through a portal outside the panel.
			for (const control of boundary.querySelectorAll("[aria-controls]")) {
				const ids = control.getAttribute("aria-controls")?.split(/\s+/) ?? [];
				if (ids.some((id) => document.getElementById(id)?.contains(target))) return;
			}
			clearSelection();
		};
		document.addEventListener("pointerdown", clearOutside, true);
		document.addEventListener("focusin", clearOutside, true);
		return () => {
			document.removeEventListener("pointerdown", clearOutside, true);
			document.removeEventListener("focusin", clearOutside, true);
		};
	}, [active, clearSelection]);
	const highlighted = interaction.highlighted && visible.has(interaction.highlighted) ? interaction.highlighted : null;
	const related = useMemo(() => graphScope(neighbors, highlighted, 1), [neighbors, highlighted]);
	const note = graph.notes.find((item) => item.path === selected);
	useEffect(() => {
		if (session.selected && !graph.notes.some((item) => item.path === session.selected)) {
			session.selected = null;
			setSelected(null);
			session.scope = "all";
			setScope("all");
		}
	}, [graph, session]);
	useEffect(() => {
		if (!query.trim() || !active) return;
		const timer = window.setTimeout(() => currentInteraction.current.locate(matches), 180);
		return () => window.clearTimeout(timer);
	}, [active, matches, query]);
	const changeScope = (value: GraphSession["scope"]) => {
		session.scope = value;
		setScope(value);
		// Wait for the new visible projection to commit before fitting it.
	};
	const priorProjection = useRef({ scope, selected });
	useEffect(() => {
		if (priorProjection.current.scope !== scope || (scope !== "all" && priorProjection.current.selected !== selected))
			currentInteraction.current.fit();
		priorProjection.current = { scope, selected };
	}, [scope, selected]);
	return (
		<div className="knowledge-graph" ref={root}>
			<div className="knowledge-graph-explore">
				<select
					aria-label={t("Graph scope")}
					value={scope}
					onChange={(event) => changeScope(event.target.value as GraphSession["scope"])}
				>
					<option value="all">{t("All notes")}</option>
					<option value="1" disabled={!selected}>
						{t("One hop")}
					</option>
					<option value="2" disabled={!selected}>
						{t("Two hops")}
					</option>
				</select>
				{query.trim() && (
					<output className="knowledge-graph-match-count">{t("{{count}} matches", { count: matchCount })}</output>
				)}
				<details className="knowledge-graph-options">
					<summary aria-label={t("Graph options")} title={t("Graph options")}>
						<DotsThree size={20} aria-hidden="true" />
					</summary>
					<div>
						<label>
							<input
								type="checkbox"
								checked={grouped}
								onChange={(event) => {
									session.grouped = event.target.checked;
									setGrouped(event.target.checked);
								}}
							/>
							{t("Color by directory")}
						</label>
						<label>
							<input
								type="checkbox"
								checked={matchingOnly}
								onChange={(event) => {
									session.matchingOnly = event.target.checked;
									setMatchingOnly(event.target.checked);
								}}
							/>
							{t("Show matches only")}
						</label>
						<button type="button" onClick={interaction.reflow}>
							{t("Rearrange graph")}
						</button>
					</div>
				</details>
			</div>
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
					aria-description={t(
						"Select a note with one click. Double-click or press Enter to open. Drag to explore; scroll to zoom.",
					)}
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
					onClick={(event) => {
						if (
							event.target instanceof Element &&
							!event.target.closest("[data-knowledge-path]") &&
							interaction.allowClick()
						)
							clearSelection();
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							clearSelection();
							return;
						}
						if (event.target !== event.currentTarget) return;
						if (event.key.startsWith("Arrow")) {
							event.preventDefault();
							interaction.pan(
								event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0,
								event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0,
							);
						} else if (event.key === "+" || event.key === "=") {
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
						{graph.edges
							.filter((edge) => visible.has(edge.source) && visible.has(edge.target))
							.map((edge) => {
								const key = graphEdgeKey(edge.source, edge.target);
								const emphasized = edge.source === highlighted || edge.target === highlighted;
								return (
									<line
										className={`knowledge-edge${emphasized ? " is-highlighted" : highlighted ? " is-muted" : ""}`}
										key={key}
										ref={(element) => {
											if (element) interaction.edges.current.set(key, element);
											else interaction.edges.current.delete(key);
										}}
										vectorEffect="non-scaling-stroke"
									/>
								);
							})}
						{graph.notes
							.filter((item) => visible.has(item.path))
							.map((item) => (
								// biome-ignore lint/a11y/useSemanticElements: Native HTML buttons cannot be used inside the SVG graph.
								<g
									className={`knowledge-node${selected === item.path ? " is-selected" : ""}${highlighted === item.path ? " is-highlighted" : ""}${query.trim() && matches.has(item.path) ? " is-match" : ""}${highlighted && !related.has(item.path) ? " is-muted" : ""}`}
									data-knowledge-path={item.path}
									key={item.path}
									style={grouped ? { color: graphDirectoryColor(item.path) } : undefined}
									ref={(element) => {
										if (element) interaction.nodes.current.set(item.path, element);
										else interaction.nodes.current.delete(item.path);
									}}
									role="button"
									tabIndex={0}
									aria-label={item.title}
									aria-pressed={selected === item.path}
									onClick={() => {
										if (interaction.allowClick()) select(item.path);
									}}
									onDoubleClick={() => {
										if (interaction.allowClick()) onOpen(item.path);
									}}
									onPointerEnter={() => interaction.highlight(item.path)}
									onPointerLeave={() => interaction.highlight(null)}
									onFocus={() => interaction.highlight(item.path)}
									onBlur={() => interaction.highlight(null)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											onOpen(item.path);
										} else if (event.key === " ") {
											event.preventDefault();
											select(item.path);
										}
									}}
								>
									<title>{`${item.title}\n${item.path}`}</title>
									<circle className="knowledge-node-hit" r={14} />
									<circle className="knowledge-node-dot" r={5} vectorEffect="non-scaling-stroke" />
									<text vectorEffect="non-scaling-stroke">{item.title}</text>
								</g>
							))}
					</g>
				</svg>
				{query.trim() && !matchCount && (
					<output className="knowledge-graph-notice">{t("No matching notes")}</output>
				)}
			</div>
			{note ? (
				<div className="knowledge-graph-selection">
					<div>
						<strong>{note.title}</strong>
						<span title={note.path}>{note.path}</span>
					</div>
					<button type="button" onClick={() => onOpen(note.path)}>
						{t("Open note")}
					</button>
				</div>
			) : (
				<p className="knowledge-graph-hint">{t("Click to select · Double-click to open")}</p>
			)}
		</div>
	);
}
