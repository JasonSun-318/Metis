import type { ImageContent } from "@arcmind/ai/compat";
import { expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

test("submits numbered clipboard images in placeholder order", async () => {
	const image1: ImageContent = { type: "image", data: "image-1", mimeType: "image/png" };
	const image2: ImageContent = { type: "image", data: "image-2", mimeType: "image/jpeg" };
	const editor = {
		addToHistory: vi.fn(),
		setAtomicMarkers: vi.fn(),
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map([
			[1, image1],
			[2, image2],
		]),
		clipboardImageCounter: 2,
		pendingUserInputs: [],
		runtimeHost: { session: { isCompacting: false, isStreaming: false } },
		flushPendingBashComponents: vi.fn(),
	});

	(InteractiveMode.prototype as any).setupEditorSubmitHandler.call(mode);
	const inputPromise = (InteractiveMode.prototype as any).getUserInput.call(mode);
	await editor.onSubmit?.("[image2][image1] compare");

	await expect(inputPromise).resolves.toEqual({ text: "compare", images: [image2, image1] });
	expect(mode.pendingClipboardImages.size).toBe(0);
	expect(mode.clipboardImageCounter).toBe(0);
	expect(editor.setAtomicMarkers).toHaveBeenLastCalledWith([]);
	expect(editor.addToHistory).toHaveBeenCalledWith("compare");
});

test("preserves blocked commands and queues numbered images during Compact/Dream", async () => {
	const image: ImageContent = { type: "image", data: "image", mimeType: "image/png" };
	const editor = {
		addToHistory: vi.fn(),
		setText: vi.fn(),
		setAtomicMarkers: vi.fn(),
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map([[1, image]]),
		clipboardImageCounter: 1,
		compactionQueuedMessages: [],
		runtimeHost: { session: { isCompacting: true } },
		isExtensionCommand: () => false,
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
	});

	(InteractiveMode.prototype as any).setupEditorSubmitHandler.call(mode);
	await editor.onSubmit?.("/settings");
	expect(mode.showWarning).toHaveBeenCalledWith(
		"Compact/Dream is running. Wait for it to finish, then run the command again. Press Esc to cancel.",
	);
	expect(editor.setText).not.toHaveBeenCalled();

	await editor.onSubmit?.("[image1] describe it");
	expect(mode.compactionQueuedMessages).toEqual([{ text: "describe it", mode: "steer", images: [image] }]);
	expect(editor.setText).toHaveBeenCalledWith("");
});

test("does not submit a clipboard image whose placeholder was deleted", () => {
	const image1: ImageContent = { type: "image", data: "image-1", mimeType: "image/png" };
	const image2: ImageContent = { type: "image", data: "image-2", mimeType: "image/png" };
	const editor = { setAtomicMarkers: vi.fn() };
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map([
			[1, image1],
			[2, image2],
		]),
		clipboardImageCounter: 2,
	});

	const input = (InteractiveMode.prototype as any).takeClipboardInput.call(mode, "describe [image2]");

	expect(input).toEqual({ text: "describe", images: [image2] });
	const staleHistoryInput = (InteractiveMode.prototype as any).takeClipboardInput.call(mode, "repeat [image1]");
	expect(staleHistoryInput).toEqual({ text: "repeat", images: undefined });
});

test("releases clipboard images when their atomic markers are deleted", () => {
	const image: ImageContent = { type: "image", data: "image", mimeType: "image/png" };
	let text = "[image2]";
	const editor = { getText: () => text, setAtomicMarkers: vi.fn() };
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map([
			[1, image],
			[2, image],
		]),
		clipboardImageCounter: 2,
	});

	(InteractiveMode.prototype as any).removeClipboardImage.call(mode, "[image1]");
	expect([...mode.pendingClipboardImages.keys()]).toEqual([2]);
	expect(editor.setAtomicMarkers).toHaveBeenLastCalledWith(["[image2]"]);

	text = "";
	(InteractiveMode.prototype as any).removeClipboardImage.call(mode, "[image2]");
	expect(mode.pendingClipboardImages.size).toBe(0);
	expect(mode.clipboardImageCounter).toBe(0);
});

test("clearing the editor also clears pending clipboard images", () => {
	const image: ImageContent = { type: "image", data: "image", mimeType: "image/png" };
	const editor = { setText: vi.fn(), setAtomicMarkers: vi.fn() };
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map([[1, image]]),
		clipboardImageCounter: 1,
		ui: { requestRender: vi.fn() },
	});

	InteractiveMode.prototype.clearEditor.call(mode);

	expect(mode.pendingClipboardImages.size).toBe(0);
	expect(mode.clipboardImageCounter).toBe(0);
	expect(editor.setText).toHaveBeenCalledWith("");
});
