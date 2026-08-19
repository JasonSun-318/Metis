import { describe, expect, it } from "vitest";
import {
	classifyPreviewKind,
	fileExtension,
	isEnginePreviewKind,
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
		expect(classifyPreviewKind("notes.md")).toBe("markdown");
		expect(classifyPreviewKind("app.ts")).toBe("text");
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
	});
});
