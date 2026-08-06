// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { clampToolsSidebarWidth } from "../src/renderer/components/ToolsSidebar.tsx";

describe("tools sidebar width", () => {
	it("expands across a large workspace without consuming the conversation", () => {
		expect(clampToolsSidebarWidth(2_000, 1_746)).toBe(1_459);
	});

	it("shrinks a remembered wide sidebar to protect a compact conversation", () => {
		expect(clampToolsSidebarWidth(900, 971)).toBe(684);
	});
});
