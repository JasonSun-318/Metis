import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { sanitizeTerminalText } from "../src/utils/ansi.ts";

const mocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn(),
	readClipboardText: vi.fn(),
}));

vi.mock("../src/utils/clipboard-image.js", () => ({ readClipboardImage: mocks.readClipboardImage }));
vi.mock("../src/utils/clipboard.js", () => ({
	readClipboardText: mocks.readClipboardText,
	copyToClipboard: vi.fn(async () => {}),
}));

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleClipboardPaste(this: object): Promise<void>;
};

function createMode(model?: { id: string; input: string[] }) {
	const editor = { insertTextAtCursor: vi.fn() };
	const ui = { requestRender: vi.fn() };
	const showError = vi.fn();
	const showWarning = vi.fn();
	const attachPastedFiles = vi.fn(() => false);
	const context = Object.create(InteractiveMode.prototype);
	for (const [key, value] of Object.entries({
		session: { model },
		editor,
		ui,
		showError,
		showWarning,
		attachPastedFiles,
	})) {
		Object.defineProperty(context, key, { configurable: true, writable: true, value });
	}
	return { context, editor, ui, showError, showWarning, attachPastedFiles };
}

async function paste(context: object): Promise<void> {
	await interactiveModePrototype.handleClipboardPaste.call(context);
}

beforeEach(() => {
	mocks.readClipboardImage.mockReset();
	mocks.readClipboardText.mockReset();
});

describe("InteractiveMode.handleClipboardPaste error reporting", () => {
	it("reports an unexpected image read failure with sanitized text", async () => {
		const rawMessage = "image \x1b[31mread\x07 failed";
		const mode = createMode();
		mocks.readClipboardImage.mockRejectedValueOnce(new Error(rawMessage));

		await paste(mode.context);

		expect(mode.showError).toHaveBeenCalledTimes(1);
		const message = mode.showError.mock.calls[0]?.[0];
		expect(message).toBe(sanitizeTerminalText(rawMessage));
		expect(message).not.toContain("\x1b");
		expect(message).not.toContain("\x07");
		expect(mocks.readClipboardText).not.toHaveBeenCalled();
		expect(mode.editor.insertTextAtCursor).not.toHaveBeenCalled();
	});

	it("reports an unexpected text read failure from a non-Error rejection", async () => {
		const rawMessage = "text \x1b[32mread\x07 failed";
		const mode = createMode();
		mocks.readClipboardImage.mockResolvedValueOnce(null);
		mocks.readClipboardText.mockRejectedValueOnce(rawMessage);

		await paste(mode.context);

		expect(mode.showError).toHaveBeenCalledTimes(1);
		const message = mode.showError.mock.calls[0]?.[0];
		expect(message).toBe(sanitizeTerminalText(rawMessage));
		expect(message).not.toContain("\x1b");
		expect(message).not.toContain("\x07");
		expect(mode.editor.insertTextAtCursor).not.toHaveBeenCalled();
	});

	it("stays quiet for an empty clipboard", async () => {
		const mode = createMode();
		mocks.readClipboardImage.mockResolvedValueOnce(null);
		mocks.readClipboardText.mockResolvedValueOnce(null);

		await paste(mode.context);

		expect(mode.showError).not.toHaveBeenCalled();
		expect(mode.showWarning).not.toHaveBeenCalled();
		expect(mode.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(mode.ui.requestRender).not.toHaveBeenCalled();
	});

	it("inserts routine clipboard text without reporting an error", async () => {
		const mode = createMode();
		mocks.readClipboardImage.mockResolvedValueOnce(null);
		mocks.readClipboardText.mockResolvedValueOnce("pasted text");

		await paste(mode.context);

		expect(mode.showError).not.toHaveBeenCalled();
		expect(mode.showWarning).not.toHaveBeenCalled();
		expect(mode.editor.insertTextAtCursor).toHaveBeenCalledWith("pasted text");
		expect(mode.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("keeps the unsupported-image-model warning path unchanged", async () => {
		const mode = createMode({ id: "text-only", input: ["text"] });
		mocks.readClipboardImage.mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });

		await paste(mode.context);

		expect(mode.showWarning).toHaveBeenCalledWith(expect.stringContaining("text-only"));
		expect(mode.showError).not.toHaveBeenCalled();
		expect(mode.editor.insertTextAtCursor).not.toHaveBeenCalled();
	});
});
