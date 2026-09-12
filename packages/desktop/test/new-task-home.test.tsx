// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskHome } from "../src/renderer/components/NewTaskHome.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { getHomeStarters } from "../src/renderer/new-task-home-content.ts";
import { DEFAULT_PROFILE_IDENTITY, saveProfileIdentity } from "../src/renderer/profile-identity.ts";

vi.mock("../src/renderer/components/SideRays.tsx", () => ({
	SideRays: () => null,
}));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
				{...extra}
				projectControl={<button data-testid="project-control" type="button">Choose project</button>}
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
		["chat", ".composer-chat", 9],
		["code", ".composer-chat", 6],
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

	it("smoothly reveals the starter cards and uses auto motion when reduced", async () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		const { container, root } = await renderHome("chat", { reducedMotion: true });
		try {
			await act(async () => container.querySelector<HTMLButtonElement>(".new-task-home-discovery")!.click());
			expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
		} finally {
			await act(async () => root.unmount());
		}
	});
});
