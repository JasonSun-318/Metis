import type { SessionSummary } from "@metis/app-protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "../src/renderer/components/SettingsDialog.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
void setLocale("zh-CN");
type Entry = Awaited<ReturnType<MetisDesktopApi["listArchivedConversations"]>>["conversations"][number];
function session(id: number, name: string, archived = true): SessionSummary {
	return {
		sessionId: `${String(id).padStart(8, "0")}-1111-4111-8111-111111111111`,
		name,
		cwd: null,
		cwdOrigin: "managed",
		state: "idle",
		archived,
		unread: false,
		createdAt: "2026-11-01T12:00:00Z",
		updatedAt: "2026-11-05T12:00:00Z",
		useMemory: true,
		contributeMemory: true,
	};
}
const research = session(1, "秋日旅行计划 · 京都与奈良");
const release = session(2, "Metis 图片生成与会话归档体验改进");
const active = session(3, "仍在进行中的长篇研究任务：建立一套完整、准确、可维护的知识资料库", false);
let conversations: Entry[] =
	params.get("state") === "empty"
		? []
		: [
				{ kind: "session", session: research },
				{
					kind: "agent",
					session: research,
					agentId: "researcher",
					name: "旅行资料检索",
					updatedAt: research.updatedAt,
				},
				{
					kind: "agent",
					session: research,
					agentId: "planner",
					name: "行程规划与预算整理",
					updatedAt: research.updatedAt,
				},
				{ kind: "session", session: release },
				{
					kind: "agent",
					session: release,
					agentId: "reviewer",
					name: "交互布局与功能验证",
					updatedAt: release.updatedAt,
				},
				{
					kind: "agent",
					session: active,
					agentId: "independent",
					name: "已归档的独立资料审阅子代理，这个长标题用于检查窄窗口的文本布局",
					updatedAt: active.updatedAt,
				},
			];
let reads = 0;
const api = {
	platform: "darwin",
	getProfile: async () => ({
		generatedAt: research.updatedAt,
		totalTokens: 0,
		peakDailyTokens: 0,
		longestSessionMs: 0,
		currentStreakDays: 0,
		longestStreakDays: 0,
		sessionCount: 0,
		mostUsedThinkingLevel: null,
		mostUsedThinkingLevelPercent: 0,
		usedSkillCount: 0,
		skillUseCount: 0,
		activity: [],
		topSkills: [],
	}),
	listArchivedConversations: async (input: Parameters<MetisDesktopApi["listArchivedConversations"]>[0]) => {
		reads++;
		document.body.dataset.archiveReads = String(reads);
		if (params.get("state") === "loading") return new Promise<never>(() => undefined);
		if (params.get("state") === "error") throw new Error("暂时无法读取归档会话，请检查连接后重试。");
		const start = input.cursor ? Number(input.cursor) : 0;
		const rows = conversations.slice(start, start + 3);
		return {
			conversations: rows,
			nextCursor: start + rows.length < conversations.length ? String(start + rows.length) : null,
		};
	},
} as unknown as MetisDesktopApi;
const onDeleteSession = async (target: SessionSummary) => {
	if (params.get("deleteError") === "1") throw new Error("请先保存或关闭此会话中尚未保存的文件。");
	conversations = conversations.filter((entry) => entry.session.sessionId !== target.sessionId);
};
const onDeleteAgent = async (rootSessionId: string, agentId: string) => {
	conversations = conversations.filter(
		(entry) => entry.kind !== "agent" || entry.session.sessionId !== rootSessionId || entry.agentId !== agentId,
	);
};
const independentlyArchived = new Set(["planner", "independent"]);
const onRestoreConversation = async (target: SessionSummary, agentId?: string) => {
	if (params.get("restoreError") === "1") throw new Error("暂时无法恢复会话，请稍后重试。");
	if (params.get("restoring") === "1") return new Promise<void>(() => undefined);
	document.body.dataset.restored = agentId ?? target.sessionId;
	if (agentId) independentlyArchived.delete(agentId);
	conversations = conversations
		.map((entry) =>
			entry.session.sessionId === target.sessionId
				? { ...entry, session: { ...entry.session, archived: false } }
				: entry,
		)
		.filter(
			(entry) =>
				entry.session.sessionId !== target.sessionId ||
				(entry.kind === "agent" && independentlyArchived.has(entry.agentId)),
		);
};
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<SettingsDialog
			api={api}
			generalPreferences={{
				motion: "system",
				chatFont: "anthropic-serif",
				codeFont: "system-sans",
				contentFontSize: "15px",
			}}
			onClose={() => undefined}
			onGeneralPreferencesChange={() => undefined}
			onThemeChange={() => undefined}
			onDeleteSession={onDeleteSession}
			onDeleteAgent={onDeleteAgent}
			onRestoreConversation={onRestoreConversation}
			serverReady
			theme={params.get("theme") === "light" ? "light" : "dark"}
		/>
	</StrictMode>,
);
