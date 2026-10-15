// @vitest-environment jsdom

import { act } from "react";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSessionGroup } from "../src/renderer/components/SessionSidebar.tsx";
import { NewTaskHome, recentProjectsFromGroups } from "../src/renderer/components/NewTaskHome.tsx";
import { HomeProjectPicker } from "../src/renderer/components/HomeProjectPicker.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { getHomeStarters } from "../src/renderer/new-task-home-content.ts";
import { DEFAULT_PROFILE_IDENTITY, saveProfileIdentity } from "../src/renderer/profile-identity.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function project(cwd: string, name: string, updatedAt: string): ProjectSessionGroup {
	return {
		cwd,
		mode: "code",
		name,
		pinned: false,
		sessions: [{
			sessionId: `${name}-session`,
			mode: "code",
			cwdOrigin: "user-selected",
			cwd,
			createdAt: updatedAt,
			updatedAt,
			state: "idle",
			archived: false,
			unread: false,
		}],
	};
}

function props(mode: "chat" | "code") {
	return {
		busy: false,
		folder: mode === "code" ? "/work/metis" : null,
		folderLocked: false,
		mode,
		modelControl: <button type="button">Model</button>,
		permissionControl: <span>Auto</span>,
		reducedMotion: false,
		onChooseFolder: vi.fn().mockResolvedValue(undefined),
		onManageMcp: vi.fn(),
		onManageSkills: vi.fn(),
		onPickFiles: vi.fn().mockResolvedValue([]),
		onResolveDroppedFiles: vi.fn().mockReturnValue([]),
		onSubmit: vi.fn().mockResolvedValue(undefined),
		skills: [],
		thinkingControl: <button type="button">Thinking</button>,
	};
}

async function renderHome(mode: "chat" | "code", extra: Record<string, unknown> = {}) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<NewTaskHome
				{...props(mode)}
				projectControl={<button data-testid="project-control" type="button">Choose project</button>}
				{...extra}
			/>,
		);
	});
	return { container, root };
}

describe("NewTaskHome", () => {
	beforeEach(async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		await setLocale("en", localStorage);
		saveProfileIdentity(DEFAULT_PROFILE_IDENTITY);
	});

	afterEach(() => {
		document.body.replaceChildren();
		saveProfileIdentity(DEFAULT_PROFILE_IDENTITY);
		vi.restoreAllMocks();
	});

	it.each([
		["chat", ".composer-chat", 4],
		["code", ".composer-chat", 4],
	] as const)("uses the shared home structure for %s mode", async (mode, composerSelector, starterCount) => {
		const { container, root } = await renderHome(mode);
		try {
			const home = container.querySelector<HTMLElement>(".new-task-home");
			expect(home?.dataset.mode).toBe(mode);
			expect(container.querySelector(composerSelector)).not.toBeNull();
			expect(container.querySelectorAll(".new-task-starter")).toHaveLength(starterCount);

			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			const projectControl = container.querySelector<HTMLElement>("[data-testid='project-control']")!;
			expect(editor.compareDocumentPosition(projectControl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it.each(["chat", "code"] as const)("keeps the workspace bar and its %s actions visible", async (mode) => {
		const onChooseFolder = vi.fn(async () => undefined);
		const onClearFolder = vi.fn();
		const onCreateProject = vi.fn();
		const { container, root } = await renderHome(mode, {
			folder: "/work/metis",
			projectControl: <HomeProjectPicker busy={false} folder="/work/metis" folderLocked={false} mode={mode}
				onChooseFolder={onChooseFolder} onClearFolder={onClearFolder} onCreateProject={onCreateProject} />,
		});
		try {
			const bar = container.querySelector('.new-task-home-project-control[aria-label="Workspace"]')!;
			const choose = bar.querySelector<HTMLButtonElement>('[aria-label="Choose workspace"]')!;
			expect(choose.title).toBe("/work/metis");
			expect(choose.textContent).toBe("metis");
			await act(async () => choose.click());
			expect(onChooseFolder).toHaveBeenCalledOnce();
			const action = bar.querySelector<HTMLButtonElement>(mode === "code"
				? '[aria-label="Create a new project"]' : '[aria-label="No project context"]')!;
			await act(async () => action.click());
			expect(mode === "code" ? onCreateProject : onClearFolder).toHaveBeenCalledOnce();
		} finally { await act(async () => root.unmount()); }
	});

	it.each([{ busy: true, folderLocked: false }, { busy: false, folderLocked: true }])("preserves locked workspace controls (%j)", async (status) => {
		const onChooseFolder = vi.fn(async () => undefined);
		const { container, root } = await renderHome("code", {
			...status,
			projectControl: <HomeProjectPicker {...status} folder="/work/metis" mode="code"
				onChooseFolder={onChooseFolder} onCreateProject={vi.fn()} />,
		});
		try {
			for (const button of container.querySelectorAll<HTMLButtonElement>(".home-project-picker button")) expect(button.disabled).toBe(true);
			expect(onChooseFolder).not.toHaveBeenCalled();
		} finally { await act(async () => root.unmount()); }
	});

	it("expands additional tasks without changing the draft, then prefills without submitting", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
		const onSubmit = vi.fn(async () => undefined);
		const { container, root } = await renderHome("chat", { onSubmit });
		try {
			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => {
				editor.textContent = "My draft";
				editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
			});
			const more = container.querySelector<HTMLButtonElement>(".new-task-more-trigger")!;
			expect(more.getAttribute("aria-expanded")).toBe("false");
			await act(async () => more.click());
			expect(editor.textContent).toBe("My draft");
			expect(more.getAttribute("aria-expanded")).toBe("true");
			expect(container.querySelectorAll(".new-task-starter")).toHaveLength(9);
			await act(async () => {
				container.querySelector<HTMLButtonElement>('[data-starter-id="document"]')!.click();
				await flush();
			});
			expect(editor.textContent).toContain(getHomeStarters("chat")[4]!.prompt);
			expect(document.activeElement).toBe(editor);
			expect(more.getAttribute("aria-expanded")).toBe("false");
			expect(onSubmit).not.toHaveBeenCalled();
		} finally { await act(async () => root.unmount()); }
	});

	it("returns keyboard focus to More tasks when Escape closes the additional tasks", async () => {
		const { container, root } = await renderHome("code");
		try {
			const more = container.querySelector<HTMLButtonElement>(".new-task-more-trigger")!;
			await act(async () => more.click());
			const last = container.querySelector<HTMLButtonElement>('[data-starter-id="performance"]')!;
			last.focus();
			await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
			expect(more.getAttribute("aria-expanded")).toBe("false");
			expect(document.activeElement).toBe(more);
		} finally { await act(async () => root.unmount()); }
	});

	it("opens the knowledge sidebar through the plus menu before the first message", async () => {
		const openKnowledge = vi.fn();
		const prepare = vi.fn(async () => "prepared-session");
		const api = {
			listKnowledgeLibraries: vi.fn(async () => ({ libraries: [] })),
			getSessionKnowledge: vi.fn(async () => ({ libraries: [] })),
		} as unknown as MetisDesktopApi;
		const { container, root } = await renderHome("chat", {
			knowledge: { api, onPrepare: prepare, onOpen: openKnowledge },
		});
		try {
			await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
			await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Knowledge")!.click());
			expect(prepare).not.toHaveBeenCalled();
			expect(api.getSessionKnowledge).not.toHaveBeenCalled();
			await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Open knowledge sidebar")!.click());
			expect(prepare).toHaveBeenCalledOnce();
			expect(openKnowledge).toHaveBeenCalledWith("prepared-session");
			expect(container.querySelector('[role="menu"]')).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});
	it("prepares the draft only when explicitly linking a library and never sends a turn", async () => {
		const library = { id: "library", name: "Product", path: "/Users/test/Product" };
		const prepare = vi.fn(async () => "prepared-session");
		const setLinks = vi.fn(async () => ({ libraries: [library] }));
		const onSubmit = vi.fn(async () => undefined);
		const api = {
			listKnowledgeLibraries: vi.fn(async () => ({ libraries: [library] })),
			getSessionKnowledge: vi.fn(async () => ({ libraries: [] })),
			setSessionKnowledge: setLinks,
		} as unknown as MetisDesktopApi;
		const { container, root } = await renderHome("chat", { knowledge: { api, onPrepare: prepare, onOpen: vi.fn() }, onSubmit });
		try {
			await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
			await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Knowledge")!.click());
			expect(prepare).not.toHaveBeenCalled();
			await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!.click());
			expect(prepare).toHaveBeenCalledOnce();
			expect(setLinks).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "prepared-session", libraryIds: ["library"] }));
			expect(onSubmit).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
		}
	});
	it("orders and deduplicates recent Code projects by their latest conversation", () => {
		const recent = recentProjectsFromGroups([
			project("/work/older", "Older", "2026-09-09T08:00:00.000Z"),
			project("/work/metis/", "Metis old path", "2026-09-10T08:00:00.000Z"),
			project("/work/newest", "Newest", "2026-09-12T08:00:00.000Z"),
			project("/work/metis", "Metis", "2026-09-11T08:00:00.000Z"),
			project("/work/fourth", "Fourth", "2026-09-08T08:00:00.000Z"),
		]);

		expect(recent.map(({ cwd, name }) => ({ cwd, name }))).toEqual([
			{ cwd: "/work/newest", name: "Newest" },
			{ cwd: "/work/metis", name: "Metis" },
			{ cwd: "/work/older", name: "Older" },
		]);
	});

	it("selects a recent Code project and returns focus to the composer", async () => {
		const onSelectRecentProject = vi.fn();
		const recentProjects = recentProjectsFromGroups([
			project("/work/metis", "Metis", "2026-09-12T08:00:00.000Z"),
			project("/work/website", "Website", "2026-09-11T08:00:00.000Z"),
		]);
		const { container, root } = await renderHome("code", { onSelectRecentProject, recentProjects });
		try {
			const rows = [...container.querySelectorAll<HTMLButtonElement>(".new-task-recent-project")];
			expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Metis", "Website"]);
			expect(container.querySelector(".new-task-starters-label")).toBeNull();

			await act(async () => rows[1]!.click());
			expect(onSelectRecentProject).toHaveBeenCalledWith("/work/website");
			expect(document.activeElement).toBe(container.querySelector("#composer-input"));
		} finally {
			await act(async () => root.unmount());
		}
	});

	it.each(["chat", "code"] as const)("includes the configured profile name in the %s greeting", async (mode) => {
		const { container, root } = await renderHome(mode);
		try {
			expect(container.querySelector(".new-task-home-heading h1")?.textContent)
				.toContain(DEFAULT_PROFILE_IDENTITY.displayName);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps a personalized greeting stable while the home rerenders", async () => {
		saveProfileIdentity({ displayName: "Ada", avatarDataUrl: null });
		const { container, root } = await renderHome("chat");
		try {
			const heading = container.querySelector(".new-task-home-heading h1")!;
			const firstText = heading.textContent;
			expect(firstText).toContain("Ada");
			await act(async () => {
				root.render(<NewTaskHome {...props("chat")} projectControl={<span>Project</span>} />);
			});
			expect(heading.textContent).toBe(firstText);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it.each([false, true])("prefills a mode starter and returns to the home top (reduced motion: %s)", async (reducedMotion) => {
		const scrollTo = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollTo", {
			configurable: true,
			value: scrollTo,
		});
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		const { container, root } = await renderHome("code", { onSubmit, reducedMotion });
		try {
			const starter = getHomeStarters("code")[0]!;
			await act(async () => {
				container.querySelector<HTMLButtonElement>(`[data-starter-id="${starter.id}"]`)!.click();
				await flush();
			});

			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			expect(editor.textContent).toContain(starter.prompt);
			expect(document.activeElement).toBe(editor);
			expect(scrollTo).toHaveBeenCalledWith({ behavior: reducedMotion ? "auto" : "smooth", top: 0 });
			expect(scrollTo.mock.instances[0]).toBe(container.querySelector(".new-task-home-scroll"));
			expect(onSubmit).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps task shortcuts disabled while the new task is preparing", async () => {
		const { container, root } = await renderHome("chat", { busy: true });
		try {
			for (const button of container.querySelectorAll<HTMLButtonElement>(".new-task-starter, .new-task-more-trigger")) {
				expect(button.disabled).toBe(true);
			}
		} finally {
			await act(async () => root.unmount());
		}
	});
});
