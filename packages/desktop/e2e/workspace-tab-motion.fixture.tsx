import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { WorkspaceTabMotion } from "../src/renderer/components/WorkspaceTabMotion.tsx";
import { tabStripLayout } from "../src/renderer/workspace-tab-motion.ts";
import { applyWorkspaceTabSizing, useWorkspaceTabSizing } from "../src/renderer/workspace-tab-sizing.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";
import "../src/renderer/styles/workspace-tab-sizing.css";

const params = new URLSearchParams(location.search);
const split = params.get("split") === "1";
const responsive = params.has("responsive");
const unstableRef = params.has("unstableRef");
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.platform = "darwin";
if (params.get("motion") === "system") delete document.documentElement.dataset.motion;
else document.documentElement.dataset.motion = params.get("motion") === "reduced" ? "reduced" : "full";

type Side = "left" | "right";

interface TabState {
	readonly id: string;
}

interface FixtureApi {
	reset(): void;
	setLeft(ids: readonly string[]): void;
	setRight(ids: readonly string[]): void;
	add(side: Side, id: string, index?: number): void;
	remove(side: Side, id: string): void;
	setMany(side: Side, count: number): void;
	setSuspended(suspended: boolean): void;
	setMotion(motion: "full" | "reduced" | "system"): void;
	setWidth(side: Side, width: number): void;
}

declare global {
	interface Window {
		__tabFixture?: FixtureApi;
	}
}

function ids(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

const initialLeft = ["tab-a", "tab-b", "tab-c"];
const initialRight = ["tab-x", "tab-y"];

function label(id: string): string {
	return id.replace("tab-", "").replace("many-", "M").toUpperCase();
}

function Tab({
	tab,
	active,
	onSelect,
	onClose,
}: {
	readonly tab: TabState;
	readonly active: boolean;
	readonly onSelect: () => void;
	readonly onClose: () => void;
}) {
	return (
		<div className={`tool-tab${active ? " is-active" : ""}`} data-tab-motion-key={tab.id} key={tab.id}>
			<button
				aria-selected={active}
				className="tool-tab-select"
				data-tab-id={tab.id}
				onClick={onSelect}
				role="tab"
				tabIndex={active ? 0 : -1}
				type="button"
			>
				<span aria-hidden="true" className="fixture-tab-glyph" />
				<span>{label(tab.id)}</span>
			</button>
			<button aria-label={`Close ${label(tab.id)}`} className="tool-tab-close" onClick={onClose} type="button">
				<span aria-hidden="true">×</span>
			</button>
		</div>
	);
}

function Strip({
	side,
	tabs,
	activeId,
	suspended,
	width,
	onSelect,
	onClose,
	children,
}: {
	readonly side: Side;
	readonly tabs: readonly TabState[];
	readonly activeId: string;
	readonly suspended: boolean;
	readonly width: number;
	readonly onSelect: (id: string) => void;
	readonly onClose: (id: string) => void;
	readonly children?: ReactNode;
}) {
	const host = useRef<HTMLDivElement>(null);
	const registerSizing = useWorkspaceTabSizing();
	const setHost = useCallback(
		(element: HTMLDivElement | null) => {
			const previous = host.current;
			host.current = element;
			if (responsive) registerSizing(element, previous);
		},
		[registerSizing],
	);
	const [indicator, setIndicator] = useState({ left: 0, width: 0 });
	const measureIndicator = useCallback(() => {
		const id = tabs.find((tab) => tab.id === activeId)?.id;
		const active = id ? host.current?.querySelector<HTMLElement>(`[data-tab-motion-key="${id}"]`) : null;
		const next = active ? tabStripLayout(active, host.current) : { left: 0, width: 0 };
		setIndicator((previous) =>
			previous.left === next.left && previous.width === next.width
				? previous
				: { left: next.left, width: next.width },
		);
	}, [activeId, tabs]);
	useLayoutEffect(() => measureIndicator(), [measureIndicator]);

	return (
		<div className="workspace-tabbar" data-pane-id={side} data-strip={side} style={{ width }}>
			<div
				className="tool-tabs-scroll"
				data-strip-scroll={side}
				data-ref-lifecycle={unstableRef ? "unstable" : "stable"}
				ref={unstableRef ? (element) => setHost(element) : setHost}
			>
				<WorkspaceTabMotion
					layoutKey={tabs.map((tab) => tab.id).join("\0")}
					onSettled={measureIndicator}
					prepareLayout={responsive ? applyWorkspaceTabSizing : undefined}
					scope={`fixture:${side}`}
					suspended={suspended}
				>
					{tabs.map((tab) => (
						<Tab
							active={tab.id === activeId}
							key={tab.id}
							onClose={() => onClose(tab.id)}
							onSelect={() => onSelect(tab.id)}
							tab={tab}
						/>
					))}
				</WorkspaceTabMotion>
				<div
					aria-hidden="true"
					className={`tool-tab-indicator${indicator.width > 0 ? " is-set" : ""}`}
					style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
				/>
			</div>
			<div className="workspace-tabbar-fill" />
			{children}
		</div>
	);
}

function removeAt(tabs: TabState[], activeId: string, id: string) {
	const index = tabs.findIndex((tab) => tab.id === id);
	if (index < 0) return { tabs, activeId };
	const remaining = tabs.filter((tab) => tab.id !== id);
	return {
		tabs: remaining,
		activeId: activeId === id ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? "") : activeId,
	};
}

function insertAt(tabs: TabState[], tab: TabState, index: number) {
	const at = Math.max(0, Math.min(index, tabs.length));
	return [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

function Fixture() {
	const [left, setLeft] = useState<TabState[]>(initialLeft.map((id) => ({ id })));
	const [right, setRight] = useState<TabState[]>(initialRight.map((id) => ({ id })));
	const [leftActive, setLeftActive] = useState("tab-b");
	const [rightActive, setRightActive] = useState("tab-x");
	const [suspended, setSuspended] = useState(false);
	const [widths, setWidths] = useState({ left: split ? 520 : 760, right: split ? 520 : 760 });
	// Actions are installed once and read the latest committed state, so a rapid
	// Playwright sequence never operates on a stale closure.
	const latest = useRef({ left, right, leftActive, rightActive });
	latest.current = { left, right, leftActive, rightActive };

	useEffect(() => {
		const stateOf = (side: Side) =>
			side === "left"
				? {
						tabs: latest.current.left,
						activeId: latest.current.leftActive,
						setTabs: setLeft,
						setActive: setLeftActive,
					}
				: {
						tabs: latest.current.right,
						activeId: latest.current.rightActive,
						setTabs: setRight,
						setActive: setRightActive,
					};
		const api: FixtureApi = {
			reset: () =>
				flushSync(() => {
					setLeft(initialLeft.map((id) => ({ id })));
					setRight(initialRight.map((id) => ({ id })));
					setLeftActive("tab-b");
					setRightActive("tab-x");
					setSuspended(false);
				}),
			setLeft: (next) =>
				flushSync(() => {
					setLeft(next.map((id) => ({ id })));
					setLeftActive(next[0] ?? "");
				}),
			setRight: (next) =>
				flushSync(() => {
					setRight(next.map((id) => ({ id })));
					setRightActive(next[0] ?? "");
				}),
			add: (side, id, index) =>
				flushSync(() => {
					const state = stateOf(side);
					state.setTabs((current) => insertAt(current, { id }, index ?? current.length));
					state.setActive(id);
				}),
			remove: (side, id) =>
				flushSync(() => {
					const state = stateOf(side);
					const next = removeAt(state.tabs, state.activeId, id);
					state.setTabs(next.tabs);
					state.setActive(next.activeId);
				}),
			setMany: (side, count) =>
				flushSync(() => {
					const state = stateOf(side);
					const next = ids("many", count).map((id) => ({ id }));
					state.setTabs(next);
					state.setActive(next[Math.floor(count / 2)]?.id ?? "");
				}),
			setSuspended: (value) => flushSync(() => setSuspended(value)),
			setMotion: (motion) => {
				if (motion === "system") delete document.documentElement.dataset.motion;
				else document.documentElement.dataset.motion = motion;
			},
			setWidth: (side, width) => flushSync(() => setWidths((current) => ({ ...current, [side]: width }))),
		};
		window.__tabFixture = api;
		return () => {
			if (window.__tabFixture === api) delete window.__tabFixture;
		};
	}, []);

	return (
		<div className="app-shell" style={{ background: "var(--bg)", padding: 24, minHeight: "100vh" }}>
			<div style={{ display: "flex", gap: 16 }}>
				<Strip
					activeId={leftActive}
					onClose={(id) =>
						flushSync(() => {
							const next = removeAt(left, leftActive, id);
							setLeft(next.tabs);
							setLeftActive(next.activeId);
						})
					}
					onSelect={(id) => flushSync(() => setLeftActive(id))}
					side="left"
					suspended={suspended}
					tabs={left}
					width={widths.left}
				/>
				{split && (
					<Strip
						activeId={rightActive}
						onClose={(id) =>
							flushSync(() => {
								const next = removeAt(right, rightActive, id);
								setRight(next.tabs);
								setRightActive(next.activeId);
							})
						}
						onSelect={(id) => flushSync(() => setRightActive(id))}
						side="right"
						suspended={suspended}
						tabs={right}
						width={widths.right}
					/>
				)}
			</div>
			<p style={{ color: "var(--muted)", fontSize: 13, marginTop: 18 }}>
				仅渲染内存中的标签条，不加载用户文件、浏览器视图或打包应用。
			</p>
		</div>
	);
}

const root = document.querySelector("#root");
if (!root) throw new Error("Missing tab motion fixture root");
createRoot(root).render(<Fixture />);
