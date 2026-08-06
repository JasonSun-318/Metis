import type { CSSProperties } from "react";

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;
const MENU_ROW_HEIGHT = 30;
const MENU_ROW_GAP = 2;
const MENU_CHROME_HEIGHT = 10;

export function actionMenuPosition(anchor: DOMRect, width: number, itemCount: number): CSSProperties {
	const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
	const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
	const height = itemCount * MENU_ROW_HEIGHT + Math.max(0, itemCount - 1) * MENU_ROW_GAP + MENU_CHROME_HEIGHT;
	const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.right - width, viewportWidth - width - VIEWPORT_MARGIN));
	const below = anchor.bottom + MENU_GAP;
	const preferredTop = viewportHeight - below >= height ? below : anchor.top - height - MENU_GAP;
	return {
		position: "fixed",
		top: Math.max(VIEWPORT_MARGIN, Math.min(preferredTop, viewportHeight - height - VIEWPORT_MARGIN)),
		left,
		width,
	};
}
