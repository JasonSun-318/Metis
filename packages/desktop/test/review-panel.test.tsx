// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopWorkspaceReviewSnapshot, MetisDesktopApi } from "../src/shared/desktop-api.ts";

vi.mock("@pierre/diffs/react", () => ({
	PatchDiff: ({
		options,
		patch,
	}: {
		readonly options: { readonly hunkSeparators?: string; readonly loadDiffFiles?: () => Promise<unknown> };
		readonly patch: string;
	}) => (
		<pre data-hunk-separators={options.hunkSeparators} data-testid="patch">
			{patch}
			<button onClick={() => void Promise.resolve(options.loadDiffFiles?.()).catch(() => {})} type="button">
				Expand unchanged
			</button>
		</pre>
	),
	WorkerPoolContextProvider: ({
		children,
		highlighterOptions,
	}: {
		readonly children: ReactNode;
		readonly highlighterOptions: { readonly theme: string };
	}) => (
		<div data-testid="worker-provider" data-theme={highlighterOptions.theme}>
			{children}
		</div>
	),
}));

import { ReviewPanel } from "../src/renderer/components/ReviewPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const commitHash = "0123456789abcdef0123456789abcdef01234567";

const workingTree: DesktopWorkspaceReviewSnapshot = {
	kind: "review",
	repositoryRoot: "/tmp/project",
	branch: "main",
	head: commitHash,
	revision: "working-tree",
	files: [
		{
			relativePath: "README.md",
			previousRelativePath: null,
			status: "modified",
			additions: 1,
			deletions: 1,
			binary: false,
		},
		{
			relativePath: "packages/src/nested.ts",
			previousRelativePath: null,
			status: "modified",
			additions: 2,
			deletions: 0,
			binary: false,
		},
	],
	commits: [
		{
			hash: commitHash,
			shortHash: "0123456",
			subject: "Initial commit",
			authorName: "Ada",
			authoredAt: "2026-08-05T00:00:00Z",
		},
	],
};

const commitSnapshot: DesktopWorkspaceReviewSnapshot = {
	...workingTree,
	revision: commitHash,
	files: [
		{
			relativePath: "package.json",
			previousRelativePath: null,
			status: "added",
			additions: 3,
			deletions: 0,
			binary: false,
		},
	],
};

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("ReviewPanel", () => {
	it("focuses a transcript file in the existing review without changing its scope", async () => {
		const api = {
			getWorkspaceReview: vi.fn().mockResolvedValue(workingTree),
			getWorkspaceReviewFileDiff: vi.fn().mockResolvedValue({ kind: "text", patch: "nested patch" }),
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (id: string, path?: string) =>
			act(async () =>
				root.render(<ReviewPanel api={api} sessionId={sessionId} visible focusRequest={{ id, path }} />),
			);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible />));
		await flush();
		const target = container.querySelectorAll<HTMLElement>(".review-file")[1]!;
		target.scrollIntoView = vi.fn();
		await render("first", "packages/src/nested.ts");
		await act(async () => new Promise(requestAnimationFrame));
		expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
		await flush();
		expect(api.getWorkspaceReview).toHaveBeenCalledExactlyOnceWith({ sessionId, revision: "working-tree" });
		expect(api.getWorkspaceReviewFileDiff).toHaveBeenCalledExactlyOnceWith({
			sessionId,
			revision: "working-tree",
			relativePath: "packages/src/nested.ts",
		});
		expect(container.querySelector('.review-file-header[aria-expanded="true"]')?.textContent).toContain("nested.ts");
		await render("missing", "../../../private/tmp/metis.icns");
		expect(container.querySelector("output")?.textContent).toBe("This file is not in the current review");
		await render("all");
		expect(container.querySelector("output")).toBeNull();
		expect(api.getWorkspaceReview).toHaveBeenCalledOnce();
		await act(async () => root.unmount());
	});

	it("keeps every diff collapsed and fetches only the file the user expands", async () => {
		const api = {
			getWorkspaceReview: vi.fn().mockResolvedValue(workingTree),
			getWorkspaceReviewFileDiff: vi.fn().mockResolvedValue({ kind: "text", patch: "README patch" }),
			getWorkspaceReviewFileContext: vi.fn().mockResolvedValue({
				kind: "text",
				oldFile: { name: "README.md", contents: "old", cacheKey: "old" },
				newFile: { name: "README.md", contents: "new", cacheKey: "new" },
			}),
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} theme="light" visible />));
		await flush();
		expect(container.querySelector('[data-testid="worker-provider"]')?.getAttribute("data-theme")).toBe(
			"pierre-light",
		);

		const headers = [...container.querySelectorAll<HTMLButtonElement>(".review-file-header")];
		expect(headers).toHaveLength(2);
		expect(headers.every((header) => header.getAttribute("aria-expanded") === "false")).toBe(true);
		expect(api.getWorkspaceReviewFileDiff).not.toHaveBeenCalled();

		await act(async () => headers[0]!.click());
		await flush();
		expect(api.getWorkspaceReviewFileDiff).toHaveBeenCalledWith({
			sessionId,
			revision: "working-tree",
			relativePath: "README.md",
		});
		expect(container.querySelector('[data-testid="patch"]')?.getAttribute("data-hunk-separators")).toBe(
			"line-info-basic",
		);
		expect(api.getWorkspaceReviewFileContext).not.toHaveBeenCalled();
		await act(async () => button(container, "Expand unchanged").click());
		await flush();
		expect(api.getWorkspaceReviewFileContext).toHaveBeenCalledWith({
			sessionId,
			revision: "working-tree",
			relativePath: "README.md",
		});
		await act(async () => root.unmount());
	});

	it("opens full information only from the folder button and keeps expanded patches mounted", async () => {
		const snapshot = {
			...workingTree,
			files: [
				...workingTree.files,
				{
					relativePath: ".codegraph/.gitignore",
					previousRelativePath: null,
					status: "modified",
					additions: 1,
					deletions: 0,
					binary: false,
				},
			],
		} satisfies DesktopWorkspaceReviewSnapshot;
		const api = {
			getWorkspaceReview: vi.fn().mockResolvedValue(snapshot),
			getWorkspaceReviewFileDiff: vi.fn().mockResolvedValue({ kind: "text", patch: "README patch" }),
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible />));
		await flush();

		expect(container.querySelector(".review-details")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".review-file-header")!.click());
		await flush();
		await act(async () => button(container, "Show review details").click());
		expect(container.textContent).toContain("Recent commits");
		expect(container.querySelector(".review-toolbar > span")?.textContent).toBe("main → project");
		expect(container.querySelector(".review-toolbar > span")?.getAttribute("title")).toBe("/tmp/project");
		const allChanges = button(container, "All Changes");
		expect(allChanges.textContent).toBe("All Changes");
		expect(container.querySelector(".review-details-scroll")?.compareDocumentPosition(allChanges) ?? 0).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		const directories = [...container.querySelectorAll<HTMLButtonElement>(".review-tree button[aria-expanded]")];
		expect(directories.length).toBeGreaterThan(0);
		expect(directories.every((directory) => directory.getAttribute("aria-expanded") === "true")).toBe(true);
		expect(container.textContent).toContain(".codegraph");
		expect(container.textContent).toContain(".gitignore");
		expect(container.textContent).toContain("nested.ts");
		await act(async () => button(container, "Hide review details").click());
		expect(container.querySelector(".review-details")?.classList.contains("is-hidden")).toBe(true);
		expect(container.querySelector('[data-testid="patch"]')?.textContent).toContain("README patch");
		expect(api.getWorkspaceReviewFileDiff).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("keeps the rendered review and worker provider mounted until a revision replacement is ready", async () => {
		let resolveCommit!: (value: DesktopWorkspaceReviewSnapshot) => void;
		const api = {
			getWorkspaceReview: vi.fn().mockImplementation(({ revision }: { readonly revision: string }) =>
				revision === "working-tree"
					? Promise.resolve(workingTree)
					: new Promise<DesktopWorkspaceReviewSnapshot>((resolve) => {
							resolveCommit = resolve;
						}),
			),
			getWorkspaceReviewFileDiff: vi.fn(),
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible />));
		await flush();
		await act(async () => button(container, "Show review details").click());
		const provider = container.querySelector('[data-testid="worker-provider"]');
		expect(provider).not.toBeNull();

		await act(async () => button(container, "Initial commit0123456 · Ada").click());
		expect(container.querySelector('[data-testid="worker-provider"]')).toBe(provider);
		expect(container.textContent).toContain("README.md");
		expect(container.textContent).not.toContain("Loading review…");
		await act(async () => resolveCommit(commitSnapshot));
		await flush();
		expect(container.querySelector('[data-testid="worker-provider"]')).toBe(provider);
		expect(container.textContent).toContain("package.json");
		expect(container.textContent).not.toContain("README.md");
		await act(async () => root.unmount());
	});

	it("keeps file actions bound to the displayed revision after a replacement fails", async () => {
		const api = {
			getWorkspaceReview: vi
				.fn()
				.mockImplementation(({ revision }: { readonly revision: string }) =>
					revision === "working-tree"
						? Promise.resolve(workingTree)
						: Promise.reject(new Error("commit unavailable")),
				),
			getWorkspaceReviewFileDiff: vi.fn().mockResolvedValue({ kind: "text", patch: "README patch" }),
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible />));
		await flush();
		await act(async () => button(container, "Show review details").click());
		await act(async () => button(container, "Initial commit0123456 · Ada").click());
		await flush();
		expect(container.textContent).toContain("README.md");

		await act(async () => container.querySelector<HTMLButtonElement>(".review-file-header")!.click());
		await flush();
		expect(api.getWorkspaceReviewFileDiff).toHaveBeenCalledWith({
			sessionId,
			revision: "working-tree",
			relativePath: "README.md",
		});
		await act(async () => root.unmount());
	});

	it("switches to a commit snapshot collapsed and renders honest non-text states", async () => {
		const api = {
			getWorkspaceReview: vi
				.fn()
				.mockImplementation(({ revision }: { readonly revision: string }) =>
					Promise.resolve(revision === "working-tree" ? workingTree : commitSnapshot),
				),
			getWorkspaceReviewFileDiff: vi.fn().mockResolvedValue({ kind: "binary" }),
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible />));
		await flush();
		await act(async () => button(container, "Show review details").click());
		await act(async () => button(container, "Initial commit0123456 · Ada").click());
		await flush();

		expect(api.getWorkspaceReview).toHaveBeenLastCalledWith({ sessionId, revision: commitHash });
		const header = container.querySelector<HTMLButtonElement>(".review-file-header")!;
		expect(header.textContent).toContain("package.json");
		expect(header.getAttribute("aria-expanded")).toBe("false");
		await act(async () => header.click());
		await flush();
		expect(container.textContent).toContain("Binary file changed");
		await act(async () => root.unmount());
	});

	it("announces an initial review failure and retries in place", async () => {
		const getWorkspaceReview = vi
			.fn()
			.mockRejectedValueOnce(new Error("review unavailable"))
			.mockResolvedValueOnce(workingTree);
		const api = { getWorkspaceReview } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible />));
		await flush();
		const alert = container.querySelector(".review-empty.is-error");
		expect(alert?.getAttribute("role")).toBe("alert");
		expect(alert?.textContent).toContain("Unable to load review");
		await act(async () => button(container, "Retry").click());
		await flush();
		expect(getWorkspaceReview).toHaveBeenCalledTimes(2);
		expect(container.querySelector(".review-empty.is-error")).toBeNull();
		expect(container.textContent).toContain("README.md");
		await act(async () => root.unmount());
	});

	it("announces a diff failure and retries the expanded file", async () => {
		const getWorkspaceReviewFileDiff = vi
			.fn()
			.mockRejectedValueOnce(new Error("diff unavailable"))
			.mockResolvedValueOnce({ kind: "text", patch: "README patch" });
		const api = {
			getWorkspaceReview: vi.fn().mockResolvedValue(workingTree),
			getWorkspaceReviewFileDiff,
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible />));
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>(".review-file-header")!.click());
		await flush();
		const alert = container.querySelector(".review-diff-state.is-error");
		expect(alert?.getAttribute("role")).toBe("alert");
		expect(alert?.textContent).toContain("Unable to load diff");
		await act(async () => button(container, "Retry").click());
		await flush();
		expect(getWorkspaceReviewFileDiff).toHaveBeenCalledTimes(2);
		expect(container.querySelector(".review-diff-state.is-error")).toBeNull();
		expect(container.querySelector('[data-testid="patch"]')?.textContent).toContain("README patch");
		await act(async () => root.unmount());
	});

	it("reports supplemental context failure as status without replacing the diff", async () => {
		const getWorkspaceReviewFileContext = vi
			.fn()
			.mockRejectedValueOnce(new Error("context unavailable"))
			.mockResolvedValueOnce({
				kind: "text",
				oldFile: { name: "README.md", contents: "old", cacheKey: "old" },
				newFile: { name: "README.md", contents: "new", cacheKey: "new" },
			});
		const api = {
			getWorkspaceReview: vi.fn().mockResolvedValue(workingTree),
			getWorkspaceReviewFileDiff: vi.fn().mockResolvedValue({ kind: "text", patch: "README patch" }),
			getWorkspaceReviewFileContext,
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible />));
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>(".review-file-header")!.click());
		await flush();
		await act(async () => button(container, "Expand unchanged").click());
		await flush();
		const status = container.querySelector(".review-context-error");
		expect(status).toBeInstanceOf(HTMLOutputElement);
		expect(status?.textContent).toContain("Unable to load unchanged context");
		expect(container.querySelector('[data-testid="patch"]')?.textContent).toContain("README patch");
		await act(async () => button(container, "Expand unchanged").click());
		await flush();
		expect(getWorkspaceReviewFileContext).toHaveBeenCalledTimes(2);
		expect(container.querySelector(".review-context-error")).toBeNull();
		await act(async () => root.unmount());
	});
});
