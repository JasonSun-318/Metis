import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@metis/ai/compat";
import { afterEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
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

test("preserves blocked commands and queues numbered images during Compact/Memory extract", async () => {
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
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
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
		"Compact/Memory extract is running. Wait for it to finish, then run the command again. Press Esc to cancel.",
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
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
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
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
	});

	(InteractiveMode.prototype as any).removeClipboardAttachment.call(mode, "[image1]");
	expect([...mode.pendingClipboardImages.keys()]).toEqual([2]);
	expect(editor.setAtomicMarkers).toHaveBeenLastCalledWith(["[image2]"]);

	text = "";
	(InteractiveMode.prototype as any).removeClipboardAttachment.call(mode, "[image2]");
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
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
		runtimeHost: { services: { agentDir: "/unused" } },
		ui: { requestRender: vi.fn() },
	});

	InteractiveMode.prototype.clearEditor.call(mode);

	expect(mode.pendingClipboardImages.size).toBe(0);
	expect(mode.clipboardImageCounter).toBe(0);
	expect(editor.setText).toHaveBeenCalledWith("");
});

test("keeps @ paths as ordinary text", () => {
	const root = mkdtempSync(join(tmpdir(), "metis-cli-at-path-"));
	temporaryDirectories.push(root);
	const source = join(root, "report.docx");
	writeFileSync(source, "docx");
	const editor = { setAtomicMarkers: vi.fn() };
	const sessionManager = {
		getCwd: () => root,
		getSessionId: () => "session-at-path",
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map(),
		clipboardImageCounter: 0,
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
		runtimeHost: { services: { agentDir: join(root, "agent") }, session: { sessionManager } },
	});

	const input = (InteractiveMode.prototype as any).takeClipboardInput.call(mode, `Ask @${source}`);

	expect(input.images).toBeUndefined();
	expect(input.text).toBe(`Ask @${source}`);
	expect(mode.pendingFileAttachments.size).toBe(0);
});

test("turns a pasted file outside the project into an atomic marker and deletes its unsent copy", () => {
	const root = mkdtempSync(join(tmpdir(), "metis-cli-marker-"));
	temporaryDirectories.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const source = join(root, "slides.pptx");
	writeFileSync(source, "pptx");
	let editorText = "";
	const editor = {
		getText: () => editorText,
		insertTextAtCursor: vi.fn((value: string) => {
			editorText += value;
		}),
		setAtomicMarkers: vi.fn(),
	};
	const sessionManager = {
		getCwd: () => cwd,
		getSessionId: () => "session-marker",
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map(),
		clipboardImageCounter: 0,
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
		runtimeHost: { services: { agentDir }, session: { sessionManager } },
		ui: { requestRender: vi.fn() },
	});

	expect((InteractiveMode.prototype as any).attachPastedFiles.call(mode, source)).toBe(true);
	expect(editorText).toBe("[file1:slides.pptx]");
	const ownedPath = mode.pendingFileAttachments.get(1).attachment.path;
	expect(existsSync(ownedPath)).toBe(true);

	editorText = "";
	(InteractiveMode.prototype as any).removeClipboardAttachment.call(mode, "[file1:slides.pptx]");
	expect(existsSync(ownedPath)).toBe(false);
	expect(mode.pendingFileAttachments.size).toBe(0);
});

test("attaches multiple shell-escaped dropped file paths", () => {
	const root = mkdtempSync(join(tmpdir(), "metis-cli-multiple-markers-"));
	temporaryDirectories.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const first = join(root, "first report.pdf");
	const second = join(root, "second deck.pptx");
	writeFileSync(first, "pdf");
	writeFileSync(second, "pptx");
	let editorText = "";
	const editor = {
		insertTextAtCursor: vi.fn((value: string) => {
			editorText += value;
		}),
		setAtomicMarkers: vi.fn(),
	};
	const sessionManager = {
		getCwd: () => cwd,
		getSessionId: () => "session-multiple-markers",
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map(),
		clipboardImageCounter: 0,
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
		runtimeHost: { services: { agentDir }, session: { sessionManager } },
		ui: { requestRender: vi.fn() },
	});

	const pasted = `${first.replaceAll(" ", "\\ ")} "${second}"`;
	expect((InteractiveMode.prototype as any).attachPastedFiles.call(mode, pasted)).toBe(true);
	expect(editorText).toBe("[file1:first report.pdf] [file2:second deck.pptx]");
	expect(mode.pendingFileAttachments.size).toBe(2);
});

test("deletes an unreferenced pending file when submitting the remaining marker", () => {
	const root = mkdtempSync(join(tmpdir(), "metis-cli-stale-marker-"));
	temporaryDirectories.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const first = join(root, "first.pdf");
	const second = join(root, "second.pdf");
	writeFileSync(first, "first");
	writeFileSync(second, "second");
	const editor = {
		insertTextAtCursor: vi.fn(),
		setAtomicMarkers: vi.fn(),
	};
	const sessionManager = {
		getCwd: () => cwd,
		getSessionId: () => "session-stale-marker",
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map(),
		clipboardImageCounter: 0,
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
		runtimeHost: { services: { agentDir }, session: { sessionManager } },
		ui: { requestRender: vi.fn() },
	});

	(InteractiveMode.prototype as any).attachFilePaths.call(mode, [first, second]);
	const kept = mode.pendingFileAttachments.get(1).attachment.path;
	const discarded = mode.pendingFileAttachments.get(2).attachment.path;
	const input = (InteractiveMode.prototype as any).takeClipboardInput.call(mode, "[file1:first.pdf] summarize");

	expect(input.text).toContain(kept);
	expect(existsSync(kept)).toBe(true);
	expect(existsSync(discarded)).toBe(false);
});

test("restores dequeued file references as atomic markers", () => {
	const attachment = { name: "report.pdf", path: "/owned/report.pdf", size: 12 };
	const queued = `<attachment>${JSON.stringify(attachment)}</attachment> summarize`;
	const editor = {
		getText: () => "",
		setText: vi.fn(),
		setAtomicMarkers: vi.fn(),
	};
	const session = {
		clearQueue: () => ({ steering: [queued], followUp: [] }),
		sessionManager: { getSessionId: () => "session-queue" },
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		pendingClipboardImages: new Map(),
		clipboardImageCounter: 0,
		pendingFileAttachments: new Map(),
		fileAttachmentCounter: 0,
		compactionQueuedMessages: [],
		runtimeHost: { session },
		updatePendingMessagesDisplay: vi.fn(),
	});

	expect((InteractiveMode.prototype as any).restoreQueuedMessagesToEditor.call(mode)).toBe(1);
	expect(editor.setText).toHaveBeenCalledWith("[file1:report.pdf] summarize");
	expect(mode.pendingFileAttachments.get(1)).toEqual({ attachment, sessionId: "session-queue" });
	expect(editor.setAtomicMarkers).toHaveBeenLastCalledWith(["[file1:report.pdf]"]);
});
