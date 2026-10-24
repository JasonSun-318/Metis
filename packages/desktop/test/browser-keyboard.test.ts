import { describe, expect, it } from "vitest";
import { parseBrowserKey } from "../src/main/browser-keyboard.ts";

const MAC = 4;
const WINDOWS = 2;

function down(key: string, acceleratorModifier = MAC): Record<string, unknown> {
	return parseBrowserKey(key, acceleratorModifier).down;
}

function up(key: string, acceleratorModifier = MAC): Record<string, unknown> {
	return parseBrowserKey(key, acceleratorModifier).up;
}

describe("parseBrowserKey plain keys", () => {
	it.each([
		["Enter", "Enter", "Enter", 13, "\r"],
		["Tab", "Tab", "Tab", 9, undefined],
		["ArrowLeft", "ArrowLeft", "ArrowLeft", 37, undefined],
		["ArrowUp", "ArrowUp", "ArrowUp", 38, undefined],
		["ArrowRight", "ArrowRight", "ArrowRight", 39, undefined],
		["ArrowDown", "ArrowDown", "ArrowDown", 40, undefined],
		["Home", "Home", "Home", 36, undefined],
		["End", "End", "End", 35, undefined],
		["Escape", "Escape", "Escape", 27, undefined],
		["Backspace", "Backspace", "Backspace", 8, undefined],
		["Delete", "Delete", "Delete", 46, undefined],
		["Space", " ", "Space", 32, " "],
	] as const)("parses %s into a key down/up pair", (input, key, code, keyCode, text) => {
		const downEvent = down(input);
		expect(downEvent).toMatchObject({
			type: text === undefined ? "rawKeyDown" : "keyDown",
			key,
			code,
			windowsVirtualKeyCode: keyCode,
			nativeVirtualKeyCode: keyCode,
			modifiers: 0,
		});
		if (text === undefined) {
			expect(downEvent).not.toHaveProperty("text");
			expect(downEvent).not.toHaveProperty("unmodifiedText");
		} else {
			expect(downEvent).toMatchObject({ text, unmodifiedText: text });
		}

		expect(up(input)).toEqual({
			type: "keyUp",
			key,
			code,
			windowsVirtualKeyCode: keyCode,
			nativeVirtualKeyCode: keyCode,
			modifiers: 0,
		});
	});

	it("normalizes named keys and allows whitespace around modifiers", () => {
		expect(down("enter")).toMatchObject({ key: "Enter", code: "Enter", text: "\r" });
		expect(down("  arrowleft  ")).toMatchObject({ key: "ArrowLeft", code: "ArrowLeft" });
		expect(down("Control + Shift + ArrowLeft")).toMatchObject({
			key: "ArrowLeft",
			code: "ArrowLeft",
			modifiers: 10,
		});
	});

	it("preserves Enter text for Shift+Enter but suppresses it for command modifiers", () => {
		expect(down("Shift+Enter")).toMatchObject({ type: "keyDown", key: "Enter", text: "\r", modifiers: 8 });
		expect(down("Control+Enter")).not.toHaveProperty("text");
		expect(down("Meta+Enter")).not.toHaveProperty("text");
		expect(down("Alt+Enter")).not.toHaveProperty("text");
	});
});

describe("parseBrowserKey printable keys", () => {
	it("preserves standalone letter case and uses Shift for text", () => {
		expect(down("a")).toMatchObject({
			type: "keyDown",
			key: "a",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			text: "a",
			unmodifiedText: "a",
			modifiers: 0,
		});
		expect(down("A")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
		expect(down("Shift+A")).toMatchObject({
			type: "keyDown",
			key: "A",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			text: "A",
			unmodifiedText: "a",
			modifiers: 8,
		});
		expect(down("7")).toMatchObject({
			type: "keyDown",
			key: "7",
			code: "Digit7",
			windowsVirtualKeyCode: 55,
			text: "7",
			unmodifiedText: "7",
			modifiers: 0,
		});
		expect(down("Shift+7")).toMatchObject({
			key: "&",
			code: "Digit7",
			windowsVirtualKeyCode: 55,
			text: "&",
			unmodifiedText: "7",
			modifiers: 8,
		});
	});

	it("parses punctuation and its shifted symbols", () => {
		expect(down(";")).toMatchObject({
			type: "keyDown",
			key: ";",
			code: "Semicolon",
			windowsVirtualKeyCode: 186,
			text: ";",
			unmodifiedText: ";",
		});
		expect(down("Shift+;")).toMatchObject({
			key: ":",
			code: "Semicolon",
			windowsVirtualKeyCode: 186,
			text: ":",
			unmodifiedText: ";",
			modifiers: 8,
		});
		expect(down("?")).toMatchObject({
			key: "?",
			code: "Slash",
			windowsVirtualKeyCode: 191,
			text: "?",
			unmodifiedText: "/",
			modifiers: 8,
		});
		expect(down("!")).toMatchObject({
			key: "!",
			code: "Digit1",
			windowsVirtualKeyCode: 49,
			text: "!",
			unmodifiedText: "1",
			modifiers: 8,
		});
		expect(down("+")).toMatchObject({
			key: "+",
			code: "Equal",
			windowsVirtualKeyCode: 187,
			text: "+",
			unmodifiedText: "=",
			modifiers: 8,
		});
	});

	it("parses every common unshifted punctuation key", () => {
		const cases = [
			["`", "Backquote", 192],
			["-", "Minus", 189],
			["=", "Equal", 187],
			["[", "BracketLeft", 219],
			["]", "BracketRight", 221],
			["\\", "Backslash", 220],
			[";", "Semicolon", 186],
			["'", "Quote", 222],
			[",", "Comma", 188],
			[".", "Period", 190],
			["/", "Slash", 191],
		] as const;

		for (const [key, code, keyCode] of cases) {
			expect(down(key)).toMatchObject({ key, code, windowsVirtualKeyCode: keyCode, text: key, modifiers: 0 });
		}
	});

	it("supports Plus as an escaped plus key in combinations", () => {
		expect(down("Control+Plus", WINDOWS)).toMatchObject({
			type: "rawKeyDown",
			key: "+",
			code: "Equal",
			windowsVirtualKeyCode: 187,
			modifiers: 10,
		});
		expect(down("Control+Plus", WINDOWS)).not.toHaveProperty("text");
	});
});

describe("parseBrowserKey modifiers", () => {
	it("uses the CDP modifier mask and adds selectAll for macOS Meta+A", () => {
		const downEvent = down("Meta+A");
		expect(downEvent).toEqual({
			type: "rawKeyDown",
			key: "a",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			nativeVirtualKeyCode: 65,
			modifiers: 4,
			commands: ["selectAll"],
		});
		expect(up("Meta+A")).toEqual({
			type: "keyUp",
			key: "a",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			nativeVirtualKeyCode: 65,
			modifiers: 4,
		});
	});

	it("does not add platform edit commands for the non-platform modifier", () => {
		expect(down("Meta+A", WINDOWS)).toMatchObject({ key: "a", modifiers: 4 });
		expect(down("Meta+A", WINDOWS)).not.toHaveProperty("commands");
		expect(down("Control+A", MAC)).toMatchObject({ key: "a", modifiers: 2 });
		expect(down("Control+A", MAC)).not.toHaveProperty("commands");
	});

	it("resolves ControlOrMeta from the accelerator platform", () => {
		expect(down("ControlOrMeta+A", MAC)).toMatchObject({ modifiers: 4, commands: ["selectAll"] });
		expect(down("ControlOrMeta+A", WINDOWS)).toMatchObject({ modifiers: 2, commands: ["selectAll"] });
	});

	it("parses Control, Shift, Alt, aliases, and arrow combinations", () => {
		expect(down("Control+Shift+ArrowLeft")).toEqual({
			type: "rawKeyDown",
			key: "ArrowLeft",
			code: "ArrowLeft",
			windowsVirtualKeyCode: 37,
			nativeVirtualKeyCode: 37,
			modifiers: 10,
		});
		expect(down("Shift+Tab")).toMatchObject({ type: "rawKeyDown", key: "Tab", code: "Tab", modifiers: 8 });
		expect(down("Option+ArrowDown")).toMatchObject({ key: "ArrowDown", code: "ArrowDown", modifiers: 1 });
		expect(down("Alt+ArrowUp")).toMatchObject({ key: "ArrowUp", code: "ArrowUp", modifiers: 1 });
		expect(down("Ctrl+A", WINDOWS)).toMatchObject({ key: "a", modifiers: 2, commands: ["selectAll"] });
	});

	it("supports the limited platform edit command mapping", () => {
		expect(down("Command+C")).toMatchObject({ modifiers: 4, commands: ["copy"] });
		expect(up("Command+C")).not.toHaveProperty("commands");
		expect(down("Cmd+X")).toMatchObject({ modifiers: 4, commands: ["cut"] });
		expect(down("Meta+V")).toMatchObject({ modifiers: 4, commands: ["paste"] });
		expect(down("Meta+Z")).toMatchObject({ modifiers: 4, commands: ["undo"] });
		expect(down("Meta+Shift+Z")).toMatchObject({ modifiers: 12, commands: ["redo"] });
		expect(down("Meta+Y")).not.toHaveProperty("commands");
		expect(down("Control+Y", WINDOWS)).toMatchObject({ modifiers: 2, commands: ["redo"] });
		expect(down("Control+Shift+Y", WINDOWS)).not.toHaveProperty("commands");
		expect(down("Control+Shift+Z", WINDOWS)).toMatchObject({ modifiers: 10, commands: ["redo"] });
	});

	it("does not apply edit commands to shifted or extra-modified shortcuts", () => {
		expect(down("Meta+Shift+A")).toMatchObject({ modifiers: 12 });
		expect(down("Meta+Shift+A")).not.toHaveProperty("commands");
		expect(down("Meta+Alt+A")).toMatchObject({ modifiers: 5 });
		expect(down("Meta+Alt+A")).not.toHaveProperty("commands");
		expect(down("Control+Meta+A", MAC)).toMatchObject({ modifiers: 6 });
		expect(down("Control+Meta+A", MAC)).not.toHaveProperty("commands");
	});

	it("does not insert text for Control, Meta, or Alt combinations", () => {
		for (const key of ["Control+A", "Meta+C", "Alt+X", "Control+Shift+Z"]) {
			expect(down(key)).not.toHaveProperty("text");
			expect(down(key)).not.toHaveProperty("unmodifiedText");
			expect(up(key)).not.toHaveProperty("text");
		}
	});
});

describe("parseBrowserKey invalid input", () => {
	it.each([
		["", MAC],
		["   ", MAC],
		["Control", MAC],
		["Control+", MAC],
		["+A", MAC],
		["Control++A", MAC],
		["Control+Control+A", MAC],
		["Ctrl+Control+A", MAC],
		["Meta+Command+A", MAC],
		["Alt+Option+A", MAC],
		["Shift+Shift+A", MAC],
		["Control+ControlOrMeta+A", WINDOWS],
		["ControlOrMeta+ControlOrMeta+A", MAC],
		["A+B", MAC],
		["Enter+Tab", MAC],
		["Control+Foo", MAC],
		["F13", MAC],
		["😀", MAC],
		["Hyper+A", MAC],
		["constructor+A", MAC],
		["toString+A", MAC],
		["__proto__", MAC],
	] as const)("rejects %j instead of returning a partial payload", (input, acceleratorModifier) => {
		expect(() => parseBrowserKey(input, acceleratorModifier)).toThrow(Error);
	});

	it("requires a usable platform when ControlOrMeta is present", () => {
		for (const acceleratorModifier of [0, 6, 8]) {
			expect(() => parseBrowserKey("ControlOrMeta+A", acceleratorModifier)).toThrow(/acceleratorModifier/);
		}
	});

	it("does not require the platform value when ControlOrMeta is absent", () => {
		expect(down("Enter", 0)).toMatchObject({ key: "Enter", code: "Enter", text: "\r" });
	});
});
