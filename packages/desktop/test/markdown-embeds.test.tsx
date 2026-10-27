// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/renderer/components/Markdown.tsx";
import { lexMarkdown } from "../src/renderer/components/markdown-parser.ts";
import type { MarkdownDocument } from "../src/renderer/components/markdown-resources.ts";
import { previewBytesCache } from "../src/renderer/components/preview/preview-bytes-cache.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";

vi.mock("../src/renderer/components/preview/InlinePdfPreview.tsx", () => ({
	InlinePdfPreview: ({ page }: { page: number }) => <output data-inline-pdf={page}>PDF {page}</output>,
}));
vi.mock("../src/renderer/components/preview/PdfViewer.tsx", () => ({
	PdfViewer: ({ initialPage }: { initialPage?: number }) => (
		<output data-full-pdf={initialPage}>Full PDF {initialPage}</output>
	),
}));

let roots: Root[] = [];
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("IntersectionObserver", undefined);
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:markdown-test");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	previewBytesCache.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const encoder = new TextEncoder();
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function fixture(files: Record<string, string | Uint8Array> = {}) {
	const listeners = new Set<(event: DesktopApiEvent) => void>();
	const api = {
		subscribe: vi.fn((listener: (event: DesktopApiEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		listKnowledgeLibraries: vi.fn().mockResolvedValue({ libraries: [{ id: "lib", path: "/notes" }] }),
		resolveKnowledgeResource: vi.fn().mockImplementation(async ({ reference }: { reference: string }) => {
			const [path, fragment] = reference.split("#");
			return {
				path,
				fragment,
				kind: path?.endsWith(".png") ? "image" : "note",
				mimeType: "image/png",
				revision: "r1",
			};
		}),
		readPreviewFile: vi.fn().mockImplementation(async ({ relativePath }: { relativePath: string }) => {
			const content = files[relativePath];
			if (content === undefined) return { ok: false, reason: "not-found" };
			const bytes = typeof content === "string" ? encoder.encode(content) : content;
			return {
				ok: true,
				bytes,
				name: relativePath,
				byteLength: bytes.length,
				mediaType: "application/octet-stream",
			};
		}),
	};
	const doc: MarkdownDocument = {
		api: api as unknown as MetisDesktopApi,
		owner: { source: "workspace", sessionId: "s", path: "notes/A.md" },
	};
	return { api, doc, listeners };
}
async function mount(text: string, doc?: MarkdownDocument) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<Markdown text={text} document={doc} />));
	return { container, root };
}
async function click(node: Element) {
	await act(async () => node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

describe("Markdown embeds", () => {
	it("renders note heading ranges and resolves a child's image relative to the child", async () => {
		const { doc, api } = fixture({
			"notes/sub/B.md": "# Heading\n\nChild content\n\n![diagram](../../assets/a.png)\n\n# Other\n\nexcluded",
			"assets/a.png": png,
		});
		const { container } = await mount("before ![[sub/B#Heading]] after", doc);
		expect(container.textContent).toContain("Child content");
		expect(container.textContent).not.toContain("excluded");
		expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:markdown-test");
		expect(api.readPreviewFile).toHaveBeenCalledWith({
			source: "workspace",
			sessionId: "s",
			relativePath: "assets/a.png",
		});
		expect(container.querySelector("p [data-markdown-embed]")).toBeNull();
	});
	it("gives repeated embedded headings different DOM IDs and preserves image dimensions", async () => {
		const { doc } = fixture({ "notes/B.md": "# Title\n\nbody", "notes/a.png": png });
		const { container } = await mount("![[B]]\n\n![[B]]\n\n![[a.png|480x240]]", doc);
		const ids = Array.from(container.querySelectorAll("[id]")).map((node) => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(container.querySelectorAll("h1")).toHaveLength(2);
		expect(container.querySelector("img")?.getAttribute("width")).toBe("480");
	});
	it("opens collapsed callout ancestors and repeats fragment navigation within the owning document", async () => {
		const scroll = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			writable: true,
			value: scroll,
		});
		const { doc } = fixture();
		const text = "> [!note]- Details\n> ## Target\n> body";
		const { container, root } = await mount(text, doc);
		await act(async () =>
			root.render(<Markdown text={text} document={doc} fragment={{ target: "Target", requestId: "first" }} />),
		);
		expect(container.querySelector("details")?.open).toBe(true);
		expect(scroll).toHaveBeenCalledOnce();
		await act(async () =>
			root.render(<Markdown text={text} document={doc} fragment={{ target: "Target", requestId: "second" }} />),
		);
		expect(scroll).toHaveBeenCalledTimes(2);
		delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
	});
	it("stops circular notes and excessive page-wide embed counts", async () => {
		const { doc, api } = fixture({ "notes/B.md": "B\n\n![[A]]", "notes/A.md": "![[B]]" });
		const { container } = await mount("![[B]]", doc);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Circular");
		expect(api.readPreviewFile).toHaveBeenCalledTimes(1);
		const result = await mount(Array.from({ length: 33 }, () => "![[B]]").join("\n\n"), doc);
		expect(result.container.textContent).toContain("Embed limit reached");
	});
	it("opens the original after a cycle limit without recursively expanding it forever", async () => {
		const { doc } = fixture({ "notes/B.md": "B\n\n![[B]]" });
		const { container } = await mount("![[B]]", doc);
		const limited = container.querySelector('[role="alert"]')?.closest("[data-markdown-embed]");
		expect(limited).not.toBeNull();
		await click(limited!.querySelector("button")!);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});
	it("passes an explicit PDF page to inline and full preview", async () => {
		const { doc } = fixture({ "notes/a.pdf": encoder.encode("%PDF-1.7\n") });
		const { container } = await mount("![[a.pdf#page=3]]", doc);
		expect(container.querySelector("[data-inline-pdf]")?.getAttribute("data-inline-pdf")).toBe("3");
		await click(container.querySelector("button")!);
		expect(document.querySelector("[data-full-pdf]")?.getAttribute("data-full-pdf")).toBe("3");
	});
	it("does not read remote images or guess a library for a message without a file owner", async () => {
		const { doc, api } = fixture();
		const { container } = await mount("![remote](https://example.com/a.png)\n\n![[B]]");
		expect(container.querySelector("img")).toBeNull();
		await mount("![remote](https://example.com/a.png)", doc);
		expect(api.readPreviewFile).not.toHaveBeenCalled();
	});
	it("revokes URLs and cancels late results after a library removal notification", async () => {
		const { doc, api, listeners } = fixture({ "a.png": png });
		const knowledge: MarkdownDocument = { ...doc, owner: { source: "knowledge", libraryId: "lib", path: "A.md" } };
		const { container } = await mount("![[a.png]]", knowledge);
		expect(container.querySelector("img")).not.toBeNull();
		api.resolveKnowledgeResource.mockRejectedValue(new Error("Knowledge directory is not registered"));
		await act(async () => {
			for (const listener of listeners) listener({ type: "knowledge-libraries" });
		});
		expect(container.querySelector("img")).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:markdown-test");
		expect(container.textContent).toContain("not registered");
	});
	it("keeps wiki-like syntax literal inside code, formulas and literal HTML", () => {
		const tokens = lexMarkdown("`![[Code]]` $\\text{![[Math]]}$ <span>![[Html]] $x$</span>");
		const inline = tokens[0]?.type === "paragraph" ? tokens[0].tokens : [];
		expect(inline?.some((token) => token.type === "wikiReference")).toBe(false);
		expect(inline?.filter((token) => token.type === "inlineMath")).toHaveLength(1);
	});
});
