// @vitest-environment jsdom

import type { SessionSummary } from "@arcmind/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "../src/renderer/components/SkillsPanel.tsx";
import { AppStore } from "../src/renderer/store/app-store.ts";

function session(sessionId: string, cwd: string): SessionSummary {
	return {
		sessionId,
		mode: "chat",
		cwdOrigin: "user-selected",
		cwd,
		name: sessionId,
		createdAt: "2026-07-29T00:00:00.000Z",
		updatedAt: "2026-07-29T00:00:00.000Z",
		state: "idle",
		archived: false,
	};
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("SkillsPanel", () => {
	it("filters public sources and deduplicates projects without opening a task", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const store = new AppStore();
		store.setSessions({
			sessions: [session("one", "/work/shared"), session("two", "/work/shared")],
			nextAfterSessionId: null,
		});
		const api = {
			listSkills: vi.fn().mockResolvedValue({
				skills: [
					{ name: "bundled", description: "Bundled", source: "system" },
					{ name: "personal", description: "Personal", source: "user" },
					{ name: "repository", description: "Repository", source: "project" },
				],
			}),
		};
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<SkillsPanel api={api} serverReady state={store.getSnapshot()} />));

		await act(async () => button(container, "System").click());
		await flush();
		expect(api.listSkills).toHaveBeenLastCalledWith({ cwd: null });
		expect(container.querySelector(".skills-list")?.textContent).toContain("bundled");
		expect(container.querySelector(".skills-list")?.textContent).not.toContain("personal");

		await act(async () => button(container.querySelector(".skills-breadcrumbs")!, "Skills").click());
		await act(async () => button(container, "Project").click());
		await act(async () => button(container, "Chat").click());
		expect(container.querySelectorAll('[aria-label="shared"]')).toHaveLength(1);
		await act(async () => button(container, "shared").click());
		await flush();
		expect(api.listSkills).toHaveBeenLastCalledWith({ cwd: "/work/shared" });
		expect(container.querySelector(".skills-list")?.textContent).toContain("repository");
		await act(async () => root.unmount());
	});

	it("shows the illustrated empty state and retries a failed request", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const api = {
			listSkills: vi.fn()
				.mockRejectedValueOnce(new Error("offline"))
				.mockResolvedValueOnce({ skills: [] }),
		};
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<SkillsPanel api={api} serverReady state={new AppStore().getSnapshot()} />));

		await act(async () => button(container, "User").click());
		await flush();
		expect(container.textContent).toContain("Couldn’t load Skills");
		await act(async () => button(container, "Retry").click());
		await flush();
		expect(container.textContent).toContain("No user skills");
		expect(container.querySelector<HTMLImageElement>(".skills-empty-state img")?.src).toContain("skills-empty-state");
		await act(async () => root.unmount());
	});
});
