// @vitest-environment jsdom
import type { SlideData, SlideNode } from "@aiden0z/pptx-renderer";
import { describe, expect, it } from "vitest";
import { pdfTextSelection } from "../src/renderer/components/preview/pdf-selection.ts";
import { mountPptxSelectionLayer, pptxObjectSelection } from "../src/renderer/components/preview/pptx-selection.ts";

describe("document selection targets", () => {
	it("records PDF pages and native text without rectangle coordinates", () => {
		const root = document.createElement("div");
		root.innerHTML =
			'<div data-page="2"><div class="textLayer"><span>same text</span></div></div><div data-page="3"><div class="textLayer"><span>next page</span></div></div>';
		const range = document.createRange();
		range.setStart(root.querySelector("span")!.firstChild!, 0);
		range.setEnd(root.querySelectorAll("span")[1]!.firstChild!, 4);
		expect(pdfTextSelection(root, range, "same text\nnext")).toEqual({
			target: { kind: "pdf", page: 2, endPage: 3 },
			text: "same text\nnext",
		});
		range.selectNodeContents(root);
		expect(pdfTextSelection(root, range, "outside text layers")).toBeNull();
	});
	it("uses OOXML object identity and resources, never DOM child positions", () => {
		const base = {
			id: "17",
			name: "Icon",
			position: { x: 120, y: 60 },
			size: { w: 80, h: 40 },
			rotation: 30,
			flipH: false,
			flipV: false,
		};
		const picture = { ...base, nodeType: "picture", blipEmbed: "rId5" } as SlideNode;
		const chart = { ...base, id: "18", nodeType: "chart", chartPath: "ppt/charts/chart3.xml" } as SlideNode;
		const slide = {
			slidePath: "ppt/slides/slide9.xml",
			nodes: [picture, chart],
			rels: new Map([["rId5", { target: "../media/image2.svg", type: "image" }]]),
		} as SlideData;
		const value = pptxObjectSelection(slide, picture, 2)!;
		expect(value.target).toMatchObject({
			page: 2,
			slidePath: "ppt/slides/slide9.xml",
			objectId: "17",
			objectType: "picture",
		});
		expect(JSON.parse(value.excerpt).resource.target).toBe("../media/image2.svg");
		expect(JSON.parse(pptxObjectSelection(slide, chart, 2)!.excerpt).chartPath).toBe("ppt/charts/chart3.xml");
		expect(pptxObjectSelection(slide, { ...base, nodeType: "group" } as SlideNode, 2)).toBeNull();
		const element = document.createElement("div");
		let selected: unknown;
		mountPptxSelectionLayer(slide, element, 2, (target) => {
			selected = target;
		});
		const button = element.querySelector<HTMLButtonElement>('[data-object-id="17"]')!;
		expect(button.style.transform).toBe("rotate(30deg)");
		button.dispatchEvent(new Event("pointerenter"));
		button.dispatchEvent(new Event("focus"));
		expect(selected).toBeUndefined();
		button.click();
		expect(selected).toEqual(value);
		mountPptxSelectionLayer(slide, element, 2, () => {});
		expect(element.querySelectorAll(".pptx-selection-layer")).toHaveLength(1);
	});
});
