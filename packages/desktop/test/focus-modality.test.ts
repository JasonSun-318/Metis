// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installFocusModality } from "../src/renderer/ui/focus-modality.ts";

describe("installFocusModality", () => {
	it("marks keyboard focus on Tab and pointer focus otherwise", () => {
		const dispose = installFocusModality(document);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
		expect(document.documentElement.dataset.focusModality).toBe("keyboard");
		document.dispatchEvent(new PointerEvent("pointerdown"));
		expect(document.documentElement.dataset.focusModality).toBe("pointer");
		dispose();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
		expect(document.documentElement.dataset.focusModality).toBe("pointer");
	});
});
