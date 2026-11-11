import type { ItemView, SessionSnapshot, SessionSummary } from "@metis/app-protocol";
import { createRoot } from "react-dom/client";
import { App } from "../src/renderer/components/App.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

const date = "2026-11-06T12:00:00Z";
const epoch = "11111111-1111-4111-8111-111111111111";
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
localStorage.setItem("metis.theme.v1", theme);
let sessions: SessionSummary[] = ["日常工作中修改的文件", "历史代码会话"].map((name, index) => ({
	sessionId: `${index + 1}1111111-1111-4111-8111-111111111111`,
	cwd: "/tmp/metis-demo",
	cwdOrigin: "user-selected",
	name,
	createdAt: date,
	updatedAt: date,
	state: "idle",
	archived: false,
	unread: false,
	useMemory: true,
	contributeMemory: true,
}));
const root = sessions[0]!;
localStorage.setItem("metis.activeSessionId.chat", root.sessionId);
localStorage.setItem("metis.session-grouping.v1", JSON.stringify({ chat: "project", code: "date" }));
const items: ItemView[] = [
	{
		itemId: "user",
		sessionId: root.sessionId,
		turnId: "turn",
		role: "user",
		state: "completed",
		createdAt: date,
		content: [{ type: "text", text: "把标题改为每周工作总结。" }],
	},
	{
		itemId: "call",
		sessionId: root.sessionId,
		turnId: "turn",
		role: "assistant",
		state: "completed",
		createdAt: date,
		content: [
			{
				type: "tool_call",
				toolCallId: "write",
				name: "write",
				state: "completed",
				inputPreview: '{"path":"report.md"}',
			},
		],
	},
	{
		itemId: "result",
		sessionId: root.sessionId,
		turnId: "turn",
		role: "tool",
		state: "completed",
		createdAt: date,
		content: [
			{
				type: "tool_result",
				toolCallId: "write",
				name: "write",
				isError: false,
				output: "Updated report.md",
				codeChanges: {
					version: 1,
					sequence: 1,
					partial: false,
					turn: { additions: 1, deletions: 1, partial: false },
					files: [
						{
							path: "report.md",
							kind: "modified",
							additions: 1,
							deletions: 1,
							diff: "--- a/report.md\n+++ b/report.md\n@@ -1 +1 @@\n-# 工作总结\n+# 每周工作总结\n",
						},
					],
				},
			},
		],
	},
	{
		itemId: "answer",
		sessionId: root.sessionId,
		turnId: "turn",
		role: "assistant",
		state: "completed",
		createdAt: date,
		content: [{ type: "text", text: "标题已更新，你可以继续补充本周的工作内容。" }],
	},
];
function snapshot(sessionId: string): SessionSnapshot {
	const session = sessions.find((value) => value.sessionId === sessionId)!;
	return {
		session,
		collaborationMode: "default",
		permissionPreset: "auto",
		effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
		constrainedByParent: false,
		sandboxHealth: "healthy",
		turns: [],
		recentItems: sessionId === root.sessionId ? items : [],
		nextBeforeItemId: null,
		activeTurnId: null,
		pendingInteractions: [],
		queuedTurns: [],
		tasks: [],
		deliveredFiles: [],
		goal: null,
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		agents: [],
		serverEpoch: epoch,
		cursor: 0,
	};
}
const noOp = async () => {};
const api = {
	platform: "darwin",
	getProfile: async () => ({
		generatedAt: date,
		totalTokens: 0,
		peakDailyTokens: 0,
		longestSessionMs: 0,
		currentStreakDays: 0,
		longestStreakDays: 0,
		sessionCount: 2,
		mostUsedThinkingLevel: null,
		mostUsedThinkingLevelPercent: 0,
		usedSkillCount: 0,
		skillUseCount: 0,
		activity: [],
		topSkills: [],
	}),
	subscribe: () => () => {},
	subscribeUpdate: () => () => {},
	subscribeTerminal: () => () => {},
	subscribeBrowser: () => () => {},
	getServerState: async () => ({ state: "ready", serverEpoch: epoch, restartAttempt: 0, failure: null }),
	getThemePreference: async () => theme,
	setThemePreference: noOp,
	getUpdateState: async () => ({ status: "unavailable" }),
	setWorkspaceEditState: noOp,
	retainWorkspaceSessions: noOp,
	setScheduleKeepAwake: noOp,
	unsubscribeSchedule: noOp,
	subscribeSchedule: async () => ({ snapshot: { serverEpoch: epoch, tasks: [], unreadCount: 0, cursor: 0 } }),
	listSchedules: async () => ({ tasks: [], nextAfterTaskId: null, unreadCount: 0 }),
	listSessions: async () => ({ sessions, nextAfterSessionId: null }),
	openSession: async ({ sessionId }: { sessionId: string }) => snapshot(sessionId),
	subscribeSession: async ({ sessionId }: { sessionId: string }) => snapshot(sessionId),
	focusSession: noOp,
	listSkills: async () => ({ skills: [] }),
	listMcpServers: async () => ({ servers: [] }),
	listAgents: async () => ({ agents: [], nextAfterAgentId: null }),
	getModelSettings: async () => ({
		defaultModel: null,
		defaultThinkingSelection: "off",
		autoSessionTitle: true,
		providers: [],
		permissionReviewer: { config: null, status: "unconfigured" },
		loadError: null,
	}),
	getWebSearchSettings: async () => ({ enabled: false, provider: "brave", authConfigured: false }),
	listBrowserDownloads: async () => [],
	listBrowserProfiles: async () => [],
	getDefaultProjectLocation: async () => "/tmp",
	selectProjectFolder: async () => "/tmp/selected",
	selectAttachmentFiles: async () => [{ path: "/tmp/report.pdf", name: "report.pdf" }],
	resolveDroppedFiles: () => [],
	getContextUsage: async () => ({}),
	readItems: async () => ({ items: [], nextBeforeItemId: null }),
	startTurn: noOp,
	createSession: async (input: { mode: "chat" | "code"; cwd?: string; requestId: string }) => {
		document.body.dataset.created = JSON.stringify(input);
		const session = {
			...root,
			sessionId: input.requestId,
			cwd: input.cwd ?? `/managed/${input.requestId}`,
			cwdOrigin: input.cwd ? ("user-selected" as const) : ("managed" as const),
			name: "新任务",
		};
		sessions = [...sessions, session];
		return { session };
	},
} as unknown as MetisDesktopApi;
void setLocale("zh-CN").then(() =>
	createRoot(document.getElementById("root")!).render(<App api={api} store={new AppStore()} />),
);
