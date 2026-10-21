// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { clampToolsSidebarWidth } from "../src/renderer/components/SessionWorkspace.tsx";

describe("tools sidebar main-area budget", () => {
	it.each([
		{ workspace: 972, preferred: 650, expected: 404 },
		{ workspace: 972, preferred: 393, expected: 393 },
		{ workspace: 1132, preferred: 650, expected: 564 },
		{ workspace: 892, preferred: 650, expected: 324 },
		{ workspace: 854, preferred: 650, expected: 286 },
		{ workspace: 668, preferred: 650, expected: 280 },
	])("keeps a usable main area at workspace width $workspace", ({ workspace, preferred, expected }) => {
		expect(clampToolsSidebarWidth(preferred, workspace)).toBe(expected);
	});

	it("applies the same bounds to keyboard and pointer resize requests", () => {
		expect(clampToolsSidebarWidth(393 + 16, 972)).toBe(404);
		expect(clampToolsSidebarWidth(Number.MAX_SAFE_INTEGER, 972)).toBe(404);
		expect(clampToolsSidebarWidth(280 - 16, 972)).toBe(280);
	});
});
