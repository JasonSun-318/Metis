import { afterEach, describe, expect, it, vi } from "vitest";
import {
	embeddedMediaType,
	type MarkdownDocument,
	readMarkdownResource,
	resolveMarkdownResource,
} from "../src/renderer/components/markdown-resources.ts";
import { previewBytesCache } from "../src/renderer/components/preview/preview-bytes-cache.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

function document(owner: MarkdownDocument["owner"]) {
	const api = {
		resolveKnowledgeResource: vi.fn().mockResolvedValue({
			libraryId: "lib",
			path: "assets/a.png",
			kind: "image",
			mimeType: "image/png",
			revision: "r1",
		}),
		readPreviewFile: vi.fn().mockResolvedValue({
			ok: true,
			bytes: new TextEncoder().encode("# Note"),
			mediaType: "text/markdown",
			byteLength: 6,
			name: "Note.md",
		}),
		listKnowledgeLibraries: vi.fn().mockResolvedValue({ libraries: [{ id: "lib", path: "/notes" }] }),
	};
	return { doc: { api: api as unknown as MetisDesktopApi, owner }, api };
}

describe("Markdown resource ownership", () => {
	afterEach(() => previewBytesCache.clear());
	it("resolves relative resources against the owning note, including safe parent paths and encoded names", async () => {
		const { doc, api } = document({ source: "workspace", sessionId: "s", path: "notes/nested/A.md" });
		const image = await resolveMarkdownResource(doc, {
			reference: "../assets/a%20b.png",
			kind: "markdown",
			label: "a",
		});
		expect(image.input).toEqual({ source: "workspace", sessionId: "s", relativePath: "notes/assets/a b.png" });
		const child = await resolveMarkdownResource(doc, { reference: "B", kind: "wiki", label: "B" });
		const nested = await resolveMarkdownResource(
			{ ...doc, owner: child.owner },
			{ reference: "./diagram.png", kind: "markdown", label: "diagram" },
		);
		expect(nested.path).toBe("notes/nested/diagram.png");
		expect(api.readPreviewFile).not.toHaveBeenCalled();
	});
	it.each([
		"../../../secret.png",
		"/secret.png",
		"file:///secret.png",
		"javascript:alert(1)",
		"https://example.com/a.png",
		"//example.com/a.png",
		"%2Fsecret.png",
	])("rejects unauthorized target %s before reading bytes", async (reference) => {
		const { doc, api } = document({ source: "workspace", sessionId: "s", path: "notes/A.md" });
		await expect(resolveMarkdownResource(doc, { reference, kind: "markdown", label: "x" })).rejects.toThrow();
		expect(api.readPreviewFile).not.toHaveBeenCalled();
	});
	it("never infers a sibling grant from a delivered file", async () => {
		const { doc, api } = document({ source: "delivered", sessionId: "s", fileId: "f", path: "reports/A.md" });
		await expect(
			resolveMarkdownResource(doc, { reference: "chart.png", kind: "markdown", label: "chart" }),
		).rejects.toThrow("explicitly delivered");
		expect(api.readPreviewFile).not.toHaveBeenCalled();
	});
	it("uses only an explicitly delivered dependency", async () => {
		const grant = { source: "delivered" as const, sessionId: "s", fileId: "image" };
		const { doc } = document({
			source: "delivered",
			sessionId: "s",
			fileId: "f",
			path: "reports/A.md",
			dependencies: new Map([["reports/chart.png", grant]]),
		});
		expect(
			(await resolveMarkdownResource(doc, { reference: "chart.png", kind: "markdown", label: "chart" })).input,
		).toEqual(grant);
	});
	it("retains fragments and sends knowledge references to the registered library resolver", async () => {
		const { doc, api } = document({ source: "knowledge", libraryId: "lib", path: "nested/A.md" });
		api.resolveKnowledgeResource.mockResolvedValueOnce({
			libraryId: "lib",
			path: "B.md",
			kind: "note",
			mimeType: "text/markdown",
			revision: "r2",
			fragment: "Heading",
		});
		const result = await resolveMarkdownResource(doc, { reference: "B#Heading", kind: "wiki", label: "B" });
		expect(api.resolveKnowledgeResource).toHaveBeenCalledWith({
			libraryId: "lib",
			sourcePath: "nested/A.md",
			reference: "B#Heading",
			kind: "wiki",
		});
		expect(result.input).toEqual({ source: "knowledge", libraryId: "lib", relativePath: "B.md", revision: "r2" });
		expect(result.fragment).toBe("Heading");
	});
	it("revalidates knowledge registration on cache hits and rejects a removed old ID", async () => {
		const { doc, api } = document({ source: "knowledge", libraryId: "lib", path: "A.md" });
		api.resolveKnowledgeResource.mockResolvedValue({
			path: "B.md",
			kind: "note",
			mimeType: "text/markdown",
			revision: "r1",
		});
		const resource = await resolveMarkdownResource(doc, { reference: "B", kind: "wiki", label: "B" });
		await readMarkdownResource(doc, resource);
		api.listKnowledgeLibraries.mockResolvedValue({ libraries: [{ id: "new-id", path: "/notes" }] });
		await expect(readMarkdownResource(doc, resource)).rejects.toThrow("not registered");
		expect(api.readPreviewFile).toHaveBeenCalledTimes(1);
	});
	it("rejects a disguised image instead of creating a blob for HTML", async () => {
		const { doc } = document({ source: "workspace", sessionId: "s", path: "A.md" });
		const resource = await resolveMarkdownResource(doc, { reference: "a.png", kind: "markdown", label: "a" });
		await expect(readMarkdownResource(doc, resource)).rejects.toThrow("contents do not match");
		expect(embeddedMediaType(new TextEncoder().encode("<svg onload='alert(1)'/>"))).toBeUndefined();
	});
});
