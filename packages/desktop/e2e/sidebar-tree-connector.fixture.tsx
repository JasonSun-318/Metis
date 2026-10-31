import type { AgentSummaryView } from "@metis/app-protocol";
import { createRoot } from "react-dom/client";
import { AgentSidebarBranch } from "../src/renderer/components/AgentSidebarBranch.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

// Connector fixture: three same-level subagents under one session plus one
// nested child on the first sibling. All agents are done/idle so no spinner
// animates over the tree lines under inspection.
const epoch = Date.parse("2026-10-24T12:00:00.000Z");
const stamp = (rank: number) => new Date(epoch + rank * 1000).toISOString();

function agent(agentId: string, name: string, rank: number, parentSessionId = "root"): AgentSummaryView {
	const nested = parentSessionId !== "root";
	return {
		agentId,
		name,
		parentSessionId,
		rootSessionId: "root",
		agentPath: nested ? [parentSessionId, agentId] : [agentId],
		depth: nested ? 2 : 1,
		agentType: "worker",
		status: "done",
		archived: false,
		tasks: [],
		createdAt: stamp(rank),
		updatedAt: stamp(100 + rank),
	};
}

function fixtureAgents(): readonly AgentSummaryView[] {
	const target = window as Window & { __connectorFixtureAgents?: AgentSummaryView[] };
	target.__connectorFixtureAgents ??= [
		agent("scan", "Desktop inventory scan", 1),
		agent("readonly", "Desktop read-only inventory", 2),
		agent("trash", "Trash read-only inventory", 3),
		agent("nested", "嵌套子任务", 4, "scan"),
	];
	return target.__connectorFixtureAgents;
}

const agentApi = {
	listAgents: async () => ({ agents: fixtureAgents(), nextAfterAgentId: null }),
	subscribe: (listener: (event: unknown) => void) => {
		const target = window as Window & { __connectorFixtureListeners?: Set<(event: unknown) => void> };
		target.__connectorFixtureListeners ??= new Set();
		target.__connectorFixtureListeners.add(listener);
		return () => target.__connectorFixtureListeners?.delete(listener);
	},
} as unknown as MetisDesktopApi;

function Fixture() {
	return (
		<div className="app-shell" style={{ "--sidebar-width": "302px" } as React.CSSProperties}>
			<aside className="session-sidebar" aria-label="Tasks">
				<nav aria-label="Code sessions" className="project-list" data-grouping="none">
					<AgentSidebarBranch
						sessionId="root"
						navigation={{ api: agentApi, active: null, onOpen: () => undefined }}
					>
						{(toggle) => (
							<div className="session-row">
								<button className="session-button" type="button">
									<span className="session-button-title">主会话</span>
								</button>
								{toggle}
							</div>
						)}
					</AgentSidebarBranch>
				</nav>
			</aside>
			<main className="workspace">
				<header className="workspace-titlebar">
					<span style={{ paddingLeft: 18 }}>树形连接线验收</span>
				</header>
			</main>
		</div>
	);
}

async function mount() {
	document.documentElement.dataset.theme = "dark";
	document.documentElement.dataset.platform = "darwin";
	await setLocale("zh-CN");
	const root = document.querySelector("#root");
	if (!root) throw new Error("Missing connector fixture root");
	createRoot(root).render(<Fixture />);
}
void mount();
