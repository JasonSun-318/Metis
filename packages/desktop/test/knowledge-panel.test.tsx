// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/components/Composer.tsx";
import { KnowledgePanel } from "../src/renderer/components/KnowledgePanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const a = { id: "11111111-1111-4111-8111-111111111111", name: "Product", path: "/Users/test/产品资料" };
const b = { id: "22222222-2222-4222-8222-222222222222", name: "Tech", path: "/Users/test/技术笔记" };
const sessionId = "33333333-3333-4333-8333-333333333333";
let roots: Root[] = [];
beforeEach(async () => {
	localStorage.clear();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount();
	});
	roots = [];
	document.body.replaceChildren();
	delete document.documentElement.dataset.motion;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function fixture(libraries = [a, b], initialLinks = [] as typeof libraries) {
	let linked = initialLinks;
	const api = {
		listKnowledgeLibraries: vi.fn(async () => ({ libraries })),
		getSessionKnowledge: vi.fn(async () => ({ libraries: linked })),
		setSessionKnowledge: vi.fn(async (input: { libraryIds: string[] }) => {
			linked = libraries.filter((item) => input.libraryIds.includes(item.id));
			return { libraries: linked };
		}),
		selectProjectFolder: vi.fn(async () => a.path),
		registerKnowledgeLibrary: vi.fn(async () => {
			libraries.push(a);
			return a;
		}),
		removeKnowledgeLibrary: vi.fn(async ({ libraryId }: { libraryId: string }) => {
			libraries = libraries.filter((library) => library.id !== libraryId);
			linked = linked.filter((library) => library.id !== libraryId);
			return { libraries };
		}),
		scanKnowledgeLibrary: vi.fn(async (_input: { libraryId: string }) => ({
			notes: [
				{
					path: "Home.md",
					title: "Home",
					links: [{ target: "topic/deep/Note", kind: "wiki" as const, path: "topic/deep/Note.md" }],
				},
				{ path: "topic/deep/Note.md", title: "Deep note", links: [] },
			],
			edges: [{ source: "Home.md", target: "topic/deep/Note.md" }],
			warnings: [],
		})),
		readKnowledgeNote: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content: path === "Home.md" ? "# Home\n[[topic/deep/Note|Read deep note]]" : "# Deep note\nNested content",
		})),
		resolveKnowledgeResource: vi.fn(async () => ({
			libraryId: a.id,
			path: "topic/deep/Note.md",
			kind: "note" as const,
			mimeType: "text/markdown",
			revision: "r1",
			absolutePath: "/library/topic/deep/Note.md",
			rootPath: "/library",
		})),
	};
	return api;
}
async function mount(api: ReturnType<typeof fixture>, control = false) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			control ? (
				<Composer
					disabled={false}
					running={false}
					onInterrupt={async () => undefined}
					onSubmit={async () => undefined}
					knowledge={{ api: api as unknown as MetisDesktopApi, sessionId, onOpen: vi.fn() }}
				/>
			) : (
				<KnowledgePanel api={api as unknown as MetisDesktopApi} sessionId={sessionId} visible />
			),
		);
	});
	return container;
}
async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}
async function openGraphNote(container: Element, title: string) {
	await act(async () => {
		container
			.querySelector(`[data-knowledge-path][aria-label="${title}"]`)!
			.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	});
}
function prepareGraphGeometry() {
	document.documentElement.dataset.motion = "reduced";
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 360, 600));
	vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 360, 600));
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("cancelAnimationFrame", () => {});
}
function graphView(container: Element) {
	return container.querySelector(".knowledge-graph-viewport")!.getAttribute("transform");
}
async function chooseLibrary(container: Element, name: string) {
	await click(button(container, "Choose knowledge library"));
	await click(document.querySelector(`.knowledge-library-options [role="menuitemradio"][aria-label="${name}"]`)!);
}
async function openRemoval(container: Element) {
	await click(button(container, "Remove knowledge libraries"));
	return document.querySelector('[role="dialog"]')!;
}
function libraryCheckbox(dialog: Element, name: string) {
	return dialog.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${name}"]`)!;
}
async function removeLibraries(container: Element, names: string[]) {
	const dialog = await openRemoval(container);
	for (const name of names) await click(libraryCheckbox(dialog, name));
	await click(button(dialog, `Remove ${names.length} libraries`));
	return dialog;
}
function button(container: Element, text: string) {
	return [...container.querySelectorAll("button")].find(
		(item) => item.getAttribute("aria-label") === text || item.textContent?.trim() === text,
	)!;
}
describe("Knowledge sidebar and conversation links", () => {
	it("viewing a directory never links it", async () => {
		const api = fixture();
		const container = await mount(api);
		expect(container.textContent).toContain(a.path);
		expect(api.setSessionKnowledge).not.toHaveBeenCalled();
		expect(button(container, "Link to conversation")).toBeUndefined();
	});
	it("opens nested notes from graph nodes and navigates their wikilinks", async () => {
		const api = fixture();
		const container = await mount(api);
		await openGraphNote(container, "Home");
		expect(container.textContent).toContain("Read deep note");
		await click(container.querySelector('a[href="#topic%2Fdeep%2FNote"]')!);
		expect(api.readKnowledgeNote).toHaveBeenLastCalledWith({ libraryId: a.id, path: "topic/deep/Note.md" });
		expect(container.textContent).toContain("Nested content");
	});
	it("keeps graph selection, layout and camera when returning from reading or the note list", async () => {
		prepareGraphGeometry();
		const api = fixture();
		const container = await mount(api);
		const home = container.querySelector('[data-knowledge-path="Home.md"]')!;
		const initialView = graphView(container);
		await click(home);
		expect(api.readKnowledgeNote).not.toHaveBeenCalled();
		expect(home.getAttribute("aria-pressed")).toBe("true");
		await click(button(container, "Zoom in"));
		const exploredView = graphView(container);
		const position = home.getAttribute("transform");
		expect(exploredView).not.toBe(initialView);
		await openGraphNote(container, "Home");
		await click(button(container, "Back to knowledge library"));
		expect(graphView(container)).toBe(exploredView);
		expect(container.querySelector('[data-knowledge-path="Home.md"]')?.getAttribute("transform")).toBe(position);
		expect(container.querySelector('[data-knowledge-path="Home.md"]')?.getAttribute("aria-pressed")).toBe("true");
		await click(button(container, "Knowledge notes"));
		await click(button(container, "Graph"));
		expect(graphView(container)).toBe(exploredView);
		expect(container.querySelector('[data-knowledge-path="Home.md"]')?.getAttribute("aria-pressed")).toBe("true");
	});
	it("isolates each library graph and gives a re-registered directory a fresh view", async () => {
		prepareGraphGeometry();
		const api = fixture();
		const container = await mount(api);
		const initialView = graphView(container);
		await click(container.querySelector('[data-knowledge-path="Home.md"]')!);
		await click(button(container, "Zoom in"));
		const productView = graphView(container);
		await chooseLibrary(container, "Tech");
		expect(graphView(container)).toBe(initialView);
		expect(container.querySelector('[data-knowledge-path="Home.md"]')?.getAttribute("aria-pressed")).toBe("false");
		await chooseLibrary(container, "Product");
		expect(graphView(container)).toBe(productView);
		expect(container.querySelector('[data-knowledge-path="Home.md"]')?.getAttribute("aria-pressed")).toBe("true");
		await removeLibraries(container, ["Product"]);
		const replacement = { ...a, id: "44444444-4444-4444-8444-444444444444" };
		api.listKnowledgeLibraries.mockResolvedValue({ libraries: [replacement, b] });
		api.registerKnowledgeLibrary.mockResolvedValue(replacement);
		await click(button(container, "New knowledge library"));
		expect(graphView(container)).toBe(initialView);
		expect(container.querySelector('[data-knowledge-path="Home.md"]')?.getAttribute("aria-pressed")).toBe("false");
	});
	it("keeps the full graph mounted for search and retains exploration when the sidebar is hidden", async () => {
		prepareGraphGeometry();
		const api = fixture();
		const container = await mount(api);
		await click(button(container, "Zoom in"));
		const exploredView = graphView(container);
		const input = container.querySelector<HTMLInputElement>('[aria-label="Search knowledge notes"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "missing note");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(container.querySelector(".knowledge-graph-canvas")).not.toBeNull();
		expect(container.querySelectorAll("[data-knowledge-path]")).toHaveLength(2);
		expect(container.textContent).toContain("No matching notes");
		await click(button(container, "Clear search"));
		await act(async () => {
			roots[0]!.render(
				<KnowledgePanel api={api as unknown as MetisDesktopApi} sessionId={sessionId} visible={false} />,
			);
		});
		await act(async () => {
			roots[0]!.render(<KnowledgePanel api={api as unknown as MetisDesktopApi} sessionId={sessionId} visible />);
		});
		expect(graphView(container)).toBe(exploredView);
	});
	it("discards graph exploration when a registered library changes its root directory", async () => {
		prepareGraphGeometry();
		const api = fixture();
		const container = await mount(api);
		const initialView = graphView(container);
		await click(container.querySelector('[data-knowledge-path="Home.md"]')!);
		const scope = container.querySelector<HTMLSelectElement>('[aria-label="Graph scope"]')!;
		await act(async () => {
			scope.value = "1";
			scope.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await click(button(container, "Zoom in"));
		expect(graphView(container)).not.toBe(initialView);
		api.listKnowledgeLibraries.mockResolvedValue({ libraries: [{ ...a, path: "/Users/test/moved-library" }, b] });
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(container.textContent).toContain("/Users/test/moved-library");
		expect(graphView(container)).toBe(initialView);
		expect(container.querySelector<HTMLSelectElement>('[aria-label="Graph scope"]')?.value).toBe("all");
		expect(container.querySelector('[data-knowledge-path="Home.md"]')?.getAttribute("aria-pressed")).toBe("false");
	});
	it("ignores a previous library's late scan after switching to another library", async () => {
		const api = fixture();
		const container = await mount(api);
		const techGraph = {
			notes: [{ path: "Tech.md", title: "Tech only", links: [] }],
			edges: [],
			warnings: [],
		};
		let resolvePrevious!: (graph: typeof techGraph) => void;
		api.scanKnowledgeLibrary.mockImplementation(({ libraryId }) =>
			libraryId === a.id
				? new Promise((resolve) => {
						resolvePrevious = resolve;
					})
				: Promise.resolve(techGraph),
		);
		await act(async () => window.dispatchEvent(new Event("focus")));
		await chooseLibrary(container, "Tech");
		expect(container.querySelector('[data-knowledge-path="Tech.md"]')).not.toBeNull();
		await act(async () => {
			resolvePrevious({ notes: [{ path: "Old.md", title: "Stale scan", links: [] }], edges: [], warnings: [] });
		});
		expect(container.querySelector('[data-knowledge-path="Tech.md"]')).not.toBeNull();
		expect(container.querySelector('[data-knowledge-path="Old.md"]')).toBeNull();
	});
	it("retains other linked libraries when linking or unlinking from the composer", async () => {
		const api = fixture([a, b], [a]);
		const container = await mount(api, true);
		expect(container.querySelector(".composer-box")?.textContent).not.toContain("Knowledge");
		await click(container.querySelector('[aria-label="Add to message"]')!);
		await click(button(container, "Knowledge"));
		await click(container.querySelector('[role="menuitemcheckbox"][aria-label="Tech"]')!);
		expect(api.setSessionKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({ libraryIds: [a.id, b.id] }));
		expect(container.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]')).toHaveLength(2);
		await click(container.querySelector('[role="menuitemcheckbox"][aria-label="Product"]')!);
		expect(api.setSessionKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({ libraryIds: [b.id] }));
	});
	it("shows note read failures and allows returning to the graph", async () => {
		const api = fixture();
		api.readKnowledgeNote.mockRejectedValue(new Error("File is no longer readable"));
		const container = await mount(api);
		await openGraphNote(container, "Home");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("File is no longer readable");
		expect(container.querySelector('output, [role="status"]')).toBeNull();
		await click(button(container, "Back to knowledge library"));
		expect(container.querySelector('[aria-label="Knowledge graph"]')).not.toBeNull();
	});
	it("retries a failed note read for the same path", async () => {
		const api = fixture();
		api.readKnowledgeNote.mockRejectedValueOnce(new Error("File is temporarily unavailable"));
		let resolveRetry!: (result: { path: string; content: string }) => void;
		api.readKnowledgeNote.mockImplementationOnce(
			() =>
				new Promise<{ path: string; content: string }>((resolve) => {
					resolveRetry = resolve;
				}),
		);
		const container = await mount(api);
		await openGraphNote(container, "Home");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("File is temporarily unavailable");
		await click(button(container, "Retry"));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelector("output")?.textContent).toContain("Loading");
		expect(api.readKnowledgeNote).toHaveBeenLastCalledWith({ libraryId: a.id, path: "Home.md" });
		await act(async () => {
			resolveRetry({ path: "Home.md", content: "# Home restored" });
		});
		expect(container.textContent).toContain("Home restored");
		expect(api.readKnowledgeNote).toHaveBeenCalledTimes(2);
	});
	it("does not let a stale note read replace another selected note", async () => {
		const api = fixture();
		let resolveHome!: (result: { path: string; content: string }) => void;
		api.readKnowledgeNote.mockImplementation(({ path }: { path: string }) =>
			path === "Home.md"
				? new Promise<{ path: string; content: string }>((resolve) => {
						resolveHome = resolve;
					})
				: Promise.resolve({ path, content: "# Deep note\nNested content" }),
		);
		const container = await mount(api);
		await openGraphNote(container, "Home");
		await click(button(container, "Back to knowledge library"));
		await openGraphNote(container, "Deep note");
		expect(container.textContent).toContain("Nested content");
		expect(api.readKnowledgeNote).toHaveBeenLastCalledWith({ libraryId: a.id, path: "topic/deep/Note.md" });
		await act(async () => {
			resolveHome({ path: "Home.md", content: "Stale Home content" });
		});
		expect(container.textContent).toContain("Nested content");
		expect(container.textContent).not.toContain("Stale Home content");
	});
	it("keeps the current note visible while polling reads its updated content", async () => {
		const api = fixture();
		const container = await mount(api);
		await openGraphNote(container, "Deep note");
		let resolveRead!: (result: { path: string; content: string }) => void;
		api.readKnowledgeNote.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRead = resolve;
				}),
		);
		vi.useFakeTimers();
		try {
			window.dispatchEvent(new Event("focus"));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(container.textContent).toContain("Nested content");
			expect(container.querySelector('output, [role="status"]')).toBeNull();
			await act(async () => {
				resolveRead({ path: "topic/deep/Note.md", content: "Updated content" });
			});
			expect(container.textContent).toContain("Updated content");
		} finally {
			vi.useRealTimers();
		}
	});
	it("dismisses the conversation library picker on Escape and outside clicks", async () => {
		const container = await mount(fixture(), true);
		const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!;
		await click(trigger);
		await click(button(container, "Knowledge"));
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(container.querySelector('[role="menuitemcheckbox"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await click(trigger);
		await click(button(container, "Knowledge"));
		await act(async () => {
			document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		});
		expect(container.querySelector('[role="menu"]')).toBeNull();
	});
	it("navigates the library submenu with the keyboard and returns to the parent", async () => {
		const container = await mount(fixture(), true);
		await click(container.querySelector('[aria-label="Add to message"]')!);
		const entry = button(container, "Knowledge");
		entry.focus();
		await act(async () => entry.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
		const rows = container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]');
		expect(document.activeElement).toBe(rows[0]);
		await act(async () => rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(document.activeElement).toBe(rows[1]);
		await act(async () => rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
		expect(container.querySelector('[role="menuitemcheckbox"]')).toBeNull();
		expect(document.activeElement).toBe(entry);
	});
	it("browses nested folders and expands matching notes when searching", async () => {
		const api = fixture();
		const container = await mount(api);
		await click(button(container, "Knowledge notes"));
		const folders = container.querySelectorAll<HTMLDetailsElement>(".knowledge-folder");
		expect(folders).toHaveLength(2);
		expect([...folders].every((folder) => !folder.open)).toBe(true);
		const input = container.querySelector<HTMLInputElement>('[aria-label="Search knowledge notes"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "deep");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect([...folders].every((folder) => folder.open)).toBe(true);
		expect(button(container, "Home")).toBeUndefined();
		await click(button(container, "Deep note"));
		expect(api.readKnowledgeNote).toHaveBeenLastCalledWith({ libraryId: a.id, path: "topic/deep/Note.md" });
		expect(container.querySelectorAll("h1")).toHaveLength(1);
	});
	it("shows a link error without discarding the previous selection", async () => {
		const api = fixture([a, b], [a]);
		api.setSessionKnowledge.mockRejectedValue(new Error("Saving links failed"));
		const container = await mount(api, true);
		await click(container.querySelector('[aria-label="Add to message"]')!);
		await click(button(container, "Knowledge"));
		await click(container.querySelector('[role="menuitemcheckbox"][aria-label="Tech"]')!);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Saving links failed");
		expect(
			container.querySelector('[role="menuitemcheckbox"][aria-label="Product"]')?.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			container.querySelector('[role="menuitemcheckbox"][aria-label="Tech"]')?.getAttribute("aria-checked"),
		).toBe("false");
	});
	it("selects an empty directory without creating content or linking automatically", async () => {
		const api = fixture([]);
		api.scanKnowledgeLibrary.mockResolvedValue({ notes: [], edges: [], warnings: [] });
		const container = await mount(api);
		await click(button(container, "New knowledge library"));
		expect(api.registerKnowledgeLibrary).toHaveBeenCalledWith(expect.objectContaining({ path: a.path }));
		expect(container.textContent).toContain("No usable content");
		expect(api.setSessionKnowledge).not.toHaveBeenCalled();
	});
	it("shows a visible new-library label in Chinese and keeps the existing directory flow", async () => {
		await setLocale("zh-CN");
		const api = fixture();
		const container = await mount(api);
		const create = container.querySelector<HTMLButtonElement>(".knowledge-create-button")!;
		expect(create.textContent?.trim()).toBe("新建知识库");
		const remove = button(container, "移除知识库");
		expect(remove).toBeDefined();
		await click(remove);
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog.textContent).toContain("本地目录和文件");
		await click(button(dialog, "取消"));
		await click(create);
		expect(api.selectProjectFolder).toHaveBeenCalledOnce();
		expect(api.registerKnowledgeLibrary).toHaveBeenCalledWith(expect.objectContaining({ path: a.path }));
		expect(api.setSessionKnowledge).not.toHaveBeenCalled();
	});
	it("opens a separate removal dialog without preselecting a library and cancels without changes", async () => {
		const api = fixture();
		const container = await mount(api);
		const trigger = button(container, "Remove knowledge libraries");
		trigger.focus();
		const dialog = await openRemoval(container);
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(dialog.textContent).toContain("Local directories and files are kept");
		expect(dialog.textContent).toContain(a.path);
		expect(dialog.textContent).toContain(b.path);
		expect(libraryCheckbox(dialog, "Product").checked).toBe(false);
		expect(libraryCheckbox(dialog, "Tech").checked).toBe(false);
		expect(button(dialog, "Remove 0 libraries").disabled).toBe(true);
		await click(libraryCheckbox(dialog, "Product"));
		await click(button(dialog, "Cancel"));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		expect(api.removeKnowledgeLibrary).not.toHaveBeenCalled();
		expect(button(container, "Choose knowledge library").textContent?.trim()).toBe("Product");
		const reopened = await openRemoval(container);
		expect(libraryCheckbox(reopened, "Product").checked).toBe(false);
		await act(async () => reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(api.removeKnowledgeLibrary).not.toHaveBeenCalled();
	});
	it("removes multiple checked libraries in order and clears their conversation links", async () => {
		const api = fixture([a, b], [a, b]);
		const container = await mount(api);
		await removeLibraries(container, ["Product", "Tech"]);
		expect(api.removeKnowledgeLibrary.mock.calls.map(([input]) => input.libraryId)).toEqual([a.id, b.id]);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(container.textContent).toContain("Your knowledge, in one place");
		expect(localStorage.getItem("metis.knowledge-view.v1")).toBeNull();
		expect(await api.getSessionKnowledge()).toEqual({ libraries: [] });
		expect(api.setSessionKnowledge).not.toHaveBeenCalled();
		expect(button(container, "Remove knowledge libraries").disabled).toBe(true);
	});
	it("keeps a removed library hidden when the follow-up catalog reload fails or resolves stale", async () => {
		const api = fixture([a, b], [a, b]);
		const container = await mount(api);
		let resolveStale!: (result: { libraries: (typeof a)[] }) => void;
		api.listKnowledgeLibraries.mockImplementationOnce(
			() =>
				new Promise<{ libraries: (typeof a)[] }>((resolve) => {
					resolveStale = resolve;
				}),
		);
		await act(async () => window.dispatchEvent(new Event("focus")));
		api.listKnowledgeLibraries.mockRejectedValue(new Error("Catalog refresh failed"));
		await removeLibraries(container, ["Product"]);
		expect(api.removeKnowledgeLibrary).toHaveBeenCalledWith({ libraryId: a.id, requestId: expect.any(String) });
		await act(async () => {
			resolveStale({ libraries: [a, b] });
		});
		expect(button(container, "Choose knowledge library").textContent?.trim()).toBe("Tech");
		expect(container.textContent).not.toContain("Product");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Catalog refresh failed");
		expect(container.textContent).toContain(b.path);
		expect(button(container, "New knowledge library").disabled).toBe(false);
	});
	it("closes a removal failure notice without replaying the removal or opening a directory picker", async () => {
		const api = fixture();
		api.removeKnowledgeLibrary.mockRejectedValue(new Error("Could not save knowledge directories"));
		const container = await mount(api);
		const dialog = await removeLibraries(container, ["Product"]);
		await click(button(dialog, "Cancel"));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save knowledge directories");
		expect(button(container, "Close")).toBeDefined();
		expect(button(container, "Retry")).toBeUndefined();
		await click(button(container, "Close"));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(api.removeKnowledgeLibrary).toHaveBeenCalledTimes(1);
		expect(api.removeKnowledgeLibrary).toHaveBeenCalledWith(expect.objectContaining({ libraryId: a.id }));
		expect(api.selectProjectFolder).not.toHaveBeenCalled();
		expect(button(container, "New knowledge library").disabled).toBe(false);
	});
	it("waits for each removal to finish before starting the next selected library", async () => {
		const api = fixture([a, b], [a, b]);
		const remove = api.removeKnowledgeLibrary.getMockImplementation()!;
		let finishFirst!: () => void;
		api.removeKnowledgeLibrary.mockImplementationOnce((input) =>
			new Promise<void>((resolve) => {
				finishFirst = resolve;
			}).then(() => remove(input)),
		);
		const container = await mount(api);
		const dialog = await removeLibraries(container, ["Product", "Tech"]);
		expect(api.removeKnowledgeLibrary.mock.calls.map(([input]) => input.libraryId)).toEqual([a.id]);
		expect(button(dialog, "Removing…").disabled).toBe(true);
		await act(async () => finishFirst());
		expect(api.removeKnowledgeLibrary.mock.calls.map(([input]) => input.libraryId)).toEqual([a.id, b.id]);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(container.textContent).toContain("Your knowledge, in one place");
	});
	it("keeps only failed and unattempted libraries selected after a partial batch and retries them", async () => {
		const c = { ...b, id: "55555555-5555-4555-8555-555555555555", name: "Research", path: "/Users/test/research" };
		const api = fixture([a, b, c], [a, b, c]);
		const remove = api.removeKnowledgeLibrary.getMockImplementation()!;
		api.removeKnowledgeLibrary
			.mockImplementationOnce(remove)
			.mockRejectedValueOnce(new Error("Tech could not be removed"));
		const container = await mount(api);
		const dialog = await openRemoval(container);
		for (const name of ["Product", "Tech", "Research"]) await click(libraryCheckbox(dialog, name));
		await click(button(dialog, "Remove 3 libraries"));
		expect(api.removeKnowledgeLibrary.mock.calls.map(([input]) => input.libraryId)).toEqual([a.id, b.id]);
		expect(dialog.textContent).toContain("Some knowledge libraries could not be removed. Try again.");
		expect(libraryCheckbox(dialog, "Product")).toBeNull();
		expect(libraryCheckbox(dialog, "Tech").checked).toBe(true);
		expect(libraryCheckbox(dialog, "Research").checked).toBe(true);
		expect(container.textContent).toContain("Tech could not be removed");
		await click(button(dialog, "Remove 2 libraries"));
		expect(api.removeKnowledgeLibrary.mock.calls.map(([input]) => input.libraryId)).toEqual([a.id, b.id, b.id, c.id]);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(container.textContent).toContain("Your knowledge, in one place");
	});
	it("removes a library from both the sidebar and open conversation links and selects the remaining library", async () => {
		const api = fixture([a, b], [a, b]);
		const container = await mount(api);
		const composer = await mount(api, true);
		await click(composer.querySelector('[aria-label="Add to message"]')!);
		await click(button(composer, "Knowledge"));
		expect(composer.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(2);
		await click(button(container, "Choose knowledge library"));
		const menu = document.querySelector(".knowledge-library-options")!;
		expect(menu.textContent).not.toContain("Remove");
		expect(menu.querySelector("button button")).toBeNull();
		await click(button(container, "Choose knowledge library"));
		await removeLibraries(container, ["Product"]);
		expect(api.removeKnowledgeLibrary).toHaveBeenCalledWith({ libraryId: a.id, requestId: expect.any(String) });
		expect(button(container, "Choose knowledge library").textContent?.trim()).toBe("Tech");
		expect(localStorage.getItem("metis.knowledge-view.v1")).toBe(b.id);
		expect(composer.querySelector('[role="menuitemcheckbox"][aria-label="Product"]')).toBeNull();
		expect(composer.querySelector('[role="menuitemcheckbox"][aria-label="Tech"]')?.getAttribute("aria-checked")).toBe(
			"true",
		);
		expect(api.setSessionKnowledge).not.toHaveBeenCalled();
	});
	it("clears the final library, its saved selection and stale note preview", async () => {
		const api = fixture([a], [a]);
		let resolveRead!: (result: { path: string; content: string }) => void;
		api.readKnowledgeNote.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRead = resolve;
				}),
		);
		const container = await mount(api);
		await openGraphNote(container, "Home");
		await removeLibraries(container, ["Product"]);
		expect(container.textContent).toContain("Your knowledge, in one place");
		expect(localStorage.getItem("metis.knowledge-view.v1")).toBeNull();
		expect(container.querySelector(".knowledge-note-view")).toBeNull();
		expect((button(container, "Choose knowledge library") as HTMLButtonElement).disabled).toBe(true);
		await act(async () => resolveRead({ path: "Home.md", content: "Removed library stale content" }));
		expect(container.textContent).not.toContain("Removed library stale content");
	});
	it("preserves the current note when removing another library", async () => {
		const api = fixture();
		const container = await mount(api);
		await openGraphNote(container, "Deep note");
		expect(container.textContent).toContain("Nested content");
		await removeLibraries(container, ["Tech"]);
		expect(button(container, "Choose knowledge library").textContent?.trim()).toBe("Product");
		expect(container.textContent).toContain("Nested content");
	});
	it("keeps registered choices and the current selection when removal fails", async () => {
		const api = fixture();
		api.removeKnowledgeLibrary.mockRejectedValue(new Error("Could not save knowledge directories"));
		const container = await mount(api);
		await removeLibraries(container, ["Product"]);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save knowledge directories");
		expect(button(container, "Choose knowledge library").textContent?.trim()).toBe("Product");
		expect(localStorage.getItem("metis.knowledge-view.v1")).toBe(a.id);
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog.textContent).toContain("Some knowledge libraries could not be removed. Try again.");
		expect(libraryCheckbox(dialog, "Product").checked).toBe(true);
		await click(button(dialog, "Cancel"));
		await click(button(container, "Choose knowledge library"));
		expect(document.querySelectorAll('.knowledge-library-options [role="menuitemradio"]')).toHaveLength(2);
	});
	it("prevents duplicate removals and competing catalog actions while saving", async () => {
		const api = fixture();
		let rejectRemoval!: (cause: Error) => void;
		api.removeKnowledgeLibrary.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectRemoval = reject;
				}),
		);
		const container = await mount(api);
		const dialog = await removeLibraries(container, ["Product"]);
		expect(button(container, "New knowledge library").disabled).toBe(true);
		expect(button(container, "Choose knowledge library").disabled).toBe(true);
		expect(button(container, "Remove knowledge libraries").disabled).toBe(true);
		expect(button(dialog, "Cancel").disabled).toBe(true);
		expect(libraryCheckbox(dialog, "Product").disabled).toBe(true);
		const confirm = button(dialog, "Removing…");
		expect(confirm.disabled).toBe(true);
		await click(confirm);
		await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="dialog"]')).toBe(dialog);
		expect(api.removeKnowledgeLibrary).toHaveBeenCalledOnce();
		await act(async () => rejectRemoval(new Error("Try again")));
		expect(button(container, "New knowledge library").disabled).toBe(false);
		expect(libraryCheckbox(dialog, "Product").checked).toBe(true);
	});
	it("navigates only library choices with the keyboard and closes on Escape or outside clicks", async () => {
		const api = fixture();
		const container = await mount(api);
		const trigger = button(container, "Choose knowledge library");
		await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Product");
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
		);
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Tech");
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
		);
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Tech");
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		expect(document.querySelector(".knowledge-library-options")).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await click(trigger);
		await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(document.querySelector(".knowledge-library-options")).toBeNull();
		expect(api.removeKnowledgeLibrary).not.toHaveBeenCalled();
	});
	it("changes the browsed library without changing conversation links or removing it", async () => {
		const api = fixture([a, b], [a]);
		const container = await mount(api);
		await click(button(container, "Choose knowledge library"));
		await click(document.querySelector('.knowledge-library-options [role="menuitemradio"][aria-label="Tech"]')!);
		expect(button(container, "Choose knowledge library").textContent?.trim()).toBe("Tech");
		expect(localStorage.getItem("metis.knowledge-view.v1")).toBe(b.id);
		expect(api.scanKnowledgeLibrary).toHaveBeenLastCalledWith({ libraryId: b.id });
		expect(api.setSessionKnowledge).not.toHaveBeenCalled();
		expect(api.removeKnowledgeLibrary).not.toHaveBeenCalled();
		expect(document.querySelector(".knowledge-library-options")).toBeNull();
	});
	it("keeps the native menu inside the viewport and closes on Tab without blocking focus traversal", async () => {
		const container = await mount(fixture());
		const trigger = button(container, "Choose knowledge library") as HTMLButtonElement;
		const width = window.innerWidth;
		const height = window.innerHeight;
		vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
			x: width - 80,
			y: height - 70,
			left: width - 80,
			right: width + 60,
			top: height - 70,
			bottom: height - 40,
			width: 140,
			height: 30,
			toJSON: () => ({}),
		});
		try {
			await click(trigger);
			const menu = document.querySelector<HTMLDivElement>(".knowledge-library-options")!;
			expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
			expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(
				width - 8,
			);
			expect(menu.style.bottom).not.toBe("");
			const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
			await act(async () => document.activeElement!.dispatchEvent(tab));
			expect(tab.defaultPrevented).toBe(false);
			expect(document.querySelector(".knowledge-library-options")).toBeNull();
			expect(document.activeElement).toBe(trigger);
		} finally {
			vi.restoreAllMocks();
		}
	});
});

it("keeps graph selection in the knowledge search and clears it when the conversation gains focus", async () => {
	prepareGraphGeometry();
	const api = fixture();
	const container = await mount(api);
	const node = container.querySelector<SVGGElement>('[data-knowledge-path="Home.md"]')!;
	await click(node);
	expect(node.getAttribute("aria-pressed")).toBe("true");
	const search = container.querySelector<HTMLInputElement>('[aria-label="Search knowledge notes"]')!;
	await act(async () => search.focus());
	expect(node.getAttribute("aria-pressed")).toBe("true");
	expect(container.querySelector(".knowledge-edge.is-highlighted")).not.toBeNull();
	const conversation = document.createElement("textarea");
	document.body.append(conversation);
	await act(async () => conversation.focus());
	expect(node.getAttribute("aria-pressed")).toBe("false");
	expect(container.querySelector(".knowledge-node.is-highlighted")).toBeNull();
	expect(container.querySelector(".knowledge-edge.is-highlighted")).toBeNull();
	expect(api.readKnowledgeNote).not.toHaveBeenCalled();
});
