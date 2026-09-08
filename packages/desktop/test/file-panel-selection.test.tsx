// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FilePanel, type WorkspaceFileDraft } from "../src/renderer/components/FilePanel.tsx";
import { selectionFromText } from "../src/renderer/components/preview/file-selection.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps source positions independent of CodeMirror's rendered viewport", () => {
	const sourceText = `${"before\n".repeat(500)}  selected\nafter`;
	const start = sourceText.indexOf("  selected");
	expect(
		selectionFromText({
			file: { source: "workspace", sessionId: "one", relativePath: "code.ts", name: "code.ts" },
			sourceText,
			selectedText: "  selected",
			basis: "source",
			start,
			end: start + 10,
		})?.input,
	).toMatchObject({ selectedText: "  selected", startLine: 501, endLine: 501 });
});

it("ignores other tasks and prevents a pending refresh from overwriting local edits", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const file: WorkspaceFileDraft["file"] = {
		kind: "text",
		relativePath: "notes.md",
		absolutePath: "/workspace/notes.md",
		byteLength: 6,
		text: "before",
		revision: "one",
	};
	let listener!: Parameters<MetisDesktopApi["subscribe"]>[0];
	const readWorkspaceFile = vi.fn().mockResolvedValue(file);
	const api = {
		readWorkspaceFile,
		listWorkspaceDirectory: vi.fn().mockResolvedValue([]),
		subscribe: (value: typeof listener) => {
			listener = value;
			return () => {};
		},
	} as unknown as MetisDesktopApi;
	const props: ComponentProps<typeof FilePanel> = {
		activePath: "notes.md",
		api,
		cwd: "/workspace",
		sessionId: "one",
		visible: true,
		draft: { file, text: file.text, savedText: file.text },
		dirtyPaths: [],
		expandedPaths: [],
		onDraftChange: vi.fn(),
		onDraftLoaded: vi.fn(),
		onExpandedPathsChange: vi.fn(),
		onOpenFile: vi.fn(),
		onError: vi.fn(),
		onSave: vi.fn(),
		onWorkspaceMutation: vi.fn(),
		saving: false,
		savingPaths: [],
	};
	const emit = (sessionId: string) =>
		listener({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: { events: [{ type: "turn/completed", turn: { sessionId } }] },
			},
		} as Parameters<typeof listener>[0]);
	try {
		await act(async () => root.render(<FilePanel {...props} />));
		expect(readWorkspaceFile).toHaveBeenCalledOnce();
		vi.mocked(props.onDraftLoaded).mockClear();
		await act(async () => emit("another"));
		expect(readWorkspaceFile).toHaveBeenCalledOnce();
		let finish!: (value: typeof file) => void;
		readWorkspaceFile.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await act(async () => emit("one"));
		expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
		await act(async () =>
			root.render(<FilePanel {...props} draft={{ file, savedText: file.text, text: "local draft" }} />),
		);
		await act(async () => finish({ ...file, text: "agent edit", revision: "two" }));
		expect(props.onDraftLoaded).not.toHaveBeenCalled();
		expect(node.querySelector(".cm-content")?.textContent).toContain("local draft");
		await act(async () => emit("one"));
		expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
	} finally {
		await act(async () => root.unmount());
		node.remove();
	}
});
