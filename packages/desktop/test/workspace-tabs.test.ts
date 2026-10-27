import { describe, expect, it } from "vitest";
import {
	activateTab,
	activePane,
	addTab,
	canSplit,
	chatTab,
	closeEmptyPane,
	collapsedTabIds,
	defaultWorkspace,
	findChatTab,
	findTabLocation,
	findToolLocation,
	focusedChatTab,
	getSplitLimitReason,
	moveTab,
	moveTabGroup,
	moveToolTab,
	normalizeTabGroups,
	relatedInsertIndex,
	removeTab,
	removeTabs,
	revealTab,
	type SessionWorkspace,
	setPaneWeights,
	setRowWeights,
	splitTab,
	tabGroupRuns,
	toggleTabGroup,
	type WorkspaceTab,
	workspaceTabs,
} from "../src/renderer/workspace-tabs.ts";

const SESSION = "session-a";

// Panes only carry chat tabs now; extra() mints a filler chat tab.
function extra(id: string): WorkspaceTab {
	return { kind: "chat", id, sessionId: `session-${id}` };
}

function terminal(id: string): WorkspaceTab {
	return { kind: "terminal", id, sessionId: SESSION, title: id, cwd: "/tmp" };
}

function seededWorkspace(): { workspace: SessionWorkspace; chatId: string } {
	const chat = chatTab(SESSION);
	return {
		workspace: addTab(defaultWorkspace(), chat),
		chatId: chat.id,
	};
}

function tabs(workspace: SessionWorkspace, paneIndex = 0): string[] {
	return workspace.panes[paneIndex]!.tabs.map((tab) => tab.id);
}

function rows(workspace: SessionWorkspace): number[] {
	return workspace.panes.map((pane) => pane.row);
}

function split(
	workspace: SessionWorkspace,
	tabId: string,
	direction: "left" | "right" | "up" | "down",
): SessionWorkspace {
	const pane = workspace.panes.find((candidate) => candidate.tabs.some((tab) => tab.id === tabId));
	return splitTab(workspace, tabId, pane!.id, direction);
}

describe("defaultWorkspace", () => {
	it("starts with a single empty pane", () => {
		const workspace = defaultWorkspace();
		expect(workspace.panes).toHaveLength(1);
		expect(tabs(workspace)).toEqual([]);
		expect(activePane(workspace).activeId).toBe("");
	});
});

describe("chatTab", () => {
	it("carries the session id and supports a draft session", () => {
		const workspace = addTab(defaultWorkspace(), chatTab(null));
		expect(findChatTab(workspace, null)?.sessionId).toBeNull();
		expect(focusedChatTab(workspace)?.sessionId).toBeNull();
	});
});

describe("addTab / activateTab", () => {
	it("appends to the active pane and activates the new tab", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		expect(tabs(workspace)).toEqual([chatId, "t1"]);
		expect(activePane(workspace).activeId).toBe("t1");
		workspace = activateTab(workspace, chatId);
		expect(activePane(workspace).activeId).toBe(chatId);
	});

	it("activating an unknown tab is a no-op", () => {
		const workspace = defaultWorkspace();
		expect(activateTab(workspace, "nope")).toBe(workspace);
	});
});

describe("removeTab", () => {
	it("activates the neighbor tab when the active tab closes", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = addTab(workspace, extra("t2"));
		workspace = removeTab(workspace, "t2");
		expect(tabs(workspace)).toEqual([chatId, "t1"]);
		expect(activePane(workspace).activeId).toBe("t1");
	});

	it("allows closing a chat tab", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		const workspace = removeTab(addTab(seeded, extra("t1")), chatId);
		expect(tabs(workspace)).toEqual(["t1"]);
	});
});

describe("splitTab", () => {
	it("moves the tab into a new pane to the right in the same row", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "right");
		expect(workspace.panes).toHaveLength(2);
		expect(rows(workspace)).toEqual([0, 0]);
		expect(tabs(workspace, 0)).toEqual([chatId]);
		expect(tabs(workspace, 1)).toEqual(["t1"]);
		expect(workspace.activePaneId).toBe(workspace.panes[1]!.id);
		expect(workspace.panes[1]!.activeId).toBe("t1");
	});

	it("splits left by inserting the new pane before the target", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "right");
		workspace = addTab(workspace, extra("t2"), workspace.panes[1]!.id);
		workspace = split(workspace, "t2", "left");
		expect(rows(workspace)).toEqual([0, 0, 0]);
		expect(tabs(workspace, 0)).toEqual([chatId]);
		expect(tabs(workspace, 1)).toEqual(["t2"]);
		expect(tabs(workspace, 2)).toEqual(["t1"]);
		expect(workspace.activePaneId).toBe(workspace.panes[1]!.id);
	});

	it("splits down into a new bottom row", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "down");
		expect(rows(workspace)).toEqual([0, 1]);
		expect(tabs(workspace, 0)).toEqual([chatId]);
		expect(tabs(workspace, 1)).toEqual(["t1"]);
		expect(workspace.activePaneId).toBe(workspace.panes[1]!.id);
	});

	it("splits up from the bottom row into the top row", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "down");
		workspace = addTab(workspace, extra("t2"), workspace.panes[1]!.id);
		workspace = split(workspace, "t2", "up");
		expect(rows(workspace)).toEqual([0, 0, 1]);
		expect(tabs(workspace, 0)).toEqual(["t2"]);
		expect(tabs(workspace, 1)).toEqual([chatId]);
		expect(tabs(workspace, 2)).toEqual(["t1"]);
		expect(workspace.activePaneId).toBe(workspace.panes[0]!.id);
	});

	it("places a down split at the matching column of an existing bottom row", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = addTab(workspace, extra("t2"));
		workspace = addTab(workspace, extra("t3"));
		workspace = addTab(workspace, extra("t4"));
		workspace = split(workspace, "t1", "right");
		workspace = split(workspace, "t2", "right");
		workspace = split(workspace, "t3", "down");
		workspace = split(workspace, "t4", "down");
		expect(rows(workspace)).toEqual([0, 0, 0, 1, 1]);
		expect(tabs(workspace, 3)).toEqual(["t4"]);
		expect(tabs(workspace, 4)).toEqual(["t3"]);
	});

	it("blocks a fourth pane in a row", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = addTab(workspace, extra("t2"));
		workspace = split(workspace, "t1", "right");
		workspace = split(workspace, "t2", "right");
		expect(canSplit(workspace, workspace.panes[0]!.id, "right")).toBe(false);
		workspace = addTab(workspace, extra("t3"), workspace.panes[0]!.id);
		expect(split(workspace, "t3", "right")).toBe(workspace);
		expect(workspace.panes).toHaveLength(3);
	});

	it("blocks down from the bottom row and from a full bottom row", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = addTab(workspace, extra("t2"));
		workspace = addTab(workspace, extra("t3"));
		workspace = addTab(workspace, extra("t4"));
		workspace = split(workspace, "t1", "down");
		workspace = split(workspace, "t2", "down");
		workspace = split(workspace, "t3", "down");
		expect(rows(workspace)).toEqual([0, 1, 1, 1]);
		const bottom = workspace.panes[1]!.id;
		expect(canSplit(workspace, bottom, "down")).toBe(false);
		expect(canSplit(workspace, workspace.panes[0]!.id, "down")).toBe(false);
		expect(splitTab(workspace, "t4", workspace.panes[0]!.id, "down")).toBe(workspace);
	});

	it("promotes the bottom row when the last top-row pane empties", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "down");
		workspace = removeTab(workspace, chatId);
		expect(rows(workspace)).toEqual([0]);
		expect(tabs(workspace, 0)).toEqual(["t1"]);
	});

	it("keeps panes row-major when a top-row pane collapses ahead of the bottom row", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = addTab(workspace, extra("t2"));
		workspace = split(workspace, "t1", "right");
		workspace = split(workspace, "t2", "down");
		expect(rows(workspace)).toEqual([0, 0, 1]);
		workspace = moveTab(workspace, "t1", workspace.panes[0]!.id);
		expect(rows(workspace)).toEqual([0, 1]);
		expect(tabs(workspace, 0)).toEqual([chatId, "t1"]);
		expect(tabs(workspace, 1)).toEqual(["t2"]);
	});
});

describe("moveTab", () => {
	it("moves a tab between panes and collapses the empty source pane", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "right");
		workspace = addTab(workspace, extra("t2"), workspace.panes[1]!.id);
		// move chat into the right pane so the left pane becomes empty
		workspace = moveTab(workspace, chatId, workspace.panes[1]!.id);
		expect(workspace.panes).toHaveLength(1);
		expect(tabs(workspace)).toEqual(["t1", "t2", chatId]);
	});

	it("reorders within the same pane", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = addTab(workspace, extra("t2"));
		workspace = moveTab(workspace, "t2", workspace.panes[0]!.id, 1);
		expect(tabs(workspace)).toEqual([chatId, "t2", "t1"]);
	});
});

describe("workspaceTabs / findTabLocation", () => {
	it("locates tabs across panes", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "right");
		expect(workspaceTabs(workspace).map((tab) => tab.id)).toEqual([chatId, "t1"]);
		expect(findTabLocation(workspace, "t1")).toEqual({ paneIndex: 1, tabIndex: 0 });
		expect(workspace.panes.find((pane) => pane.tabs.some((tab) => tab.id === "t1"))!.id).toBe(workspace.panes[1]!.id);
	});
});

describe("removeTabs", () => {
	it("removes a batch of tabs", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = addTab(workspace, extra("t2"));
		workspace = removeTabs(workspace, new Set(["t1", "t2"]));
		expect(workspaceTabs(workspace).map((tab) => tab.kind)).toEqual(["chat"]);
	});
});

describe("project tab groups", () => {
	const projects: Record<string, string> = { a: "/work/alpha", b: "/work/beta", c: "/work/alpha" };
	const groupOf = (tab: WorkspaceTab) => (tab.sessionId === null ? null : (projects[tab.sessionId] ?? null));
	const chat = (sessionId: string): WorkspaceTab => ({ ...chatTab(sessionId), id: `chat-${sessionId}` });
	const tool = (sessionId: string, id: string): WorkspaceTab => ({
		kind: "chat",
		id,
		sessionId,
	});

	it("inserts at an index and clamps out-of-range positions", () => {
		const base = addTab(addTab(defaultWorkspace(), chat("a")), chat("b"));
		const middle = addTab(base, chat("c"), base.activePaneId, true, 1);
		expect(middle.panes[0]!.tabs.map((tab) => tab.id)).toEqual(["chat-a", "chat-c", "chat-b"]);
		const clamped = addTab(base, chat("c"), base.activePaneId, true, 99);
		expect(clamped.panes[0]!.tabs.map((tab) => tab.id)).toEqual(["chat-a", "chat-b", "chat-c"]);
	});

	it("places a tab after its own session, then after its project, then at the end", () => {
		let workspace = addTab(addTab(defaultWorkspace(), chat("a")), chat("b"));
		const pane = () => workspace.panes[0]!;
		expect(relatedInsertIndex(pane(), tool("a", "term-a"), groupOf)).toBe(1);
		workspace = addTab(workspace, tool("a", "term-a"), pane().id, true, 1);
		// Session c shares alpha with a, so it joins after a's second tab rather than after beta.
		expect(relatedInsertIndex(pane(), chat("c"), groupOf)).toBe(2);
		expect(relatedInsertIndex(pane(), chat("z"), groupOf)).toBe(3);
		expect(relatedInsertIndex(pane(), chatTab(null), groupOf)).toBe(3);
	});

	it("labels each run of adjacent tabs that share a project once", () => {
		const tabs = [chat("a"), tool("a", "term-a"), chat("b"), chatTab(null), chat("c")];
		const runs = tabGroupRuns(tabs, groupOf, (group) => group);
		expect(runs.map((run) => [run.group, run.tabs.length])).toEqual([
			["/work/alpha", 2],
			["/work/beta", 1],
			[null, 1],
			["/work/alpha", 1],
		]);
	});

	const ids = (workspace: SessionWorkspace, paneIndex = 0) => workspace.panes[paneIndex]!.tabs.map((tab) => tab.id);
	const strip = (...tabs: WorkspaceTab[]): SessionWorkspace =>
		tabs.reduce((workspace, tab) => addTab(workspace, tab), defaultWorkspace());

	it("keeps each project's tabs together, groups in first-seen order and ungrouped tabs last", () => {
		const draft = { ...chatTab(null), id: "chat-draft" };
		const workspace = strip(chat("a"), draft, chat("b"), tool("a", "term-a"), chat("c"));
		const grouped = normalizeTabGroups(workspace, groupOf);
		expect(ids(grouped)).toEqual(["chat-a", "term-a", "chat-c", "chat-b", "chat-draft"]);
		expect(tabGroupRuns(grouped.panes[0]!.tabs, groupOf, (group) => group).map((run) => run.group)).toEqual([
			"/work/alpha",
			"/work/beta",
			null,
		]);
		// An already grouped workspace is returned as is, so updates stay cheap no-ops.
		expect(normalizeTabGroups(grouped, groupOf)).toBe(grouped);
	});

	it("snaps a tab dropped inside another project back to its own group", () => {
		const workspace = normalizeTabGroups(strip(chat("a"), chat("c"), chat("b"), tool("b", "term-b")), groupOf);
		const dropped = normalizeTabGroups(moveTab(workspace, "chat-a", workspace.activePaneId, 3), groupOf);
		expect(ids(dropped)).toEqual(["chat-c", "chat-a", "chat-b", "term-b"]);
	});

	it("collapses a group, moving off its active tab, and expands it again", () => {
		let workspace = normalizeTabGroups(strip(chat("a"), chat("b"), chat("c")), groupOf);
		const paneId = workspace.activePaneId;
		expect(workspace.panes[0]!.activeId).toBe("chat-c");

		workspace = normalizeTabGroups(toggleTabGroup(workspace, paneId, "/work/alpha", groupOf), groupOf);
		expect(workspace.panes[0]!.collapsedGroups).toEqual(["/work/alpha"]);
		// The nearest tab outside the group takes over.
		expect(workspace.panes[0]!.activeId).toBe("chat-b");
		expect([...collapsedTabIds(workspace.panes[0]!, groupOf)]).toEqual(["chat-a", "chat-c"]);

		workspace = normalizeTabGroups(toggleTabGroup(workspace, paneId, "/work/alpha", groupOf), groupOf);
		expect(workspace.panes[0]!.collapsedGroups).toBeUndefined();
		expect(collapsedTabIds(workspace.panes[0]!, groupOf).size).toBe(0);
	});

	it("keeps a group open when it holds every tab of the pane", () => {
		const workspace = normalizeTabGroups(strip(chat("a"), chat("c")), groupOf);
		expect(toggleTabGroup(workspace, workspace.activePaneId, "/work/alpha", groupOf)).toBe(workspace);
	});

	it("expands a collapsed group when one of its tabs becomes active", () => {
		let workspace = normalizeTabGroups(strip(chat("a"), chat("b")), groupOf);
		workspace = normalizeTabGroups(
			toggleTabGroup(workspace, workspace.activePaneId, "/work/alpha", groupOf),
			groupOf,
		);
		expect(workspace.panes[0]!.collapsedGroups).toEqual(["/work/alpha"]);
		workspace = normalizeTabGroups(activateTab(workspace, "chat-a"), groupOf);
		expect(workspace.panes[0]!.collapsedGroups).toBeUndefined();
	});

	it("forgets a collapsed group once its tabs are gone or the pane holds a single project", () => {
		let workspace = normalizeTabGroups(strip(chat("a"), chat("b"), tool("b", "term-b")), groupOf);
		workspace = normalizeTabGroups(
			toggleTabGroup(workspace, workspace.activePaneId, "/work/alpha", groupOf),
			groupOf,
		);
		const closedGroup = normalizeTabGroups(removeTab(workspace, "chat-a"), groupOf);
		expect(closedGroup.panes[0]!.collapsedGroups).toBeUndefined();
		const singleProject = normalizeTabGroups(removeTabs(workspace, new Set(["chat-b", "term-b"])), groupOf);
		expect(singleProject.panes[0]!.collapsedGroups).toBeUndefined();
	});

	it("moves a whole group within a pane and across panes, keeping it collapsed", () => {
		let workspace = normalizeTabGroups(strip(chat("a"), chat("c"), chat("b")), groupOf);
		const paneId = workspace.activePaneId;
		// Drag alpha's label past beta: the index counts tabs before the move.
		const reordered = normalizeTabGroups(moveTabGroup(workspace, paneId, "/work/alpha", groupOf, paneId, 3), groupOf);
		expect(ids(reordered)).toEqual(["chat-b", "chat-a", "chat-c"]);
		expect(reordered.panes[0]!.activeId).toBe("chat-b");

		workspace = addTab(workspace, tool("b", "term-b"));
		workspace = splitTab(workspace, "term-b", paneId, "right");
		workspace = addTab(workspace, chat("z"), workspace.activePaneId);
		workspace = normalizeTabGroups(toggleTabGroup(workspace, paneId, "/work/alpha", groupOf), groupOf);
		const targetId = workspace.panes[1]!.id;
		const moved = normalizeTabGroups(moveTabGroup(workspace, paneId, "/work/alpha", groupOf, targetId, 0), groupOf);
		expect(ids(moved, 0)).toEqual(["chat-b"]);
		expect(ids(moved, 1)).toEqual(["chat-a", "chat-c", "term-b", "chat-z"]);
		expect(moved.panes[1]!.collapsedGroups).toEqual(["/work/alpha"]);
		expect(moved.panes[0]!.collapsedGroups).toBeUndefined();
		expect(moved.activePaneId).toBe(targetId);
	});
});

describe("tool strips", () => {
	const stripOf = (workspace: SessionWorkspace, sessionId = SESSION) =>
		workspace.tools.get(sessionId) ?? { tabs: [], activeId: "" };

	it("adds non-chat tabs to their session's strip, not a pane", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		const workspace = addTab(seeded, terminal("t1"));
		expect(tabs(workspace)).toEqual([chatId]);
		expect(stripOf(workspace).tabs.map((tab) => tab.id)).toEqual(["t1"]);
		expect(stripOf(workspace).activeId).toBe("t1");
	});

	it("activates and removes tabs inside the strip", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(addTab(seeded, terminal("t1")), terminal("t2"));
		expect(stripOf(workspace).activeId).toBe("t2");
		workspace = activateTab(workspace, "t1");
		expect(stripOf(workspace).activeId).toBe("t1");
		workspace = removeTab(workspace, "t1");
		expect(stripOf(workspace).tabs.map((tab) => tab.id)).toEqual(["t2"]);
		expect(stripOf(workspace).activeId).toBe("t2");
	});

	it("reorders tool tabs inside their own strip", () => {
		const { workspace: seeded } = seededWorkspace();
		const workspace = addTab(addTab(seeded, terminal("t1")), terminal("t2"));
		const moved = moveToolTab(workspace, "t2", 0);
		expect(stripOf(moved).tabs.map((tab) => tab.id)).toEqual(["t2", "t1"]);
		expect(stripOf(moved).activeId).toBe("t2");
	});

	it("routes moveTab for a tool tab into its strip", () => {
		const { workspace: seeded } = seededWorkspace();
		const workspace = addTab(addTab(seeded, terminal("t1")), terminal("t2"));
		const moved = moveTab(workspace, "t2", seeded.panes[0]!.id, 0);
		expect(stripOf(moved).tabs.map((tab) => tab.id)).toEqual(["t2", "t1"]);
	});

	it("includes strip tabs in workspaceTabs and locate helpers", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		const workspace = addTab(seeded, terminal("t1"));
		expect(workspaceTabs(workspace).map((tab) => tab.id)).toEqual([chatId, "t1"]);
		expect(findToolLocation(workspace, "t1")?.sessionId).toBe(SESSION);
		expect(findTabLocation(workspace, "t1")).toBeNull();
	});
});

describe("revealTab", () => {
	it("fronts a tab in its own pane without moving focus there", () => {
		const { workspace, chatId } = seededWorkspace();
		const withTerminal = addTab(workspace, extra("t1"));
		const split = splitTab(withTerminal, "t1", withTerminal.activePaneId, "right");
		const focusedPane = split.activePaneId;
		const covered = addTab(split, extra("t2"), split.panes[0]!.id, false);
		const revealed = revealTab(covered, chatId);
		expect(revealed.panes[0]!.activeId).toBe(chatId);
		expect(revealed.activePaneId).toBe(focusedPane);
		expect(revealTab(revealed, chatId)).toBe(revealed);
	});
});

describe("getSplitLimitReason", () => {
	it("reports a missing pane and allows ordinary splits", () => {
		const { workspace } = seededWorkspace();
		expect(getSplitLimitReason(workspace, "nope", "right")).toBe("missing-pane");
		expect(getSplitLimitReason(workspace, workspace.panes[0]!.id, "right")).toBeNull();
		expect(getSplitLimitReason(workspace, workspace.panes[0]!.id, "down")).toBeNull();
		expect(canSplit(workspace, workspace.panes[0]!.id, "right")).toBe(true);
	});

	it("reports column-limit once a row holds three panes", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = addTab(workspace, extra("t2"));
		workspace = split(workspace, "t1", "right");
		workspace = split(workspace, "t2", "right");
		expect(getSplitLimitReason(workspace, workspace.panes[0]!.id, "left")).toBe("column-limit");
		expect(canSplit(workspace, workspace.panes[0]!.id, "right")).toBe(false);
	});

	it("reports row-limit for wrong-row or full-row vertical splits and pane-limit at six panes", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "down");
		expect(getSplitLimitReason(workspace, workspace.panes[1]!.id, "down")).toBe("row-limit");
		expect(getSplitLimitReason(workspace, workspace.panes[0]!.id, "up")).toBe("row-limit");
		workspace = addTab(workspace, extra("t2"), workspace.panes[0]!.id);
		workspace = split(workspace, "t2", "right");
		workspace = split(workspace, "t2", "down");
		workspace = addTab(workspace, extra("t3"), workspace.panes[0]!.id);
		workspace = split(workspace, "t3", "right");
		workspace = addTab(workspace, extra("t4"), workspace.panes[0]!.id);
		workspace = split(workspace, "t4", "down");
		expect(workspace.panes).toHaveLength(6);
		expect(getSplitLimitReason(workspace, workspace.panes[0]!.id, "right")).toBe("pane-limit");
	});
});

describe("placeholder splits", () => {
	it("keeps the source pane as an empty placeholder when its sole tab splits away", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		const workspace = split(seeded, chatId, "right");
		expect(workspace.panes).toHaveLength(2);
		expect(workspace.panes[0]!.tabs).toEqual([]);
		expect(workspace.panes[0]!.placeholder).toBe(true);
		expect(workspace.panes[1]!.tabs.map((tab) => tab.id)).toEqual([chatId]);
		expect(workspace.activePaneId).toBe(workspace.panes[1]!.id);
	});

	it("clears the placeholder once a tab lands in the pane", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = split(seeded, chatId, "right");
		workspace = addTab(workspace, extra("t1"), workspace.panes[0]!.id);
		expect(workspace.panes[0]!.placeholder).toBe(false);
		expect(workspace.panes[0]!.tabs.map((tab) => tab.id)).toEqual(["t1"]);
	});

	it("reclaims a placeholder-free pane when its last tab closes normally", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		const workspace = removeTab(seeded, chatId);
		expect(workspace.panes).toHaveLength(1);
		expect(workspace.panes[0]!.tabs).toEqual([]);
		expect(workspace.panes[0]!.placeholder).toBeUndefined();
	});

	it("keeps a placeholder pane across unrelated pane collapses", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, chatId, "right");
		// Source pane (index 0) still holds t1, so only the sole-tab case is a placeholder;
		// instead split the single tab of pane 1 downward.
		workspace = split(workspace, "t1", "down");
		const placeholder = workspace.panes.find((pane) => pane.placeholder === true);
		expect(placeholder).toBeDefined();
		expect(workspace.panes).toHaveLength(3);
	});
});

describe("closeEmptyPane", () => {
	it("closes only an empty pane and hands activation to a neighbor", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = split(seeded, chatId, "right");
		const placeholderId = workspace.panes[0]!.id;
		workspace = closeEmptyPane(workspace, placeholderId);
		expect(workspace.panes).toHaveLength(1);
		expect(workspace.panes[0]!.tabs.map((tab) => tab.id)).toEqual([chatId]);
		expect(workspace.activePaneId).toBe(workspace.panes[0]!.id);
	});

	it("refuses panes with tabs, unknown ids and the last remaining pane", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		expect(closeEmptyPane(seeded, seeded.panes[0]!.id)).toBe(seeded);
		expect(closeEmptyPane(seeded, "nope")).toBe(seeded);
		const emptied = removeTab(seeded, chatId);
		expect(closeEmptyPane(emptied, emptied.panes[0]!.id)).toBe(emptied);
	});

	it("drops row weights when closing the only bottom-row pane", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = split(seeded, chatId, "down");
		expect(workspace.rowWeights).toEqual([1, 1]);
		workspace = removeTab(workspace, chatId);
		expect(workspace.panes.some((pane) => pane.row === 1)).toBe(false);
		expect(workspace.rowWeights).toBeUndefined();
	});
});

describe("weights", () => {
	it("halves both sides when a weighted pane splits its sole tab", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		const weighted = setPaneWeights(seeded, 0, new Map([[seeded.activePaneId, 1]]));
		const workspace = split(weighted, chatId, "right");
		expect(workspace.panes.map((pane) => pane.weight)).toEqual([0.5, 0.5]);
		expect(workspace.panes[0]!.placeholder).toBe(true);
	});

	it("halves a target's default share without changing its neighbor", () => {
		const left = { id: "left", row: 0 as const, tabs: [extra("left-tab")], activeId: "left-tab" };
		const right = { id: "right", row: 0 as const, tabs: [extra("right-tab")], activeId: "right-tab" };
		const input = { ...defaultWorkspace(), panes: [left, right], activePaneId: "left" };
		const workspace = splitTab(input, "left-tab", "left", "right");
		expect(workspace.panes.map((pane) => pane.weight)).toEqual([0.5, 0.5, undefined]);
		expect(workspace.panes.find((pane) => pane.id === "right")).toBe(right);
	});

	it("splits the target share rather than the source when a tab moves across panes", () => {
		const left = {
			id: "left",
			row: 0 as const,
			tabs: [extra("moving"), extra("remaining")],
			activeId: "moving",
			weight: 0.8,
		};
		const right = { id: "right", row: 0 as const, tabs: [extra("target")], activeId: "target", weight: 0.2 };
		const input = { ...defaultWorkspace(), panes: [left, right], activePaneId: "left" };
		const workspace = splitTab(input, "moving", "right", "left");
		expect(workspace.panes.map((pane) => pane.weight)).toEqual([0.8, 0.1, 0.1]);
		expect(workspace.panes[0]!.tabs.map((tab) => tab.id)).toEqual(["remaining"]);
		expect(workspace.panes[1]!.tabs.map((tab) => tab.id)).toEqual(["moving"]);
		expect(input.panes[0]!.weight).toBe(0.8);
	});

	it("preserves an emptied source's share when splitting a different target", () => {
		const left = { id: "left", row: 0 as const, tabs: [extra("moving")], activeId: "moving", weight: 0.8 };
		const right = { id: "right", row: 0 as const, tabs: [extra("target")], activeId: "target", weight: 0.2 };
		const workspace = splitTab(
			{ ...defaultWorkspace(), panes: [left, right], activePaneId: "left" },
			"moving",
			"right",
			"right",
		);
		expect(workspace.panes.map((pane) => pane.weight)).toEqual([0.8, 0.1, 0.1]);
		expect(workspace.panes[0]!.placeholder).toBe(true);
	});

	it("splits the source pane's weight in half on a same-row split", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = setPaneWeights(workspace, 0, new Map([[workspace.panes[0]!.id, 2]]));
		expect(workspace.panes[0]!.weight).toBe(1);
		workspace = split(workspace, "t1", "right");
		expect(workspace.panes[0]!.weight).toBeCloseTo(0.5);
		expect(workspace.panes.find((pane) => pane.tabs.some((tab) => tab.id === "t1"))!.weight).toBeCloseTo(0.5);
	});

	it("normalizes pane weights per row and ignores unknown or invalid entries", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, extra("t1"));
		workspace = split(workspace, "t1", "right");
		const first = workspace.panes[0]!.id;
		const second = workspace.panes[1]!.id;
		workspace = setPaneWeights(
			workspace,
			0,
			new Map([
				[first, 3],
				[second, 1],
				["nope", 9],
			]),
		);
		expect(workspace.panes.find((pane) => pane.id === first)!.weight).toBeCloseTo(0.75);
		expect(workspace.panes.find((pane) => pane.id === second)!.weight).toBeCloseTo(0.25);
		const before = workspace;
		expect(
			setPaneWeights(
				before,
				0,
				new Map([
					[first, 0],
					[second, -2],
				]),
			),
		).toBe(before);
		expect(setPaneWeights(before, 0, new Map([["nope", 1]]))).toBe(before);
	});

	it("normalizes row weights and rejects invalid pairs", () => {
		const { workspace } = seededWorkspace();
		const weighted = setRowWeights(workspace, [3, 1]);
		expect(weighted.rowWeights).toEqual([0.75, 0.25]);
		expect(setRowWeights(workspace, [1, 0])).toBe(workspace);
		expect(setRowWeights(workspace, [1])).toBe(workspace);
		expect(setRowWeights(workspace, [1, Number.POSITIVE_INFINITY])).toBe(workspace);
	});

	it("normalizes finite pane weights without overflowing their total", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		const splitWorkspace = split(seeded, chatId, "right");
		const [first, second] = splitWorkspace.panes;
		const weighted = setPaneWeights(
			splitWorkspace,
			0,
			new Map([
				[first!.id, Number.MAX_VALUE],
				[second!.id, Number.MAX_VALUE],
			]),
		);
		expect(weighted.panes.map((pane) => pane.weight)).toEqual([0.5, 0.5]);
		const proportional = setPaneWeights(
			splitWorkspace,
			0,
			new Map([
				[first!.id, Number.MAX_VALUE / 2],
				[second!.id, Number.MAX_VALUE],
			]),
		);
		expect(proportional.panes.map((pane) => pane.weight)).toEqual([1 / 3, 2 / 3]);
	});

	it("normalizes finite row weights without overflowing their total", () => {
		const { workspace } = seededWorkspace();
		expect(setRowWeights(workspace, [Number.MAX_VALUE, Number.MAX_VALUE]).rowWeights).toEqual([0.5, 0.5]);
		expect(setRowWeights(workspace, [Number.MAX_VALUE / 2, Number.MAX_VALUE]).rowWeights).toEqual([1 / 3, 2 / 3]);
	});
});
