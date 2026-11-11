import type { AgentSummaryView, SessionSummary } from "@metis/app-protocol";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentSidebarBranch } from "../src/renderer/components/AgentSidebarBranch.tsx";
import { SessionActions } from "../src/renderer/components/SessionActions.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

const params = new URLSearchParams(location.search);
const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const GRANDCHILD = "33333333-3333-4333-8333-333333333333";
const SIBLING = "44444444-4444-4444-8444-444444444444";
const date = "2026-11-05T00:00:00Z";
function agent(agentId: string, name: string, parentSessionId = ROOT): AgentSummaryView {
	return {
		agentId,
		name,
		parentSessionId,
		rootSessionId: ROOT,
		agentPath: parentSessionId === ROOT ? [agentId] : [parentSessionId, agentId],
		depth: parentSessionId === ROOT ? 1 : 2,
		agentType: "worker",
		status: "done",
		archived: false,
		tasks: [],
		createdAt: date,
		updatedAt: date,
	};
}
let agents = [agent(CHILD, "资料研究"), agent(GRANDCHILD, "整理引用", CHILD), agent(SIBLING, "撰写总结")];
if (params.has("running")) agents[1] = { ...agents[1]!, status: "running" };
const listeners = new Set<(event: DesktopApiEvent) => void>();
function emit(events: unknown[]) {
	for (const listener of listeners)
		listener({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: { serverEpoch: "epoch", fromCursor: 1, toCursor: 1, events },
			},
		} as DesktopApiEvent);
}
const api = {
	listAgents: async () => ({
		agents: agents.filter(
			(value) => !value.agentPath.some((id) => agents.find((parent) => parent.agentId === id)?.archived),
		),
		nextAfterAgentId: null,
	}),
	subscribe: (listener: (event: DesktopApiEvent) => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	renameAgent: async ({ agentId, name }: { agentId: string; name: string }) => {
		const next = { ...agents.find((value) => value.agentId === agentId)!, name, updatedAt: new Date().toISOString() };
		agents = agents.map((value) => (value.agentId === agentId ? next : value));
		emit([{ type: "agent/updated", sessionId: ROOT, agent: next }]);
		return { agent: next };
	},
	archiveAgent: async ({ agentId }: { agentId: string }) => {
		if (params.has("error")) throw new Error("归档失败，请重试");
		const next = {
			...agents.find((value) => value.agentId === agentId)!,
			archived: true,
			updatedAt: new Date().toISOString(),
		};
		agents = agents.map((value) => (value.agentId === agentId ? next : value));
		emit([{ type: "agent/updated", sessionId: ROOT, agent: next }]);
		return { agent: next };
	},
	deleteAgent: async ({ agentId }: { agentId: string }) => {
		const deletedAgentIds = agents.filter((value) => value.agentPath.includes(agentId)).map((value) => value.agentId);
		agents = agents.filter((value) => !deletedAgentIds.includes(value.agentId));
		emit([{ type: "agent/deleted", sessionId: ROOT, deletedAgentIds }]);
		return { agentId, status: "deleted", deletedAgentIds };
	},
} as unknown as MetisDesktopApi;
const session: SessionSummary = {
	sessionId: ROOT,
	name: "季度研究报告",
	cwdOrigin: "managed",
	unread: false,
	useMemory: true,
	contributeMemory: true,
	cwd: "/tmp/project",
	state: "idle",
	archived: false,
	createdAt: date,
	updatedAt: date,
};
function Fixture() {
	const [active, setActive] = useState<{ sessionId: string; agentId: string; name: string } | null>(null);
	const [removed, setRemoved] = useState("");
	const [rootArchived, setRootArchived] = useState(false);
	return (
		<div
			className="app-shell"
			style={{ "--sidebar-width": params.has("narrow") ? "250px" : "302px" } as React.CSSProperties}
		>
			<aside className="session-sidebar" aria-label="Tasks">
				<header style={{ padding: "26px 16px 18px", fontSize: 14 }}>Metis</header>
				<nav className="project-list" data-grouping="none">
					{rootArchived ? (
						<p style={{ padding: 12 }}>会话已归档</p>
					) : (
						<AgentSidebarBranch
							sessionId={ROOT}
							navigation={{
								api,
								active,
								onOpen: setActive,
								onRemoved: (_root, ids) => {
									setRemoved(ids.join(","));
									if (active && ids.includes(active.agentId)) setActive(null);
								},
								onRenamed: (_root, id, name) => {
									if (active?.agentId === id) setActive({ ...active, name });
								},
							}}
						>
							{(toggle) => (
								<div className="session-row">
									<button className="session-button" type="button">
										<span className="session-button-title">季度研究报告</span>
									</button>
									<SessionActions
										session={session}
										displayName={session.name!}
										disabled={false}
										archiveDisabled={params.has("running")}
										deleteDisabled={false}
										onArchive={async () => setRootArchived(true)}
										onRename={async () => undefined}
										onDelete={async () => undefined}
									/>
									{toggle}
								</div>
							)}
						</AgentSidebarBranch>
					)}
				</nav>
			</aside>
			<main className="workspace">
				<header className="workspace-titlebar">
					<span style={{ paddingLeft: 18 }}>会话树 · {active?.name ?? "主会话"}</span>
				</header>
				<output data-removed={removed} style={{ padding: 24, fontSize: 13 }}>
					点击左侧会话的操作菜单
				</output>
			</main>
		</div>
	);
}
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.platform = "darwin";
void setLocale("zh-CN").then(() => createRoot(document.getElementById("root")!).render(<Fixture />));
