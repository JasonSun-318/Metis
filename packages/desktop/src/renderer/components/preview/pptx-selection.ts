import type { SlideData, SlideNode } from "@aiden0z/pptx-renderer";
import type { FileSelectionInput } from "./file-selection.ts";

export function pptxObjectSelection(slide: SlideData, node: SlideNode, page: number) {
	if (
		!["shape", "picture", "chart"].includes(node.nodeType) ||
		!node.id ||
		node.id.length > 255 ||
		!/^ppt\/slides\/slide[0-9]+\.xml$/u.test(slide.slidePath)
	)
		return null;
	const target: NonNullable<FileSelectionInput["target"]> = {
		kind: "pptx",
		page,
		slidePath: slide.slidePath,
		objectId: node.id,
		objectType: node.nodeType as "shape" | "picture" | "chart",
		objectName: node.name.slice(0, 255),
	};
	const text =
		node.nodeType === "shape"
			? node.textBody?.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n")
			: undefined;
	const resource = node.nodeType === "picture" ? slide.rels.get(node.blipEmbed ?? node.blipLink ?? "") : undefined;
	const excerpt = JSON.stringify({
		position: node.position,
		size: node.size,
		rotation: node.rotation,
		flipH: node.flipH,
		flipV: node.flipV,
		...(node.nodeType === "picture"
			? { relationshipId: node.blipEmbed ?? node.blipLink, resource, crop: node.crop }
			: {}),
		...(node.nodeType === "chart" ? { chartPath: node.chartPath } : {}),
	});
	return { target, text: text?.trim() ? text : `${node.nodeType}: ${node.name || node.id}`, excerpt };
}

/** Overlay native slide coordinates; the renderer scales the containing slide. */
export function mountPptxSelectionLayer(
	slide: SlideData,
	element: HTMLElement,
	page: number,
	select: (value: NonNullable<ReturnType<typeof pptxObjectSelection>>, anchor: HTMLElement) => void,
) {
	element.querySelector(":scope > .pptx-selection-layer")?.remove();
	const layer = document.createElement("div");
	layer.className = "pptx-selection-layer";
	for (const node of slide.nodes) {
		if (![node.position.x, node.position.y, node.size.w, node.size.h, node.rotation].every(Number.isFinite)) continue;
		const value = pptxObjectSelection(slide, node, page);
		const button = document.createElement(value ? "button" : "div");
		button.className = value ? "pptx-object-target" : "pptx-object-blocker";
		Object.assign(button.style, {
			left: `${node.position.x}px`,
			top: `${node.position.y}px`,
			width: `${Math.max(3, node.size.w)}px`,
			height: `${Math.max(3, node.size.h)}px`,
			transform: `rotate(${node.rotation}deg)`,
		});
		if (value) {
			button.setAttribute("type", "button");
			button.setAttribute("aria-label", `${node.name || node.id} (${node.nodeType})`);
			button.dataset.objectId = node.id;
			const activate = () => select(value, button);
			button.onclick = activate;
		}
		layer.append(button);
	}
	element.append(layer);
}
