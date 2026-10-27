import { describe, expect, it } from "vitest";
import {
	loadWorkspaceLayout,
	restoreWorkspaceLayout,
	saveWorkspaceLayout,
	serializeWorkspaceLayout,
	WORKSPACE_LAYOUT_STORAGE_KEY,
} from "../src/renderer/workspace-layout-storage.ts";
import {
	addTab,
	type ChatTab,
	chatTab,
	type SessionWorkspace,
	setPaneWeights,
	setRowWeights,
	splitTab,
	type WorkspaceTab,
} from "../src/renderer/workspace-tabs.ts";

function memoryStorage(initial: Record<string, string> = {}): Storage {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
		clear: () => map.clear(),
		key: () => null,
		length: map.size,
	} as Storage;
}

function seeded(): { workspace: SessionWorkspace; chats: ChatTab[] } {
	const first = chatTab("session-a");
	const second = { ...chatTab("session-b"), agentId: "agent-1", agentName: "Helper" } as ChatTab;
	const workspace = addTab(addTab({ ...baseWorkspace() }, first), second);
	return { workspace, chats: [first, second] };
}

function baseWorkspace(): SessionWorkspace {
	return {
		panes: [{ id: "pane-1", row: 0, tabs: [], activeId: "" }],
		activePaneId: "pane-1",
		nextNumber: 1,
		tools: new Map(),
	};
}

const live = () => true;

describe("serializeWorkspaceLayout", () => {
	it("writes the versioned whitelist schema with chat references, weights and placeholders", () => {
		const { workspace } = seeded();
		const withTools = addTab(workspace, {
			kind: "terminal",
			id: "term-1",
			sessionId: "session-a",
			title: "term",
			cwd: "/tmp",
		} as WorkspaceTab);
		const stored = JSON.parse(serializeWorkspaceLayout(withTools));
		expect(stored.version).toBe(1);
		expect(stored.activePaneId).toBe("pane-1");
		expect(stored.nextNumber).toBe(1);
		expect(stored.panes).toHaveLength(1);
		expect(stored.panes[0].chats).toEqual([
			{ sessionId: "session-a" },
			{ sessionId: "session-b", agentId: "agent-1", agentName: "Helper" },
		]);
		// Tool tabs never leave the runtime.
		expect(JSON.stringify(stored)).not.toContain("term-1");
	});

	it("excludes draft (null-session) chat tabs", () => {
		let workspace = baseWorkspace();
		workspace = addTab(workspace, chatTab(null));
		workspace = addTab(workspace, chatTab("session-a"));
		const stored = JSON.parse(serializeWorkspaceLayout(workspace));
		expect(stored.panes[0].chats).toEqual([{ sessionId: "session-a" }]);
	});

	it("skips contentless panes unless they are placeholders", () => {
		let workspace = baseWorkspace();
		workspace = addTab(workspace, chatTab("session-a"));
		const split = splitTab(workspace, workspace.panes[0]!.tabs[0]!.id, workspace.panes[0]!.id, "right");
		const stored = JSON.parse(serializeWorkspaceLayout(split));
		expect(stored.panes).toHaveLength(2);
		expect(stored.panes.some((pane: { placeholder?: boolean }) => pane.placeholder === true)).toBe(true);
		const empty = JSON.parse(serializeWorkspaceLayout(baseWorkspace()));
		expect(empty.panes).toEqual([]);
	});

	it("keeps weights, row weights and active references", () => {
		const { workspace } = seeded();
		const withWeights = setRowWeights(setPaneWeights(workspace, 0, new Map([["pane-1", 2]])), [2, 1]);
		const stored = JSON.parse(serializeWorkspaceLayout(withWeights));
		expect(stored.panes[0].weight).toBe(1);
		expect(stored.rowWeights).toEqual([2 / 3, 1 / 3]);
	});

	it("falls back to a saved pane when the active pane contains only a draft", () => {
		const savedChat = chatTab("session-a");
		const draft = chatTab(null);
		const seeded = addTab(addTab(baseWorkspace(), savedChat), draft);
		const split = splitTab(seeded, draft.id, seeded.activePaneId, "right");
		const raw = serializeWorkspaceLayout(split);
		const restored = restoreWorkspaceLayout(raw, live);
		expect(restored).not.toBeNull();
		expect(restored!.panes).toHaveLength(1);
		expect(restored!.activePaneId).toBe(seeded.activePaneId);
		expect(restored!.panes[0]!.tabs.map((tab) => tab.sessionId)).toEqual(["session-a"]);
		expect(JSON.parse(raw).activePaneId).toBe(seeded.activePaneId);
		// Persistence never moves or removes the editable draft in the live workspace.
		expect(split.panes.find((pane) => pane.id === split.activePaneId)!.tabs[0]).toBe(draft);
	});

	it("promotes the saved bottom row when the top row contains only a draft", () => {
		const savedChat = chatTab("session-a");
		const draft = chatTab(null);
		const seeded = addTab(addTab(baseWorkspace(), savedChat), draft);
		const split = setRowWeights(splitTab(seeded, savedChat.id, seeded.activePaneId, "down"), [3, 1]);
		const raw = serializeWorkspaceLayout(split);
		const restored = restoreWorkspaceLayout(raw, live);
		expect(restored).not.toBeNull();
		expect(restored!.panes).toHaveLength(1);
		expect(restored!.panes[0]!.row).toBe(0);
		expect(restored!.panes[0]!.tabs.map((tab) => tab.sessionId)).toEqual(["session-a"]);
		expect(restored!.activePaneId).toBe(split.activePaneId);
		expect(restored!.rowWeights).toBeUndefined();
		expect(JSON.parse(raw).rowWeights).toBeUndefined();
		expect(split.panes.find((pane) => pane.tabs[0] === savedChat)!.row).toBe(1);
		expect(split.rowWeights).toEqual([0.75, 0.25]);
	});
});

describe("restoreWorkspaceLayout", () => {
	it("round-trips structure, weights, placeholders and chat references with fresh tab ids", () => {
		const { workspace, chats } = seeded();
		const split = splitTab(workspace, chats[0]!.id, workspace.panes[0]!.id, "right");
		const restored = restoreWorkspaceLayout(serializeWorkspaceLayout(split), live);
		expect(restored).not.toBeNull();
		expect(restored!.panes.map((pane) => [pane.id, pane.row, pane.placeholder ?? false])).toEqual([
			["pane-1", 0, false],
			[expect.any(String), 0, false],
		]);
		expect(restored!.panes[0]!.tabs.map((tab) => tab.sessionId)).toEqual(["session-b"]);
		expect(restored!.panes[1]!.tabs.map((tab) => (tab.kind === "chat" ? tab.agentId : undefined))).toEqual([
			undefined,
		]);
		expect(restored!.panes.every((pane) => pane.tabs.every((tab) => tab.id !== chats[0]!.id))).toBe(true);
		expect(restored!.activePaneId).toBe(split.activePaneId);
		expect(restored!.tools.size).toBe(0);
	});

	it("round-trips an explicit empty placeholder pane", () => {
		let workspace = baseWorkspace();
		workspace = addTab(workspace, chatTab("session-a"));
		const split = splitTab(workspace, workspace.panes[0]!.tabs[0]!.id, workspace.panes[0]!.id, "down");
		const restored = restoreWorkspaceLayout(serializeWorkspaceLayout(split), live)!;
		const placeholder = restored.panes.find((pane) => pane.placeholder === true);
		expect(placeholder).toBeDefined();
		expect(placeholder!.tabs).toEqual([]);
	});

	it("drops chats whose session is no longer live", () => {
		const { workspace } = seeded();
		const restored = restoreWorkspaceLayout(serializeWorkspaceLayout(workspace), (id) => id === "session-a");
		expect(restored!.panes[0]!.tabs.map((tab) => tab.sessionId)).toEqual(["session-a"]);
	});

	it("keeps the active reference when earlier saved chats are no longer live", () => {
		const { workspace, chats } = seeded();
		const withThirdChat = addTab(workspace, chatTab("session-c"), workspace.activePaneId, false);
		const restored = restoreWorkspaceLayout(serializeWorkspaceLayout(withThirdChat), (id) => id !== "session-a")!;
		const pane = restored.panes[0]!;
		expect(pane.tabs.map((tab) => tab.sessionId)).toEqual(["session-b", "session-c"]);
		expect(pane.tabs.find((tab) => tab.id === pane.activeId)?.sessionId).toBe(chats[1]!.sessionId);
	});

	it("returns null when every pane loses its content and no placeholder remains", () => {
		const { workspace } = seeded();
		expect(restoreWorkspaceLayout(serializeWorkspaceLayout(workspace), () => false)).toBeNull();
	});

	it("returns null for corrupt input", () => {
		const { workspace } = seeded();
		const raw = JSON.parse(serializeWorkspaceLayout(workspace)) as Record<string, unknown>;
		const broken = (mutate: (value: Record<string, unknown>) => void) => {
			const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
			mutate(copy);
			return restoreWorkspaceLayout(JSON.stringify(copy), live);
		};
		expect(restoreWorkspaceLayout("not json", live)).toBeNull();
		expect(restoreWorkspaceLayout(null, live)).toBeNull();
		expect(
			broken((value) => {
				value.version = 2;
			}),
		).toBeNull();
		expect(
			broken((value) => {
				value.activePaneId = "ghost";
			}),
		).toBeNull();
		expect(
			broken((value) => {
				value.nextNumber = 0;
			}),
		).toBeNull();
		expect(
			broken((value) => {
				value.panes = [];
			}),
		).toBeNull();
		const panesOf = (value: Record<string, unknown>) => value.panes as Record<string, unknown>[];
		expect(
			broken((value) => {
				panesOf(value)[0]!.weight = -1;
			}),
		).toBeNull();
		expect(
			broken((value) => {
				value.panes = [panesOf(raw)[0]!, panesOf(raw)[0]!];
			}),
		).toBeNull();
		expect(
			broken((value) => {
				(panesOf(value)[0]!.chats as Record<string, unknown>[])[0]!.sessionId = "";
			}),
		).toBeNull();
		expect(
			broken((value) => {
				(panesOf(value)[0]!.chats as Record<string, unknown>[])[0]!.agentId = 5;
			}),
		).toBeNull();
		expect(
			broken((value) => {
				value.rowWeights = [1, -2];
			}),
		).toBeNull();
	});

	it("returns null when a row would hold more than three panes", () => {
		const raw = {
			version: 1,
			activePaneId: "p1",
			nextNumber: 2,
			panes: [0, 1, 2, 3].map((index) => ({
				id: `p${index + 1}`,
				row: 0,
				activeIndex: 0,
				chats: [{ sessionId: "session-a" }],
			})),
		};
		expect(restoreWorkspaceLayout(JSON.stringify(raw), live)).toBeNull();
	});
});

describe("loadWorkspaceLayout / saveWorkspaceLayout", () => {
	it("saves under the versioned key and loads a matching layout back", () => {
		const { workspace } = seeded();
		const storage = memoryStorage();
		saveWorkspaceLayout(storage, workspace);
		expect(storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(serializeWorkspaceLayout(workspace));
		const loaded = loadWorkspaceLayout(storage, live);
		expect(loaded!.panes[0]!.tabs.map((tab) => tab.sessionId)).toEqual(["session-a", "session-b"]);
	});

	it("loads null for missing, corrupt or throwing storage", () => {
		expect(loadWorkspaceLayout(memoryStorage(), live)).toBeNull();
		expect(loadWorkspaceLayout(memoryStorage({ [WORKSPACE_LAYOUT_STORAGE_KEY]: "junk" }), live)).toBeNull();
		const throwing = {
			getItem: () => {
				throw new Error("unavailable");
			},
		} as unknown as Storage;
		expect(loadWorkspaceLayout(throwing, live)).toBeNull();
	});

	it("swallows storage failures on save without touching other keys", () => {
		const { workspace } = seeded();
		const failing = {
			setItem: () => {
				throw new Error("quota");
			},
			getItem: () => null,
		} as unknown as Storage;
		expect(() => saveWorkspaceLayout(failing, workspace)).not.toThrow();
	});
});
