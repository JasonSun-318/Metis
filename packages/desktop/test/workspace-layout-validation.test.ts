import type { AgentSummaryView, SessionSummary } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { validateRestoredWorkspaceLayout } from "../src/renderer/workspace-layout-validation.ts";
import type { ChatTab, SessionWorkspace } from "../src/renderer/workspace-tabs.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const DATE = "2026-10-25T00:00:00.000Z";

function session(sessionId: string, archived = false): SessionSummary {
	return {
		sessionId,
		mode: "chat",
		cwdOrigin: "managed",
		cwd: `/fixture/${sessionId}`,
		createdAt: DATE,
		updatedAt: DATE,
		state: "idle",
		archived,
		unread: false,
		useMemory: true,
		contributeMemory: true,
	};
}

function agent(agentId: string, rootSessionId = "root", archived = false): AgentSummaryView {
	return {
		agentId,
		rootSessionId,
		parentSessionId: rootSessionId,
		agentPath: [agentId],
		name: agentId,
		agentType: "worker",
		depth: 1,
		status: "done",
		archived,
		tasks: [],
		createdAt: DATE,
		updatedAt: DATE,
	};
}

function chat(sessionId: string | null, agentId?: string): ChatTab {
	return { kind: "chat", id: `${sessionId}-${agentId ?? "chat"}`, sessionId, ...(agentId ? { agentId } : {}) };
}

function workspace(...tabs: ChatTab[]): SessionWorkspace {
	return {
		panes: [{ id: "pane", row: 0, tabs, activeId: tabs.at(-1)?.id ?? "", weight: 0.4 }],
		activePaneId: "pane",
		nextNumber: 8,
		rowWeights: [0.6, 0.4],
		tools: new Map(),
	};
}

function known(...sessions: SessionSummary[]) {
	return new Map(sessions.map((summary) => [summary.sessionId, summary]));
}

function ids(result: { workspace: SessionWorkspace }): string[] {
	return result.workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id));
}

describe("validateRestoredWorkspaceLayout", () => {
	it("uses known live roots without requests and preserves tools and geometry", async () => {
		const original = workspace(chat("root"));
		const tools = new Map([
			[
				"root",
				{
					tabs: [{ kind: "terminal" as const, id: "terminal", sessionId: "root", title: "Shell", cwd: "/" }],
					activeId: "terminal",
				},
			],
		]);
		const input = { ...original, tools, panes: [{ ...original.panes[0]!, placeholder: true }] };
		const result = await validateRestoredWorkspaceLayout(input, known(session("root")), {});
		expect(result.complete).toBe(true);
		expect(result.discoveredSessions).toEqual([]);
		expect(ids(result)).toEqual(["root-chat"]);
		expect(result.workspace.tools).toBe(tools);
		expect(result.workspace.rowWeights).toBe(original.rowWeights);
		expect(result.workspace.panes[0]).toMatchObject({ id: "pane", row: 0, weight: 0.4 });
		expect(result.workspace.panes[0]?.placeholder).not.toBe(true);
		expect(input.panes[0]?.placeholder).toBe(true);
	});

	it("finds a root beyond the first 200 sessions and returns only required summaries", async () => {
		const listSessions = vi
			.fn<MetisDesktopApi["listSessions"]>()
			.mockResolvedValueOnce({
				sessions: Array.from({ length: 200 }, (_, i) => session(`other-${i}`)),
				nextAfterSessionId: "page-2",
			})
			.mockResolvedValueOnce({ sessions: [session("wanted"), session("unrelated")], nextAfterSessionId: null });
		const result = await validateRestoredWorkspaceLayout(workspace(chat("wanted")), known(), { listSessions });
		expect(result.complete).toBe(true);
		expect(ids(result)).toEqual(["wanted-chat"]);
		expect(result.discoveredSessions).toEqual([session("wanted")]);
		expect(listSessions.mock.calls).toEqual([
			[{ includeArchived: true, limit: 200 }],
			[{ includeArchived: true, limit: 200, afterSessionId: "page-2" }],
		]);
	});

	it("stops root pagination once every required root is resolved", async () => {
		const listSessions = vi
			.fn<MetisDesktopApi["listSessions"]>()
			.mockResolvedValue({ sessions: [session("wanted")], nextAfterSessionId: "unused" });
		const result = await validateRestoredWorkspaceLayout(workspace(chat("wanted")), known(), { listSessions });
		expect(result.complete).toBe(true);
		expect(listSessions).toHaveBeenCalledTimes(1);
	});

	it("treats missing roots as deleted only after EOF and preserves empty pane structure", async () => {
		const input = workspace(chat("missing"));
		const listSessions = vi
			.fn<MetisDesktopApi["listSessions"]>()
			.mockResolvedValue({ sessions: [], nextAfterSessionId: null });
		const result = await validateRestoredWorkspaceLayout(input, known(), { listSessions });
		expect(result.complete).toBe(true);
		expect(result.workspace).toMatchObject({
			activePaneId: "pane",
			nextNumber: 8,
			rowWeights: [0.6, 0.4],
			panes: [{ id: "pane", row: 0, weight: 0.4, tabs: [], activeId: "", placeholder: true }],
		});
		expect(input.panes[0]?.tabs).toHaveLength(1);
	});

	it("keeps verified roots but reports incomplete when later metadata fails", async () => {
		const listSessions = vi
			.fn<MetisDesktopApi["listSessions"]>()
			.mockResolvedValueOnce({ sessions: [session("found")], nextAfterSessionId: "next" })
			.mockRejectedValueOnce(new Error("offline"));
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("known"), chat("found"), chat("unknown")),
			known(session("known")),
			{ listSessions },
		);
		expect(result.complete).toBe(false);
		expect(ids(result)).toEqual(["known-chat", "found-chat"]);
		expect(result.discoveredSessions).toEqual([session("found")]);
		expect(result.workspace.panes[0]?.activeId).toBe("known-chat");
	});

	it("drops known and discovered archived roots without restoring their agents", async () => {
		const listSessions = vi
			.fn<MetisDesktopApi["listSessions"]>()
			.mockResolvedValue({ sessions: [session("cold-archived", true)], nextAfterSessionId: null });
		const listAgents = vi.fn<MetisDesktopApi["listAgents"]>();
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("known-archived", "child"), chat("cold-archived")),
			known(session("known-archived", true)),
			{ listSessions, listAgents },
		);
		expect(result.complete).toBe(true);
		expect(ids(result)).toEqual([]);
		expect(result.discoveredSessions).toEqual([]);
		expect(listAgents).not.toHaveBeenCalled();
	});

	it("does not assume missing APIs establish deletion", async () => {
		const result = await validateRestoredWorkspaceLayout(workspace(chat("unknown")), known(), {});
		expect(result.complete).toBe(false);
		expect(ids(result)).toEqual([]);
	});

	it("bounds repeated root cursors without classifying unresolved roots as deleted", async () => {
		const listSessions = vi
			.fn<MetisDesktopApi["listSessions"]>()
			.mockResolvedValue({ sessions: [], nextAfterSessionId: "repeat" });
		const result = await validateRestoredWorkspaceLayout(workspace(chat("unknown")), known(), { listSessions });
		expect(result.complete).toBe(false);
		expect(listSessions).toHaveBeenCalledTimes(2);
	});

	it("bounds root pagination at 100 pages", async () => {
		let page = 0;
		const listSessions = vi
			.fn<MetisDesktopApi["listSessions"]>()
			.mockImplementation(async () => ({ sessions: [], nextAfterSessionId: `page-${++page}` }));
		const result = await validateRestoredWorkspaceLayout(workspace(chat("unknown")), known(), { listSessions });
		expect(result.complete).toBe(false);
		expect(listSessions).toHaveBeenCalledTimes(100);
	});

	it("makes no metadata requests when already cancelled", async () => {
		const listSessions = vi.fn<MetisDesktopApi["listSessions"]>();
		const listAgents = vi.fn<MetisDesktopApi["listAgents"]>();
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("unknown", "child")),
			known(),
			{ listSessions, listAgents },
			() => false,
		);
		expect(result.complete).toBe(false);
		expect(listSessions).not.toHaveBeenCalled();
		expect(listAgents).not.toHaveBeenCalled();
	});

	it("ignores a late root page and starts no further requests after cancellation", async () => {
		let current = true;
		const listSessions = vi.fn<MetisDesktopApi["listSessions"]>().mockImplementation(async () => {
			current = false;
			return { sessions: [session("root")], nextAfterSessionId: "next" };
		});
		const listAgents = vi.fn<MetisDesktopApi["listAgents"]>();
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("root", "child")),
			known(),
			{ listSessions, listAgents },
			() => current,
		);
		expect(result.complete).toBe(false);
		expect(result.discoveredSessions).toEqual([]);
		expect(ids(result)).toEqual([]);
		expect(listSessions).toHaveBeenCalledTimes(1);
		expect(listAgents).not.toHaveBeenCalled();
	});

	it("paginates agent metadata per root and never needs to open a runtime", async () => {
		const listAgents = vi
			.fn<MetisDesktopApi["listAgents"]>()
			.mockResolvedValueOnce({
				agents: Array.from({ length: 100 }, (_, i) => agent(`other-${i}`)),
				nextAfterAgentId: "page-2",
			})
			.mockResolvedValueOnce({ agents: [agent("wanted")], nextAfterAgentId: null });
		const forbidden = vi.fn(() => {
			throw new Error("must remain metadata-only");
		});
		const api = {
			listAgents,
			createSession: forbidden,
			openSession: forbidden,
			focusSession: forbidden,
			subscribe: forbidden,
			sendAgentMessage: forbidden,
		};
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("root", "wanted")),
			known(session("root")),
			api,
		);
		expect(result.complete).toBe(true);
		expect(ids(result)).toEqual(["root-wanted"]);
		expect(listAgents.mock.calls).toEqual([
			[{ sessionId: "root", includeArchived: true, limit: 100 }],
			[{ sessionId: "root", includeArchived: true, limit: 100, afterAgentId: "page-2" }],
		]);
		expect(forbidden).not.toHaveBeenCalled();
	});

	it("removes missing agents only after complete readable metadata and retains their root", async () => {
		const listAgents = vi
			.fn<MetisDesktopApi["listAgents"]>()
			.mockResolvedValue({ agents: [], nextAfterAgentId: null });
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("root"), chat("root", "deleted")),
			known(session("root")),
			{ listAgents },
		);
		expect(result.complete).toBe(true);
		expect(ids(result)).toEqual(["root-chat"]);
		expect(result.workspace.panes[0]?.activeId).toBe("root-chat");
	});

	it("preserves already verified agents when a later page fails", async () => {
		const listAgents = vi
			.fn<MetisDesktopApi["listAgents"]>()
			.mockResolvedValueOnce({ agents: [agent("found")], nextAfterAgentId: "next" })
			.mockRejectedValueOnce(new Error("offline"));
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("root", "found"), chat("root", "unknown")),
			known(session("root")),
			{ listAgents },
		);
		expect(result.complete).toBe(false);
		expect(ids(result)).toEqual(["root-found"]);
	});

	it("reports missing agents as unknown when catalog entries are unreadable", async () => {
		const listAgents = vi
			.fn<MetisDesktopApi["listAgents"]>()
			.mockResolvedValue({ agents: [agent("found")], nextAfterAgentId: null, unreadableAgentCount: 1 });
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("root", "found"), chat("root", "unknown")),
			known(session("root")),
			{ listAgents },
		);
		expect(result.complete).toBe(false);
		expect(ids(result)).toEqual(["root-found"]);
	});

	it("drops archived agents while retaining other live agents", async () => {
		const listAgents = vi
			.fn<MetisDesktopApi["listAgents"]>()
			.mockResolvedValue({ agents: [agent("archived", "root", true), agent("live")], nextAfterAgentId: null });
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("root", "archived"), chat("root", "live")),
			known(session("root")),
			{ listAgents },
		);
		expect(result.complete).toBe(true);
		expect(ids(result)).toEqual(["root-live"]);
	});

	it("does not validate identical agent IDs against a different root", async () => {
		const listAgents = vi
			.fn<MetisDesktopApi["listAgents"]>()
			.mockResolvedValueOnce({ agents: [agent("child", "first")], nextAfterAgentId: null })
			.mockResolvedValueOnce({ agents: [], nextAfterAgentId: null });
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("first", "child"), chat("second", "child")),
			known(session("first"), session("second")),
			{ listAgents },
		);
		expect(result.complete).toBe(true);
		expect(ids(result)).toEqual(["first-child"]);
		expect(listAgents).toHaveBeenCalledTimes(2);
	});

	it("reports incomplete if agent metadata APIs are unavailable", async () => {
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("root"), chat("root", "unknown")),
			known(session("root")),
			{},
		);
		expect(result.complete).toBe(false);
		expect(ids(result)).toEqual(["root-chat"]);
	});

	it("does not accept a matching agent ID returned under the wrong root", async () => {
		const listAgents = vi.fn<MetisDesktopApi["listAgents"]>().mockResolvedValue({
			agents: [agent("child", "other-root")],
			nextAfterAgentId: null,
		});
		const result = await validateRestoredWorkspaceLayout(workspace(chat("root", "child")), known(session("root")), {
			listAgents,
		});
		expect(result.complete).toBe(false);
		expect(ids(result)).toEqual([]);
	});

	it("bounds repeated agent cursors", async () => {
		const listAgents = vi
			.fn<MetisDesktopApi["listAgents"]>()
			.mockResolvedValue({ agents: [], nextAfterAgentId: "repeat" });
		const result = await validateRestoredWorkspaceLayout(workspace(chat("root", "unknown")), known(session("root")), {
			listAgents,
		});
		expect(result.complete).toBe(false);
		expect(listAgents).toHaveBeenCalledTimes(2);
	});

	it("bounds agent pagination at 100 pages", async () => {
		let page = 0;
		const listAgents = vi
			.fn<MetisDesktopApi["listAgents"]>()
			.mockImplementation(async () => ({ agents: [], nextAfterAgentId: `page-${++page}` }));
		const result = await validateRestoredWorkspaceLayout(workspace(chat("root", "unknown")), known(session("root")), {
			listAgents,
		});
		expect(result.complete).toBe(false);
		expect(listAgents).toHaveBeenCalledTimes(100);
	});

	it("ignores a late agent page and never requests another root after cancellation", async () => {
		let current = true;
		const listAgents = vi.fn<MetisDesktopApi["listAgents"]>().mockImplementation(async () => {
			current = false;
			return { agents: [agent("child", "first")], nextAfterAgentId: "next" };
		});
		const result = await validateRestoredWorkspaceLayout(
			workspace(chat("first", "child"), chat("second", "child")),
			known(session("first"), session("second")),
			{ listAgents },
			() => current,
		);
		expect(result.complete).toBe(false);
		expect(ids(result)).toEqual([]);
		expect(listAgents).toHaveBeenCalledTimes(1);
	});
});
