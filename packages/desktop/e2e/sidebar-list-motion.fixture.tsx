import type { AgentSummaryView, SessionSummary } from "@metis/app-protocol";
import { type ComponentProps, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionSidebar } from "../src/renderer/components/SessionSidebar.tsx";
import type { AgentConversationTarget } from "../src/renderer/conversation-target.ts";
import { setLocale } from "../src/renderer/i18n.ts";
import type { SessionGroupBy } from "../src/renderer/store/session-grouping.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";
import "../src/renderer/styles/agent-conversations.css";
import "../src/renderer/styles/knowledge.css";

type SidebarProps = ComponentProps<typeof SessionSidebar>;
const params = new URLSearchParams(location.search);
const withAgents = params.get("agents") === "1";
const groupings: readonly SessionGroupBy[] = ["unread", "project", "none", "date", "status"];
const initialGrouping = groupings.find((value) => value === params.get("grouping")) ?? "unread";
const epoch = Date.parse("2026-10-24T12:00:00.000Z");
const stamp = (rank: number) => new Date(epoch + rank * 1000).toISOString();

document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.platform = "darwin";
if (params.get("motion") === "system") delete document.documentElement.dataset.motion;
else document.documentElement.dataset.motion = params.get("motion") === "reduced" ? "reduced" : "full";

function session(id: string, name: string, rank: number, project?: string, unread = false): SessionSummary {
	return {
		sessionId: id,
		mode: "chat",
		cwdOrigin: project ? "user-selected" : "managed",
		cwd: project ? `/fixture/${project}` : `/fixture/tasks/${id}`,
		name,
		createdAt: stamp(0),
		updatedAt: stamp(rank),
		state: "idle",
		archived: false,
		unread,
		useMemory: true,
		contributeMemory: true,
	};
}

function initialSessions(): SessionSummary[] {
	const items = [
		session("a1", "Alpha · 未读一", 100, "Alpha", true),
		session("a2", "Alpha · 未读二", 90, "Alpha", true),
		session("b1", "Beta · 会话一", 80, "Beta"),
		session("b2", "Beta · 会话二", 70, "Beta"),
		...Array.from({ length: 24 }, (_, index) => session(`history-${index}`, `历史任务 ${index + 1}`, 60 - index)),
	];
	if (initialGrouping !== "status") return items;
	return items.map((item): SessionSummary => {
		if (item.sessionId === "a1") return { ...item, attentionRequired: true };
		if (item.sessionId === "a2") return { ...item, state: "running" };
		if (item.sessionId === "b1") return { ...item, lastTurnOutcome: "failed" };
		if (item.sessionId === "b2") return { ...item, lastTurnOutcome: "completed" };
		return item;
	});
}

function agent(agentId: string, name: string, parentSessionId = "a1"): AgentSummaryView {
	return {
		agentId,
		name,
		parentSessionId,
		rootSessionId: "a1",
		agentPath: parentSessionId === "a1" ? [agentId] : [parentSessionId, agentId],
		depth: parentSessionId === "a1" ? 1 : 2,
		agentType: "worker",
		status: "done",
		archived: false,
		tasks: [],
		createdAt: stamp(agentId === "worker" ? 0 : agentId === "grandchild" ? 1 : 2),
		updatedAt: stamp(10),
	};
}

const baseAgents = [
	agent("worker", "资料整理"),
	agent("grandchild", "引用核对", "worker"),
	agent("sibling", "目录检查"),
];
const initialAgents = params.get("initialAgents") === "empty" ? [] : baseAgents;
const agentApi = {
	listAgents: async ({ sessionId }: { sessionId: string }) => ({
		agents:
			sessionId === "a1"
				? ((window as Window & { __sidebarFixtureAgents?: typeof baseAgents }).__sidebarFixtureAgents ??
					initialAgents)
				: [],
		nextAfterAgentId: null,
	}),
	subscribe: (listener: (event: unknown) => void) => {
		const target = window as Window & { __sidebarFixtureListeners?: Set<(event: unknown) => void> };
		target.__sidebarFixtureListeners ??= new Set();
		target.__sidebarFixtureListeners.add(listener);
		return () => target.__sidebarFixtureListeners?.delete(listener);
	},
} as unknown as MetisDesktopApi;

function Fixture() {
	const [sessions, setSessions] = useState(initialSessions);
	const [selected, setSelected] = useState<string | null>(null);
	const [activeAgent, setActiveAgent] = useState<AgentConversationTarget | null>(null);
	const [grouping, setGrouping] = useState(initialGrouping);
	const [generation, setGeneration] = useState(0);
	const [contentRevision, setContentRevision] = useState(0);
	const [motion, setMotion] = useState(document.documentElement.dataset.motion);
	const tick = useRef(200);
	const state = useMemo<SidebarProps["state"]>(
		() => ({
			sessionsById: new Map(sessions.map((item) => [item.sessionId, item])),
			sessionOrder: sessions.map((item) => item.sessionId),
			activeSessionId: selected,
			activeTurnId: null,
			interactionsById: new Map(),
			interactionOrder: [],
		}),
		[sessions, selected],
	);
	const workspace: SidebarProps["workspace"] = {
		busy: false,
		mode: "chat",
		newTaskOpen: false,
		onModeChange: () => undefined,
		onNewTask: () => undefined,
		onOpen: async (id) => {
			setActiveAgent(null);
			setSelected(id);
			setSessions((current) => current.map((item) => (item.sessionId === id ? { ...item, unread: false } : item)));
		},
		onDeleteSession: async (item) =>
			setSessions((current) => current.filter((entry) => entry.sessionId !== item.sessionId)),
		onPinSession: () => undefined,
		onRenameSession: async (item, name) =>
			setSessions((current) =>
				current.map((entry) => (entry.sessionId === item.sessionId ? { ...entry, name } : entry)),
			),
		onCopySessionTitle: async () => undefined,
		onCreateProjectSession: async () => undefined,
		onDeleteProject: async () => undefined,
		onPinProject: () => undefined,
		onPreviewProjectDelete: async () => {
			throw new Error("Project deletion is outside this motion fixture.");
		},
		onRenameProject: () => undefined,
		projectBusy: () => false,
		preferences: new Map(),
		pinnedSessionIds: new Set(),
	};
	const updateRun = (id: string, running: boolean) => {
		const updatedAt = stamp(++tick.current);
		setSessions((current) =>
			current.map((item) =>
				item.sessionId === id
					? {
							...item,
							updatedAt,
							state: running ? "running" : "idle",
							unread: !running,
							attentionRequired: false,
							...(!running ? { lastTurnOutcome: "completed" as const } : {}),
						}
					: item,
			),
		);
	};
	const chooseGrouping = (value: SessionGroupBy) => {
		localStorage.setItem("metis.session-grouping.v1", JSON.stringify({ chat: value, code: value }));
		setGrouping(value);
	};
	return (
		<div className="app-shell" style={{ "--sidebar-width": "302px" } as React.CSSProperties}>
			<SessionSidebar
				key={`${generation}:${grouping}`}
				state={state}
				agentNavigation={withAgents ? { api: agentApi, active: activeAgent, onOpen: setActiveAgent } : undefined}
				destination="tasks"
				onSettings={() => undefined}
				onUpdate={() => undefined}
				onSkills={() => undefined}
				onSchedules={() => undefined}
				onOpenSchedule={() => undefined}
				onDeleteSchedule={async () => {
					throw new Error("There are no schedules in this motion fixture.");
				}}
				onWidthChange={() => undefined}
				scheduleTasks={[]}
				selectedScheduleTaskId={null}
				updateState={{ status: "unavailable" }}
				width={302}
				workspace={workspace}
			/>
			<main className="workspace">
				<header className="workspace-titlebar">
					<span style={{ paddingLeft: 18 }}>会话列表动效验收</span>
					{withAgents && (
						<div className="workspace-titlebar-tools is-open" style={{ width: 280 }}>
							<div className="workspace-titlebar-tools-slot" style={{ width: 280, alignItems: "center" }}>
								<span style={{ paddingLeft: 14 }}>知识库</span>
							</div>
						</div>
					)}
				</header>
				<div
					className={`motion-fixture-controls${withAgents ? " conversation-column" : ""}`}
					style={withAgents ? { marginRight: 280 } : undefined}
				>
					<h1>会话与项目连续重排</h1>
					<p>所有操作仅改变内存中的测试会话，不会调用模型或读取本地项目。</p>
					<label>
						测试分组
						<select
							aria-label="测试分组"
							value={grouping}
							onChange={(event) => chooseGrouping(event.target.value as SessionGroupBy)}
						>
							<option value="unread">未读／已读</option>
							<option value="project">项目</option>
							<option value="none">不分组</option>
							<option value="date">日期</option>
							<option value="status">状态</option>
						</select>
					</label>
					<div className="motion-fixture-actions">
						<button
							type="button"
							data-testid="content-update"
							onClick={() => {
								setContentRevision((current) => current + 1);
								setSessions((current) =>
									current.map((item, index) =>
										index === 0
											? {
													...item,
													name: `${(item.name ?? "").split(" · content ")[0]} · content ${contentRevision + 1}`,
												}
											: item,
									),
								);
							}}
						>
							仅更新内容
						</button>
						<button
							type="button"
							data-testid="add-child"
							onClick={() => {
								const target = window as Window & {
									__sidebarFixtureAgents?: typeof baseAgents;
									__sidebarFixtureListeners?: Set<(event: unknown) => void>;
								};
								const current = target.__sidebarFixtureAgents ?? initialAgents;
								const id = current.some((item) => item.agentId === "added-1") ? "added-2" : "added-1";
								const siblings = params.get("added") === "siblings";
								const next = [
									...current,
									agent(
										id,
										id === "added-1" ? "新增子任务" : siblings ? "第二子任务" : "新增孙任务",
										id === "added-1" || siblings ? "a1" : "added-1",
									),
								];
								target.__sidebarFixtureAgents = next;
								const event = {
									type: "app-server",
									envelope: {
										jsonrpc: "2.0",
										method: "connection/events",
										params: {
											serverEpoch: "fixture",
											fromCursor: 1,
											toCursor: 1,
											events: next.map((item) => ({ type: "agent/updated", sessionId: "a1", agent: item })),
										},
									},
								};
								for (const listener of target.__sidebarFixtureListeners ?? []) listener(event);
							}}
						>
							添加子任务
						</button>
						<button type="button" data-testid="start-b2" onClick={() => updateRun("b2", true)}>
							开始 Beta 会话
						</button>
						<button type="button" data-testid="start-a1" onClick={() => updateRun("a1", true)}>
							后台开始 Alpha 首会话
						</button>
						<button type="button" data-testid="start-a2" onClick={() => updateRun("a2", true)}>
							开始 Alpha 会话
						</button>
						<button type="button" data-testid="finish-a2" onClick={() => updateRun("a2", false)}>
							结束 Alpha 会话
						</button>
						<button type="button" data-testid="finish-b2" onClick={() => updateRun("b2", false)}>
							结束 Beta 会话
						</button>
						<button
							type="button"
							data-testid="toggle-motion"
							onClick={() => {
								const next = motion === "reduced" ? "full" : "reduced";
								document.documentElement.dataset.motion = next;
								setMotion(next);
							}}
						>
							{motion === "reduced" ? "启用完整动效" : "减少动态效果"}
						</button>
						<button
							type="button"
							data-testid="reset"
							onClick={() => {
								setSessions(initialSessions());
								setSelected(null);
								setActiveAgent(null);
								if (withAgents) {
									localStorage.removeItem("metis.agent-tree.a1");
									localStorage.removeItem("metis.agent-tree.a1.collapsed");
								}
								tick.current = 200;
								setGeneration((current) => current + 1);
							}}
						>
							重置测试会话
						</button>
					</div>
					<output data-testid="content-revision">{contentRevision}</output>
					<output data-testid="selected-session" data-session-id={selected ?? ""}>
						当前会话：{sessions.find((item) => item.sessionId === selected)?.name ?? "未选择"}
					</output>
					{withAgents && <output data-testid="selected-agent">当前子会话：{activeAgent?.name ?? "未选择"}</output>}
					<output data-testid="fixture-state" hidden>
						{JSON.stringify(sessions.map(({ sessionId, state, unread }) => ({ sessionId, state, unread })))}
					</output>
				</div>
				{withAgents && (
					<aside className="tool-sidebar" style={{ top: 40, width: 280 }}>
						<div className="tool-sidebar-body">
							<div className="tool-sidebar-panel">
								<section className="tool-panel knowledge-panel" aria-label="知识库预览">
									<div className="knowledge-toolbar">
										<span>资料与笔记</span>
									</div>
									<div className="knowledge-empty">
										<strong>知识库预览</strong>
										<p>此处使用实际工具栏与知识库样式，仅展示配色。</p>
									</div>
								</section>
							</div>
						</div>
					</aside>
				)}
			</main>
		</div>
	);
}

async function mount() {
	localStorage.setItem("metis.session-grouping.v1", JSON.stringify({ chat: initialGrouping, code: initialGrouping }));
	await setLocale(params.get("locale") === "en" ? "en" : "zh-CN");
	const root = document.querySelector("#root");
	if (!root) throw new Error("Missing motion fixture root");
	createRoot(root).render(<Fixture />);
}
void mount();
