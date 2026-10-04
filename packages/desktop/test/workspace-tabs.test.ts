import { describe, expect, it } from "vitest";
import {
	activateTab,
	activePane,
	addTab,
	CHAT_TAB_ID,
	defaultWorkspace,
	findTabLocation,
	moveTab,
	paneForTab,
	removeTab,
	removeTabs,
	type SessionWorkspace,
	splitTabRight,
	type TerminalTab,
	workspaceTabs,
} from "../src/renderer/workspace-tabs.ts";

function terminal(id: string): TerminalTab {
	return { kind: "terminal", id, title: id, cwd: "/tmp" };
}

function tabs(workspace: SessionWorkspace, paneIndex = 0): string[] {
	return workspace.panes[paneIndex]!.tabs.map((tab) => tab.id);
}

describe("defaultWorkspace", () => {
	it("starts with a single pane containing only the chat tab", () => {
		const workspace = defaultWorkspace();
		expect(workspace.panes).toHaveLength(1);
		expect(tabs(workspace)).toEqual([CHAT_TAB_ID]);
		expect(activePane(workspace).activeId).toBe(CHAT_TAB_ID);
	});
});

describe("addTab / activateTab", () => {
	it("appends to the active pane and activates the new tab", () => {
		let workspace = addTab(defaultWorkspace(), terminal("t1"));
		expect(tabs(workspace)).toEqual([CHAT_TAB_ID, "t1"]);
		expect(activePane(workspace).activeId).toBe("t1");
		workspace = activateTab(workspace, CHAT_TAB_ID);
		expect(activePane(workspace).activeId).toBe(CHAT_TAB_ID);
	});

	it("activating an unknown tab is a no-op", () => {
		const workspace = defaultWorkspace();
		expect(activateTab(workspace, "nope")).toBe(workspace);
	});
});

describe("removeTab", () => {
	it("activates the neighbor tab when the active tab closes", () => {
		let workspace = addTab(defaultWorkspace(), terminal("t1"));
		workspace = addTab(workspace, terminal("t2"));
		workspace = removeTab(workspace, "t2");
		expect(tabs(workspace)).toEqual([CHAT_TAB_ID, "t1"]);
		expect(activePane(workspace).activeId).toBe("t1");
	});
});

describe("splitTabRight", () => {
	it("moves the tab into a new pane to the right", () => {
		let workspace = addTab(defaultWorkspace(), terminal("t1"));
		workspace = splitTabRight(workspace, "t1");
		expect(workspace.panes).toHaveLength(2);
		expect(tabs(workspace, 0)).toEqual([CHAT_TAB_ID]);
		expect(tabs(workspace, 1)).toEqual(["t1"]);
		expect(workspace.activePaneId).toBe(workspace.panes[1]!.id);
		expect(workspace.panes[1]!.activeId).toBe("t1");
	});
});

describe("moveTab", () => {
	it("moves a tab between panes and collapses the empty source pane", () => {
		let workspace = addTab(defaultWorkspace(), terminal("t1"));
		workspace = splitTabRight(workspace, "t1");
		workspace = addTab(workspace, terminal("t2"), workspace.panes[1]!.id);
		// move chat into the right pane so the left pane becomes empty
		workspace = moveTab(workspace, CHAT_TAB_ID, workspace.panes[1]!.id);
		expect(workspace.panes).toHaveLength(1);
		expect(tabs(workspace)).toEqual(["t1", "t2", CHAT_TAB_ID]);
	});

	it("reorders within the same pane", () => {
		let workspace = addTab(defaultWorkspace(), terminal("t1"));
		workspace = addTab(workspace, terminal("t2"));
		workspace = moveTab(workspace, "t2", workspace.panes[0]!.id, 1);
		expect(tabs(workspace)).toEqual([CHAT_TAB_ID, "t2", "t1"]);
	});
});

describe("workspaceTabs / findTabLocation / paneForTab", () => {
	it("locates tabs across panes", () => {
		let workspace = addTab(defaultWorkspace(), terminal("t1"));
		workspace = splitTabRight(workspace, "t1");
		expect(workspaceTabs(workspace).map((tab) => tab.id)).toEqual([CHAT_TAB_ID, "t1"]);
		expect(findTabLocation(workspace, "t1")).toEqual({ paneIndex: 1, tabIndex: 0 });
		expect(paneForTab(workspace, "t1")!.id).toBe(workspace.panes[1]!.id);
	});
});

describe("removeTabs", () => {
	it("removes a batch of tabs and keeps the chat tab", () => {
		let workspace = addTab(defaultWorkspace(), terminal("t1"));
		workspace = addTab(workspace, terminal("t2"));
		workspace = removeTabs(workspace, new Set(["t1", "t2"]));
		expect(tabs(workspace)).toEqual([CHAT_TAB_ID]);
	});
});
