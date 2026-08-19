import { describe, expect, it } from "vitest";
import {
	classifyPreviewKind,
	fileExtension,
	isEnginePreviewKind,
	isHostedPreviewKind,
} from "../src/renderer/components/preview/preview-kinds.ts";

describe("classifyPreviewKind", () => {
	it("maps modern office and pdf to engine kinds", () => {
		expect(classifyPreviewKind("report.PDF")).toBe("pdf");
		expect(classifyPreviewKind("a.docx")).toBe("docx");
		expect(classifyPreviewKind("deck.pptx")).toBe("pptx");
		expect(classifyPreviewKind("model.xlsx")).toBe("xlsx");
		expect(classifyPreviewKind("data.csv")).toBe("csv");
	});

	it("keeps images and text as light kinds", () => {
		expect(classifyPreviewKind("photo.png")).toBe("image");
		expect(classifyPreviewKind("photo.JPG")).toBe("image");
		expect(classifyPreviewKind("anim.gif")).toBe("image");
		expect(classifyPreviewKind("art.webp")).toBe("image");
		expect(classifyPreviewKind("vector.svg")).toBe("image");
		expect(classifyPreviewKind("notes.md")).toBe("markdown");
		expect(classifyPreviewKind("notes.mdx")).toBe("markdown");
		expect(classifyPreviewKind("data.json")).toBe("text");
		expect(classifyPreviewKind("app.ts")).toBe("text");
		expect(classifyPreviewKind("notes.txt")).toBe("text");
	});

	it("rejects legacy office and unknown binaries", () => {
		expect(classifyPreviewKind("old.ppt")).toBe("unsupported");
		expect(classifyPreviewKind("old.doc")).toBe("unsupported");
		expect(classifyPreviewKind("old.xls")).toBe("unsupported");
		expect(classifyPreviewKind("archive.zip")).toBe("unsupported");
		expect(fileExtension("noext")).toBe("");
		expect(isEnginePreviewKind("pdf")).toBe(true);
		expect(isEnginePreviewKind("image")).toBe(false);
		expect(isEnginePreviewKind("unsupported")).toBe(false);
		expect(isHostedPreviewKind("image")).toBe(true);
		expect(isHostedPreviewKind("text")).toBe(false);
	});
});
