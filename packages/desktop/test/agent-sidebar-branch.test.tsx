// @vitest-environment jsdom
import type { AgentSummaryView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSidebarBranch } from "../src/renderer/components/AgentSidebarBranch.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const DATE = "2026-10-23T00:00:00.000Z";
function agent(id: string, parent = "root"): AgentSummaryView {
	return {
		agentId: id,
		name: id,
		parentSessionId: parent,
		rootSessionId: "root",
		agentPath: parent === "root" ? [id] : [parent, id],
		depth: parent === "root" ? 1 : 2,
		agentType: "worker",
		status: "done",
		archived: false,
		tasks: [],
		createdAt: DATE,
		updatedAt: DATE,
	};
}
const roots: Root[] = [];
async function mount(
	attentionAgentIds?: ReadonlySet<string>,
	activeAgentId?: string,
	unreadableAgentCount?: number,
	agents = [agent("child"), agent("grandchild", "child"), agent("sibling")],
) {
	const api = {
		listAgents: vi.fn().mockResolvedValue({
			agents,
			nextAfterAgentId: null,
			unreadableAgentCount,
		}),
		subscribe: vi.fn(() => () => undefined),
	} as unknown as MetisDesktopApi;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onOpen = vi.fn();
	const onOpenRoot = vi.fn();
	const render = async (active = activeAgentId, attention = attentionAgentIds) =>
		act(async () =>
			root.render(
				<AgentSidebarBranch
					sessionId="root"
					navigation={{
						api,
						active: active ? { sessionId: "root", agentId: active, name: active } : null,
						attentionAgentIds: attention,
						onOpen,
					}}
				>
					{(toggle) => (
						<div className="session-row">
							<button type="button" className="session-button" onClick={onOpenRoot}>
								Root task
							</button>
							<div className="session-actions">
								<button type="button">Root actions</button>
							</div>
							{toggle}
						</div>
					)}
				</AgentSidebarBranch>,
			),
		);
	await render();
	return { container, api, onOpen, onOpenRoot, render };
}
function expectDrawer(element: Element, open: boolean): HTMLElement {
	const drawer = element.closest<HTMLElement>(".agent-sidebar-drawer");
	expect(drawer).not.toBeNull();
	expect(drawer?.getAttribute("data-open")).toBe(String(open));
	expect(drawer?.getAttribute("aria-hidden")).toBe(String(!open));
	expect(drawer?.hasAttribute("inert")).toBe(!open);
	return drawer!;
}
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	localStorage.clear();
	await setLocale("en");
});
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
});
describe("AgentSidebarBranch", () => {
	it("keeps readable conversations navigable and reports unreadable entries", async () => {
		const { container, onOpen } = await mount(undefined, undefined, 1);
		expect(container.textContent).toContain("Unreadable agents: 1");
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
		await act(async () => container.querySelector<HTMLButtonElement>('button[title^="sibling"]')!.click());
		expect(onOpen).toHaveBeenCalledWith({ sessionId: "root", agentId: "sibling", name: "sibling" });
	});
	it("keeps pending child interactions visible when the root branch is collapsed", async () => {
		const { container } = await mount(new Set(["grandchild"]));
		expect(container.querySelector('button[title^="grandchild"] i.attention')).not.toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".agent-root-toggle")!.click());
		expect(container.querySelector(".agent-sidebar-summary i.attention")).not.toBeNull();
		expect(container.querySelector(".agent-sidebar-summary")?.getAttribute("aria-description")).toContain(
			"Needs attention: 1",
		);
	});
	it("places the root toggle after the actions inside the row without opening either conversation", async () => {
		const { container, onOpen, onOpenRoot } = await mount();
		const row = container.querySelector(".session-row")!;
		const toggle = row.querySelector<HTMLButtonElement>(".agent-root-toggle")!;
		expect(toggle).not.toBeNull();
		expect(row.querySelector(".session-actions")?.nextElementSibling).toBe(toggle);
		const childRow = container.querySelector(".agent-sidebar-row")!;
		expect(childRow.lastElementChild?.className).toBe("agent-sidebar-toggle");
		await act(async () => toggle.click());
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(onOpenRoot).not.toHaveBeenCalled();
		expect(onOpen).not.toHaveBeenCalled();
	});
	it("shows attention for a previously read running agent without waiting for a terminal result", async () => {
		localStorage.setItem("metis.agent-seen.pending", DATE);
		const { container, render } = await mount(new Set(["pending"]), undefined, undefined, [
			{ ...agent("pending"), status: "running" },
		]);
		expect(container.querySelector('button[title^="pending"] i.attention')).not.toBeNull();
		await render("pending");
		expect(container.querySelector('button[title^="pending"] i.running')).not.toBeNull();
		expect(container.querySelector('button[title^="pending"]')?.getAttribute("aria-description")).toBe(
			"Needs attention",
		);
	});
	it("uses the main session dot states for running, attention, completed and failed agents", async () => {
		const agents = [
			{ ...agent("running"), status: "running" as const },
			{ ...agent("queued"), status: "queued" as const },
			{ ...agent("attention"), status: "running" as const },
			agent("completed"),
			{ ...agent("failed"), status: "failed" as const },
			{ ...agent("stopped"), status: "stopped" as const },
			{ ...agent("paused"), runControl: "user_paused" as const },
			{ ...agent("interrupted"), runControl: "interrupted" as const },
		];
		const { container } = await mount(new Set(["attention"]), undefined, undefined, agents);
		for (const [id, state] of [
			["running", "running"],
			["queued", "running"],
			["attention", "attention"],
			["completed", "completed"],
			["failed", "failed"],
		]) {
			expect(container.querySelector(`button[title^="${id}"] .session-button-title > i.${state}`)).not.toBeNull();
		}
		for (const id of ["stopped", "paused", "interrupted"]) {
			expect(container.querySelector(`button[title^="${id}"] i`)?.className).toBe("");
		}
		expect(container.querySelector('button[title^="paused"]')?.getAttribute("aria-description")).toContain("Paused");
		expect(container.querySelector('button[title^="queued"]')?.getAttribute("aria-description")).toContain("Queued");
		expect(container.querySelector(".agent-sidebar-unread, .agent-sidebar-status, .is-spinning")).toBeNull();
	});
	it("clears viewed terminal notifications but keeps the current running dot breathing", async () => {
		const agents = [
			agent("completed"),
			{ ...agent("failed"), status: "failed" as const },
			{ ...agent("running"), status: "running" as const },
		];
		const { container, render } = await mount(new Set(["running"]), undefined, undefined, agents);
		await render("completed");
		expect(container.querySelector('button[title^="completed"] i')?.className).toBe("");
		await render("failed");
		expect(container.querySelector('button[title^="failed"] i')?.className).toBe("");
		expect(container.querySelector('button[title^="completed"] i')?.className).toBe("");
		await render("running");
		expect(container.querySelector('button[title^="running"] i.running')).not.toBeNull();
		expect(container.querySelector('button[title^="running"] i.attention')).toBeNull();
	});
	it("retains a single summary dot and accessible aggregate status while collapsed", async () => {
		const { container } = await mount(undefined, undefined, undefined, [
			agent("complete"),
			{ ...agent("running"), status: "running" as const },
			{ ...agent("failed"), status: "failed" as const },
		]);
		await act(async () => container.querySelector<HTMLButtonElement>(".agent-root-toggle")!.click());
		const summary = container.querySelector<HTMLButtonElement>(".agent-sidebar-summary")!;
		expect(summary.querySelectorAll("i")).toHaveLength(1);
		expect(summary.querySelector("i.failed")).not.toBeNull();
		expect(summary.title).toContain("Running: 1");
		expect(summary.title).toContain("Completed: 1");
		expect(summary.title).toContain("Failed: 1");
		expect(summary.title).toContain("Unread: 3");
	});
	it("retains a tab stop after collapsing the active grandchild", async () => {
		const { container } = await mount(undefined, "grandchild");
		await act(async () => container.querySelector<HTMLButtonElement>(".agent-sidebar-toggle")!.click());
		expect(container.querySelectorAll('.agent-sidebar-open[tabindex="0"]')).toHaveLength(1);
	});
	it("keeps root tree nodes mounted while closing and reopening without reloading or navigating", async () => {
		const { container, api, onOpen, onOpenRoot } = await mount();
		const tree = container.querySelector('[role="tree"]')!;
		const child = container.querySelector('button[title^="child"]')!;
		const toggle = container.querySelector<HTMLButtonElement>(".agent-root-toggle")!;
		const summary = container.querySelector(".agent-sidebar-summary")!;
		expectDrawer(tree, true);
		expectDrawer(summary, false);
		await act(async () => toggle.click());
		expect(container.querySelector('[role="tree"]')).toBe(tree);
		expect(container.querySelector('button[title^="child"]')).toBe(child);
		expectDrawer(tree, false);
		expectDrawer(summary, true);
		await act(async () => toggle.click());
		expect(container.querySelector('[role="tree"]')).toBe(tree);
		expect(container.querySelector('button[title^="child"]')).toBe(child);
		expectDrawer(tree, true);
		expectDrawer(summary, false);
		expect(api.listAgents).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
		expect(onOpenRoot).not.toHaveBeenCalled();
	});
	it("keeps nested nodes mounted and skips closed descendants during keyboard navigation", async () => {
		const { container, onOpen } = await mount();
		const child = container.querySelector<HTMLButtonElement>('button[title^="child"]')!;
		const grandchild = container.querySelector<HTMLButtonElement>('button[title^="grandchild"]')!;
		const sibling = container.querySelector<HTMLButtonElement>('button[title^="sibling"]')!;
		const parent = child.closest('[role="treeitem"]')!;
		const toggle = parent.querySelector<HTMLButtonElement>(":scope > .agent-sidebar-row > .agent-sidebar-toggle")!;
		await act(async () => toggle.click());
		expect(parent.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector('button[title^="grandchild"]')).toBe(grandchild);
		expectDrawer(grandchild, false);
		await act(async () => {
			child.focus();
			child.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
		});
		expect(document.activeElement).toBe(sibling);
		await act(async () => {
			child.focus();
			child.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
		});
		expectDrawer(grandchild, true);
		expect(parent.getAttribute("aria-expanded")).toBe("true");
		await act(async () => child.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
		expect(document.activeElement).toBe(grandchild);
		expect(onOpen).not.toHaveBeenCalled();
	});
	it("keeps the latest drawer state after rapid repeated toggles", async () => {
		const { container, api, onOpen, onOpenRoot } = await mount();
		const toggle = container.querySelector<HTMLButtonElement>(".agent-root-toggle")!;
		const tree = container.querySelector('[role="tree"]')!;
		for (let count = 0; count < 5; count++) await act(async () => toggle.click());
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expectDrawer(tree, false);
		expect(container.querySelector('[role="tree"]')).toBe(tree);
		expect(localStorage.getItem("metis.agent-tree.root")).toBe("closed");
		await act(async () => toggle.click());
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expectDrawer(tree, true);
		expect(localStorage.getItem("metis.agent-tree.root")).toBe("open");
		expect(api.listAgents).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
		expect(onOpenRoot).not.toHaveBeenCalled();
	});
	it("restores a closed root preference and expands its retained tree from the summary", async () => {
		localStorage.setItem("metis.agent-tree.root", "closed");
		const { container, api, onOpen } = await mount();
		const toggle = container.querySelector<HTMLButtonElement>(".agent-root-toggle")!;
		const tree = container.querySelector('[role="tree"]')!;
		const summary = container.querySelector<HTMLButtonElement>(".agent-sidebar-summary")!;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expectDrawer(tree, false);
		expectDrawer(summary, true);
		await act(async () => summary.click());
		expect(container.querySelector('[role="tree"]')).toBe(tree);
		expectDrawer(tree, true);
		expectDrawer(summary, false);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(api.listAgents).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
	});
	it("restores nested collapse preferences when the sidebar is remounted", async () => {
		const first = await mount();
		await act(async () => first.container.querySelector<HTMLButtonElement>(".agent-sidebar-toggle")!.click());
		expectDrawer(first.container.querySelector('button[title^="grandchild"]')!, false);
		const restored = await mount();
		expect(restored.container.querySelector('button[title^="child"]')).not.toBeNull();
		expectDrawer(restored.container.querySelector('button[title^="grandchild"]')!, false);
	});
	it("nests descendants under the parent and opens the actual child target", async () => {
		const { container, onOpen } = await mount();
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
		const grandchild = container.querySelector<HTMLButtonElement>('button[title^="grandchild"]')!;
		await act(async () => grandchild.click());
		expect(onOpen).toHaveBeenCalledWith({ sessionId: "root", agentId: "grandchild", name: "grandchild" });
	});
	it("navigates the visible tree with arrow keys and preserves collapse preference", async () => {
		const { container } = await mount();
		const child = container.querySelector<HTMLButtonElement>('button[title^="child"]')!;
		await act(async () => {
			child.focus();
			child.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
		});
		expect(document.activeElement?.getAttribute("title")).toContain("grandchild");
		await act(async () => container.querySelector<HTMLButtonElement>(".agent-root-toggle")!.click());
		expectDrawer(container.querySelector('[role="tree"]')!, false);
		expect(container.textContent).toContain("3 agents");
		expect(localStorage.getItem("metis.agent-tree.root")).toBe("closed");
	});
});
