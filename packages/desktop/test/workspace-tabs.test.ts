import { describe, expect, it } from "vitest";
import {
	activateTab,
	activePane,
	addTab,
	chatTab,
	defaultWorkspace,
	findChatTab,
	findTabLocation,
	focusedChatTab,
	moveTab,
	paneForTab,
	removeTab,
	removeTabs,
	type SessionWorkspace,
	splitTabRight,
	type TerminalTab,
	workspaceTabs,
} from "../src/renderer/workspace-tabs.ts";

const SESSION = "session-a";

function terminal(id: string): TerminalTab {
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
		let workspace = addTab(seeded, terminal("t1"));
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
		let workspace = addTab(seeded, terminal("t1"));
		workspace = addTab(workspace, terminal("t2"));
		workspace = removeTab(workspace, "t2");
		expect(tabs(workspace)).toEqual([chatId, "t1"]);
		expect(activePane(workspace).activeId).toBe("t1");
	});

	it("allows closing a chat tab", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		const workspace = removeTab(addTab(seeded, terminal("t1")), chatId);
		expect(tabs(workspace)).toEqual(["t1"]);
	});
});

describe("splitTabRight", () => {
	it("moves the tab into a new pane to the right", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, terminal("t1"));
		workspace = splitTabRight(workspace, "t1");
		expect(workspace.panes).toHaveLength(2);
		expect(tabs(workspace, 0)).toEqual([chatId]);
		expect(tabs(workspace, 1)).toEqual(["t1"]);
		expect(workspace.activePaneId).toBe(workspace.panes[1]!.id);
		expect(workspace.panes[1]!.activeId).toBe("t1");
	});
});

describe("moveTab", () => {
	it("moves a tab between panes and collapses the empty source pane", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, terminal("t1"));
		workspace = splitTabRight(workspace, "t1");
		workspace = addTab(workspace, terminal("t2"), workspace.panes[1]!.id);
		// move chat into the right pane so the left pane becomes empty
		workspace = moveTab(workspace, chatId, workspace.panes[1]!.id);
		expect(workspace.panes).toHaveLength(1);
		expect(tabs(workspace)).toEqual(["t1", "t2", chatId]);
	});

	it("reorders within the same pane", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, terminal("t1"));
		workspace = addTab(workspace, terminal("t2"));
		workspace = moveTab(workspace, "t2", workspace.panes[0]!.id, 1);
		expect(tabs(workspace)).toEqual([chatId, "t2", "t1"]);
	});
});

describe("workspaceTabs / findTabLocation / paneForTab", () => {
	it("locates tabs across panes", () => {
		const { workspace: seeded, chatId } = seededWorkspace();
		let workspace = addTab(seeded, terminal("t1"));
		workspace = splitTabRight(workspace, "t1");
		expect(workspaceTabs(workspace).map((tab) => tab.id)).toEqual([chatId, "t1"]);
		expect(findTabLocation(workspace, "t1")).toEqual({ paneIndex: 1, tabIndex: 0 });
		expect(paneForTab(workspace, "t1")!.id).toBe(workspace.panes[1]!.id);
	});
});

describe("removeTabs", () => {
	it("removes a batch of tabs", () => {
		const { workspace: seeded } = seededWorkspace();
		let workspace = addTab(seeded, terminal("t1"));
		workspace = addTab(workspace, terminal("t2"));
		workspace = removeTabs(workspace, new Set(["t1", "t2"]));
		expect(workspaceTabs(workspace).map((tab) => tab.kind)).toEqual(["chat"]);
	});
});
