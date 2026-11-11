// @vitest-environment jsdom

import type { SessionSummary } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchivedConversationsPanel } from "../src/renderer/components/ArchivedConversationsPanel.tsx";
import { SettingsDialog } from "../src/renderer/components/SettingsDialog.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

type List = MetisDesktopApi["listArchivedConversations"];
type Page = Awaited<ReturnType<List>>;
const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const session: SessionSummary = {
	sessionId: ROOT,
	name: "Archived project",
	cwd: null,
	cwdOrigin: "managed",
	state: "idle",
	archived: true,
	unread: false,
	createdAt: "2026-11-01T10:00:00Z",
	updatedAt: "2026-11-05T10:00:00Z",
	useMemory: true,
	contributeMemory: true,
};
const page: Page = {
	conversations: [
		{ kind: "session", session },
		{ kind: "agent", session, agentId: CHILD, name: "Image researcher", updatedAt: session.updatedAt },
	],
	nextCursor: null,
};
const empty: Page = { conversations: [], nextCursor: null };
const roots: Root[] = [];
function button(root: ParentNode, label: string) {
	const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
		(node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
	);
	if (!found) throw new Error(`Missing button: ${label}`);
	return found;
}
async function click(root: ParentNode, label: string) {
	await act(async () => button(root, label).click());
}
async function mount(list = vi.fn<List>().mockResolvedValue(page), ready = true) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const api = { listArchivedConversations: list };
	const onDeleteSession = vi.fn<(session: SessionSummary) => Promise<void>>().mockResolvedValue(undefined);
	const onDeleteAgent = vi
		.fn<(rootSessionId: string, agentId: string) => Promise<void>>()
		.mockResolvedValue(undefined);
	const onRestoreConversation = vi
		.fn<(session: SessionSummary, agentId?: string) => Promise<void>>()
		.mockResolvedValue(undefined);
	const render = async (serverReady = ready) => {
		await act(async () =>
			root.render(
				<ArchivedConversationsPanel
					api={api}
					serverReady={serverReady}
					onDeleteSession={onDeleteSession}
					onDeleteAgent={onDeleteAgent}
					onRestoreConversation={onRestoreConversation}
				/>,
			),
		);
	};
	await render();
	return { container, list, onDeleteSession, onDeleteAgent, onRestoreConversation, render };
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	await setLocale("en");
});
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("archived conversations settings", () => {
	it("loads only one bounded metadata page and identifies roots and children", async () => {
		const { container, list } = await mount();
		expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 30 });
		expect(container.querySelectorAll(".archived-conversation-row")).toHaveLength(2);
		expect(container.textContent).toContain("Main conversation");
		expect(container.textContent).toContain("Subagent conversation");
		expect(container.textContent).toContain("From Archived project");
		expect(button(container, "Restore Archived project").disabled).toBe(false);
		expect(button(container, "Restore Image researcher").disabled).toBe(false);
	});
	it("restores a root immediately without deletion confirmation and reloads page one", async () => {
		const list = vi
			.fn<List>()
			.mockResolvedValueOnce({ ...page, nextCursor: "second" })
			.mockResolvedValueOnce(page)
			.mockResolvedValue(empty);
		const { container, onRestoreConversation, onDeleteSession } = await mount(list);
		await click(container, "Next page");
		await click(container, "Restore Archived project");
		expect(onRestoreConversation).toHaveBeenCalledExactlyOnceWith(session, undefined);
		expect(onDeleteSession).not.toHaveBeenCalled();
		expect(container.querySelector("dialog")).toBeNull();
		expect(list).toHaveBeenLastCalledWith({ limit: 30 });
		expect(container.textContent).toContain("No archived conversations");
	});
	it("restores children using their root and child identities", async () => {
		const { container, onRestoreConversation } = await mount();
		await click(container, "Restore Image researcher");
		expect(onRestoreConversation).toHaveBeenCalledExactlyOnceWith(session, CHILD);
	});
	it("blocks competing actions during restoration and permits retry after an inline error", async () => {
		const { container, list, onRestoreConversation } = await mount();
		let reject!: (cause: Error) => void;
		onRestoreConversation.mockImplementationOnce(
			() =>
				new Promise((_, fail) => {
					reject = fail;
				}),
		);
		await click(container, "Restore Archived project");
		expect(button(container, "Restore Archived project").disabled).toBe(true);
		expect(button(container, "Delete Image researcher").disabled).toBe(true);
		expect(button(container, "Refresh").disabled).toBe(true);
		await click(container, "Restore Archived project");
		expect(onRestoreConversation).toHaveBeenCalledOnce();
		await act(async () => reject(new Error("Could not restore the conversation")));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not restore");
		expect(container.querySelectorAll(".archived-conversation-row")).toHaveLength(2);
		expect(list).toHaveBeenCalledOnce();
		await click(container, "Restore Archived project");
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(onRestoreConversation).toHaveBeenCalledTimes(2);
	});

	it("requests subsequent pages only on navigation and supports returning to the first page", async () => {
		const list = vi
			.fn<List>()
			.mockImplementation(async (input) =>
				input.cursor
					? { conversations: [page.conversations[1]!], nextCursor: null }
					: { ...page, nextCursor: "next-page" },
			);
		const { container } = await mount(list);
		expect(list).toHaveBeenCalledTimes(1);
		await click(container, "Next page");
		expect(list).toHaveBeenLastCalledWith({ cursor: "next-page", limit: 30 });
		expect(container.querySelectorAll(".archived-conversation-row")).toHaveLength(1);
		expect(container.textContent).toContain("Page 2");
		await click(container, "Previous page");
		expect(list).toHaveBeenLastCalledWith({ limit: 30 });
		expect(container.querySelectorAll(".archived-conversation-row")).toHaveLength(2);
	});
	it("waits for the server, then presents an empty page", async () => {
		const { container, list, render } = await mount(vi.fn<List>().mockResolvedValue(empty), false);
		expect(list).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Waiting for connection");
		await render(true);
		expect(container.textContent).toContain("No archived conversations");
		expect(list).toHaveBeenCalledOnce();
	});
	it("shows a load error and retries without enumerating other conversations", async () => {
		const { container, list } = await mount(
			vi.fn<List>().mockRejectedValueOnce(new Error("Archive unavailable")).mockResolvedValue(page),
		);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Archive unavailable");
		await click(container, "Retry");
		expect(list).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).toContain("Archived project");
	});
	it("confirms root deletion with a cascade notice, then refreshes from the first page", async () => {
		const list = vi
			.fn<List>()
			.mockResolvedValueOnce({ ...page, nextCursor: "page-two" })
			.mockResolvedValueOnce(page)
			.mockResolvedValue(empty);
		const { container, onDeleteSession, onDeleteAgent } = await mount(list);
		await click(container, "Next page");
		await click(container, "Delete Archived project");
		const dialog = container.querySelector("dialog")!;
		expect(dialog.textContent).toContain("all of its subagent conversations");
		expect(onDeleteSession).not.toHaveBeenCalled();
		await click(dialog, "Delete conversation");
		expect(onDeleteSession).toHaveBeenCalledExactlyOnceWith(session);
		expect(onDeleteAgent).not.toHaveBeenCalled();
		expect(list).toHaveBeenLastCalledWith({ limit: 30 });
		expect(container.querySelector("dialog")).toBeNull();
		expect(container.querySelectorAll(".archived-conversation-row")).toHaveLength(0);
		expect(container.textContent).toContain("No archived conversations");
	});
	it("routes child deletion with its root and child IDs and does not delete the parent", async () => {
		const { container, list, onDeleteAgent, onDeleteSession } = await mount();
		list.mockResolvedValue({ conversations: [page.conversations[0]!], nextCursor: null });
		await click(container, "Delete Image researcher");
		await click(container.querySelector("dialog")!, "Delete conversation");
		expect(onDeleteAgent).toHaveBeenCalledExactlyOnceWith(ROOT, CHILD);
		expect(onDeleteSession).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Archived project");
		expect(container.textContent).not.toContain("Image researcher");
	});
	it("retains the confirmation and row on failure, and guards duplicate deletion", async () => {
		let reject!: (cause: Error) => void;
		const { container, onDeleteSession, list } = await mount();
		onDeleteSession.mockImplementation(
			() =>
				new Promise((_, fail) => {
					reject = fail;
				}),
		);
		await click(container, "Delete Archived project");
		await click(container.querySelector("dialog")!, "Delete conversation");
		expect(button(container.querySelector("dialog")!, "Deleting…").disabled).toBe(true);
		expect(button(container.querySelector("dialog")!, "Cancel").disabled).toBe(true);
		await act(async () => reject(new Error("Save unsaved files first")));
		expect(container.querySelector('dialog [role="alert"]')?.textContent).toContain("Save unsaved files first");
		expect(container.querySelectorAll(".archived-conversation-row")).toHaveLength(2);
		expect(list).toHaveBeenCalledOnce();
		expect(onDeleteSession).toHaveBeenCalledOnce();
		await click(container.querySelector("dialog")!, "Cancel");
		expect(container.querySelector("dialog")).toBeNull();
	});
	it("mounts and requests the archive only after entering its settings page", async () => {
		const listArchivedConversations = vi.fn<List>().mockResolvedValue(page);
		const onDeleteSession = vi.fn().mockResolvedValue(undefined);
		const onRestoreConversation = vi.fn().mockResolvedValue(undefined);
		const api = {
			listArchivedConversations,
			getProfile: vi.fn().mockResolvedValue({
				generatedAt: session.updatedAt,
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
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () =>
			root.render(
				<SettingsDialog
					api={api}
					generalPreferences={{
						motion: "system",
						chatFont: "anthropic-serif",
						codeFont: "system-sans",
						contentFontSize: "15px",
					}}
					onClose={vi.fn()}
					onGeneralPreferencesChange={vi.fn()}
					onThemeChange={vi.fn()}
					onDeleteSession={onDeleteSession}
					onDeleteAgent={vi.fn()}
					onRestoreConversation={onRestoreConversation}
					serverReady
					theme="dark"
				/>,
			),
		);
		expect(listArchivedConversations).not.toHaveBeenCalled();
		await click(container, "Archived conversations");
		expect(listArchivedConversations).toHaveBeenCalledExactlyOnceWith({ limit: 30 });
		await click(container, "Restore Archived project");
		expect(onRestoreConversation).toHaveBeenCalledWith(session, undefined);
		await click(container, "Delete Archived project");
		await click(container.querySelector("dialog")!, "Delete conversation");
		expect(onDeleteSession).toHaveBeenCalledWith(session);
	});
});
