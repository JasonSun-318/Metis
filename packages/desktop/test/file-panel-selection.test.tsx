// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { FilePanel, type WorkspaceFileDraft } from "../src/renderer/components/FilePanel.tsx";
import { selectionFromText } from "../src/renderer/components/preview/file-selection.ts";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(async () => {
	await setLocale("en");
});

function textFile(relativePath: string, text: string): WorkspaceFileDraft["file"] {
	return {
		kind: "text",
		relativePath,
		absolutePath: `/workspace/${relativePath}`,
		byteLength: text.length,
		text,
		revision: "one",
	};
}

function panelProps(
	api: MetisDesktopApi,
	overrides: Partial<ComponentProps<typeof FilePanel>> = {},
): ComponentProps<typeof FilePanel> {
	return {
		activePath: "notes.ts",
		api,
		cwd: "/workspace",
		sessionId: "one",
		visible: true,
		draft: null,
		dirtyPaths: [],
		expandedPaths: [],
		onDraftChange: vi.fn(),
		onDraftLoaded: vi.fn(),
		onExpandedPathsChange: vi.fn(),
		onOpenFile: vi.fn(),
		onError: vi.fn(),
		onSave: vi.fn().mockResolvedValue(undefined),
		onWorkspaceMutation: vi.fn(),
		saving: false,
		savingPaths: [],
		...overrides,
	};
}

function panelApi(readWorkspaceFile: MetisDesktopApi["readWorkspaceFile"]): MetisDesktopApi {
	return {
		readWorkspaceFile,
		listWorkspaceDirectory: vi.fn().mockResolvedValue([]),
	} as unknown as MetisDesktopApi;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function retryButton(container: ParentNode): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === "Retry",
	);
	if (!match) throw new Error("Missing Retry button");
	return match;
}

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

it("retries a failed same-path preview and loads the file without translating the backend detail", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const loaded = textFile("notes.ts", "const value = 1;");
	const readWorkspaceFile = vi
		.fn()
		.mockRejectedValueOnce(new Error("EACCES: raw backend detail"))
		.mockResolvedValueOnce(loaded);
	const props = panelProps(panelApi(readWorkspaceFile));
	try {
		await act(async () => root.render(<FilePanel {...props} />));
		await flush();
		expect(node.querySelector(".file-empty-state.is-error")?.textContent).toContain("EACCES: raw backend detail");
		await act(async () => retryButton(node).click());
		await flush();
		expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
		expect(readWorkspaceFile).toHaveBeenLastCalledWith({ sessionId: "one", relativePath: "notes.ts" });
		expect(props.onDraftLoaded).toHaveBeenCalledWith(loaded);
		expect(node.querySelector(".file-empty-state.is-error")).toBeNull();
		await act(async () =>
			root.render(<FilePanel {...props} draft={{ file: loaded, savedText: loaded.text, text: loaded.text }} />),
		);
		expect(node.querySelector(".cm-content")?.textContent).toContain("const value = 1;");
	} finally {
		await act(async () => root.unmount());
		node.remove();
	}
});

it("ignores superseded preview results and errors after switching paths", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const first = deferred<WorkspaceFileDraft["file"]>();
	const second = deferred<WorkspaceFileDraft["file"]>();
	const third = deferred<WorkspaceFileDraft["file"]>();
	const fourth = deferred<WorkspaceFileDraft["file"]>();
	const firstFile = textFile("first.ts", "first content");
	const secondFile = textFile("second.ts", "second content");
	const fourthFile = textFile("fourth.ts", "fourth content");
	const readWorkspaceFile = vi.fn(({ relativePath }: { readonly relativePath: string }) => {
		if (relativePath === "first.ts") return first.promise;
		if (relativePath === "second.ts") return second.promise;
		if (relativePath === "third.ts") return third.promise;
		return fourth.promise;
	});
	const props = panelProps(panelApi(readWorkspaceFile as MetisDesktopApi["readWorkspaceFile"]), {
		activePath: "first.ts",
	});
	try {
		await act(async () => root.render(<FilePanel {...props} />));
		await act(async () => root.render(<FilePanel {...props} activePath="second.ts" />));
		await act(async () => second.resolve(secondFile));
		await flush();
		expect(props.onDraftLoaded).toHaveBeenCalledWith(secondFile);
		await act(async () =>
			root.render(
				<FilePanel
					{...props}
					activePath="second.ts"
					draft={{ file: secondFile, savedText: secondFile.text, text: secondFile.text }}
				/>,
			),
		);
		expect(node.querySelector(".cm-content")?.textContent).toContain("second content");

		await act(async () => first.resolve(firstFile));
		await flush();
		expect(node.querySelector(".cm-content")?.textContent).toContain("second content");
		expect(node.querySelector(".cm-content")?.textContent).not.toContain("first content");

		await act(async () => root.render(<FilePanel {...props} activePath="third.ts" draft={null} />));
		await act(async () => root.render(<FilePanel {...props} activePath="fourth.ts" draft={null} />));
		await act(async () => fourth.resolve(fourthFile));
		await flush();
		expect(props.onDraftLoaded).toHaveBeenCalledWith(fourthFile);
		await act(async () => third.reject(new Error("stale preview failure")));
		await flush();
		expect(node.querySelector(".file-empty-state.is-error")).toBeNull();
		expect(props.onError).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount());
		node.remove();
	}
});

it("keeps a dirty draft and never reloads it after a failed preview", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const saved = textFile("notes.ts", "saved content");
	const dirty = { file: saved, savedText: saved.text, text: "unsaved local edit" };
	const readWorkspaceFile = vi.fn().mockRejectedValue(new Error("preview failed"));
	const props = panelProps(panelApi(readWorkspaceFile));
	try {
		await act(async () => root.render(<FilePanel {...props} />));
		await flush();
		expect(retryButton(node)).toBeDefined();
		await act(async () => root.render(<FilePanel {...props} draft={dirty} />));
		await flush();
		expect(readWorkspaceFile).toHaveBeenCalledOnce();
		expect(node.querySelector(".file-empty-state.is-error")).toBeNull();
		expect(node.querySelector(".cm-content")?.textContent).toContain("unsaved local edit");
		expect(props.onDraftLoaded).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount());
		node.remove();
	}
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
