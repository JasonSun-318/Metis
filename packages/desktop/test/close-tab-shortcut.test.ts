import { describe, expect, it } from "vitest";
import { isCloseTabShortcut } from "../src/main/close-tab-shortcut.ts";
import { validateDesktopApiEvent, validateDesktopBrowserEvent } from "../src/shared/desktop-api.ts";

const key = (overrides: Partial<Parameters<typeof isCloseTabShortcut>[0]>) => ({
	type: "keyDown" as const,
	key: "w",
	meta: false,
	control: false,
	alt: false,
	shift: false,
	isComposing: false,
	...overrides,
});

describe("close-tab shortcut", () => {
	it("matches Cmd+W on macOS and Ctrl+W elsewhere", () => {
		expect(isCloseTabShortcut(key({ meta: true }), "darwin")).toBe(true);
		expect(isCloseTabShortcut(key({ meta: true, key: "W" }), "darwin")).toBe(true);
		expect(isCloseTabShortcut(key({ control: true }), "darwin")).toBe(false);
		expect(isCloseTabShortcut(key({ control: true }), "win32")).toBe(true);
		expect(isCloseTabShortcut(key({ control: true }), "linux")).toBe(true);
		expect(isCloseTabShortcut(key({ meta: true }), "win32")).toBe(false);
	});

	it("leaves other chords, key-ups and IME composition alone", () => {
		expect(isCloseTabShortcut(key({ meta: true, shift: true }), "darwin")).toBe(false);
		expect(isCloseTabShortcut(key({ meta: true, alt: true }), "darwin")).toBe(false);
		expect(isCloseTabShortcut(key({ meta: true, type: "keyUp" }), "darwin")).toBe(false);
		expect(isCloseTabShortcut(key({ meta: true, isComposing: true }), "darwin")).toBe(false);
		expect(isCloseTabShortcut(key({ meta: true, key: "q" }), "darwin")).toBe(false);
	});

	it("crosses the renderer boundary only in its exact shape", () => {
		expect(validateDesktopApiEvent({ type: "close-tab" })).toEqual({ type: "close-tab" });
		expect(() => validateDesktopApiEvent({ type: "close-tab", tabId: "x" })).toThrow("Invalid desktop event");
		expect(
			validateDesktopBrowserEvent({
				type: "command",
				browserId: "22222222-2222-4222-8222-222222222222",
				command: "close-tab",
			}),
		).toEqual({ type: "command", browserId: "22222222-2222-4222-8222-222222222222", command: "close-tab" });
	});
});
