// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePanel, knowledgeNoteMarkdown } from "../src/renderer/components/KnowledgePanel.tsx";
import { KnowledgeLinkControl } from "../src/renderer/components/KnowledgeLinkControl.tsx";
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
		scanKnowledgeLibrary: vi.fn(async () => ({
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
				<KnowledgeLinkControl api={api as unknown as MetisDesktopApi} sessionId={sessionId} onOpen={vi.fn()} />
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
function button(container: Element, text: string) {
	return [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
}
describe("Knowledge sidebar and conversation links", () => {
	it("viewing a directory does not link it; explicit linking does", async () => {
		const api = fixture();
		const container = await mount(api);
		expect(container.textContent).toContain(a.path);
		expect(api.setSessionKnowledge).not.toHaveBeenCalled();
		await click(button(container, "Link to conversation"));
		expect(api.setSessionKnowledge).toHaveBeenCalledWith(expect.objectContaining({ sessionId, libraryIds: [a.id] }));
		expect(button(container, "Unlink from conversation")).toBeDefined();
	});
	it("opens nested notes from graph nodes and navigates their wikilinks", async () => {
		const api = fixture();
		const container = await mount(api);
		await click(container.querySelector('[role="button"][aria-label="Home"]')!);
		expect(container.textContent).toContain("Read deep note");
		await click(container.querySelector('a[href^="#knowledge-note/"]')!);
		expect(api.readKnowledgeNote).toHaveBeenLastCalledWith({ libraryId: a.id, path: "topic/deep/Note.md" });
		expect(container.textContent).toContain("Nested content");
	});
	it("retains other linked libraries when linking or unlinking from the composer", async () => {
		const api = fixture([a, b], [a]);
		const container = await mount(api, true);
		await click(button(container, "Tech"));
		expect(api.setSessionKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({ libraryIds: [a.id, b.id] }));
		await click(container.querySelector('[aria-label="Unlink knowledge library: Product"]')!);
		expect(api.setSessionKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({ libraryIds: [b.id] }));
	});
	it("shows note read failures and allows returning to the graph", async () => {
		const api = fixture();
		api.readKnowledgeNote.mockRejectedValue(new Error("File is no longer readable"));
		const container = await mount(api);
		await click(container.querySelector('[role="button"][aria-label="Home"]')!);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("File is no longer readable");
		expect(container.querySelector('[role="status"]')).toBeNull();
		await click(button(container, "Back to knowledge library"));
		expect(container.querySelector('[aria-label="Knowledge graph"]')).not.toBeNull();
	});
	it("keeps the current note visible while polling reads its updated content", async () => {
		const api = fixture();
		const container = await mount(api);
		await click(container.querySelector('[role="button"][aria-label="Deep note"]')!);
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
			expect(container.querySelector('[role="status"]')).toBeNull();
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
		const picker = container.querySelector("details")!;
		picker.open = true;
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(picker.open).toBe(false);
		picker.open = true;
		await act(async () => {
			document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		});
		expect(picker.open).toBe(false);
	});
	it("selects an empty directory without creating content or linking automatically", async () => {
		const api = fixture([]);
		api.scanKnowledgeLibrary.mockResolvedValue({ notes: [], edges: [], warnings: [] });
		const container = await mount(api);
		await click(button(container, "Choose knowledge directory"));
		expect(api.registerKnowledgeLibrary).toHaveBeenCalledWith(expect.objectContaining({ path: a.path }));
		expect(container.textContent).toContain("No usable content");
		expect(api.setSessionKnowledge).not.toHaveBeenCalled();
	});
	it("renders internal note links without modifying code examples", () => {
		const note = {
			path: "Home.md",
			title: "Home",
			links: [{ target: "Deep", kind: "wiki" as const, path: "topic/Deep.md" }],
		};
		const content = "[[Deep]]\n`[[Deep]]`\n```md\n[[Deep]]\n```";
		const rendered = knowledgeNoteMarkdown(content, note);
		expect(rendered).toContain("[Deep](#knowledge-note/topic%2FDeep.md)");
		expect(rendered).toContain("`[[Deep]]`");
		expect(rendered).toContain("```md\n[[Deep]]\n```");
	});
});
