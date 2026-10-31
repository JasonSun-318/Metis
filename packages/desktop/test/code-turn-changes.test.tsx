// @vitest-environment jsdom
import type { CodeChangesView, ItemView } from "@metis/app-protocol";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CodeTranscriptTurn } from "../src/renderer/components/CodeTranscriptTurn.tsx";
import { CodeTurnChanges } from "../src/renderer/components/CodeTurnChanges.tsx";

vi.mock("@pierre/diffs/react", () => ({
	FileDiff: () => <pre>saved diff</pre>,
	WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children,
}));
const step: CodeChangesView = {
	version: 1,
	sequence: 1,
	partial: false,
	turn: { additions: 1, deletions: 1, partial: false },
	files: [
		{
			path: "src/main.ts",
			kind: "modified",
			additions: 1,
			deletions: 1,
			diff: "--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new\n",
		},
	],
};

async function mount(children: ReactNode) {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(children));
	return {
		container,
		dispose: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

describe("Code file-change panel", () => {
	it("opens the existing review from file and header buttons without nesting another diff", async () => {
		const onViewChanges = vi.fn();
		const { container, dispose } = await mount(
			<CodeTurnChanges
				onViewChanges={onViewChanges}
				snapshots={[step, { ...step, sequence: 2, turnFiles: step.files.map(({ diff: _diff, ...file }) => file) }]}
			/>,
		);
		expect(container.querySelectorAll(".code-turn-file")).toHaveLength(1);
		expect(container.querySelector("header .code-turn-change-counts")).not.toBeNull();
		expect(container.querySelector("footer")).toBeNull();
		expect(container.querySelector(".code-turn-file .code-change-additions")?.textContent).toBe("+1");
		await act(async () => container.querySelector<HTMLElement>(".code-turn-file")!.click());
		expect(onViewChanges).toHaveBeenLastCalledWith("src/main.ts");
		expect(container.querySelector(".code-file-diff")).toBeNull();
		await act(async () => container.querySelector<HTMLElement>(".code-turn-review")!.click());
		expect(onViewChanges.mock.calls.at(-1)).toEqual([]);
		await dispose();
	});
	it("never adds historical repeated step counts", async () => {
		const { container, dispose } = await mount(<CodeTurnChanges snapshots={[step, { ...step, sequence: 2 }]} />);
		expect(container.querySelector(".code-turn-file")?.getAttribute("title")).toContain(
			"Net line counts not recorded",
		);
		expect(container.querySelector(".code-turn-file .code-change-counts")).toBeNull();
		await dispose();
	});
	it("excludes formatted and binary files without leftover badges or warnings", async () => {
		const files: CodeChangesView["files"] = [
			...step.files,
			{ path: "../../../private/tmp/metis.icns", kind: "added", binary: true },
			{ path: "../../../private/tmp/metis.rsrc", kind: "added", additions: 0, deletions: 0 },
			{ path: "report.pdf", kind: "added", additions: 80, deletions: 0 },
		];
		const changes = { ...step, partial: true, turn: { ...step.turn, partial: true }, files, turnFiles: files };
		const { container, dispose } = await mount(<CodeTurnChanges snapshots={[changes]} />);
		expect(container.querySelectorAll(".code-turn-file")).toHaveLength(1);
		expect(container.textContent).toContain("Changed 1 files");
		expect(container.textContent).not.toMatch(/Binary file|Empty file|Outside project|Some file changes|Counted/);
		expect(container.querySelector("header .code-change-additions")?.textContent).toBe("+1");
		expect(container.querySelector("header .code-change-counts")?.getAttribute("title")).toContain(
			"Recorded text changes",
		);
		expect(container.querySelector("footer")).toBeNull();
		await dispose();
	});
	it("omits an all-binary card and expands only remaining text files within the card", async () => {
		const onViewChanges = vi.fn();
		const files = Array.from({ length: 10 }, (_, i) => ({
			path: `src/file-${i}.ts`,
			kind: "added" as const,
			additions: 1,
			deletions: 0,
		}));
		const { container, dispose } = await mount(
			<CodeTurnChanges snapshots={[{ ...step, files, turnFiles: files }]} onViewChanges={onViewChanges} />,
		);
		const drawer = container.querySelector<HTMLElement>(".code-turn-files-drawer")!;
		const disclosure = container.querySelector<HTMLButtonElement>(".code-turn-more")!;
		expect(container.querySelectorAll(".code-turn-changes > .code-turn-file")).toHaveLength(3);
		expect(drawer.querySelectorAll(".code-turn-file")).toHaveLength(7);
		expect(container.querySelector("header .code-change-counts")).toBeNull();
		expect(container.querySelector("footer .code-change-additions")?.textContent).toBe("+10");
		expect(disclosure.textContent).toContain("View 7 other file changes");
		expect(drawer.hasAttribute("inert")).toBe(true);
		await act(async () => disclosure.click());
		expect(disclosure.getAttribute("aria-expanded")).toBe("true");
		expect(drawer.hasAttribute("inert")).toBe(false);
		expect(onViewChanges).not.toHaveBeenCalled();
		await act(async () => disclosure.click());
		expect(drawer.hasAttribute("inert")).toBe(true);
		await dispose();
		const binary = { ...step, files: [{ path: "logo.png", kind: "added" as const, binary: true }] };
		const empty = await mount(<CodeTurnChanges snapshots={[binary]} />);
		expect(empty.container.querySelector(".code-turn-changes")).toBeNull();
		await empty.dispose();
	});
	it("places the summary after the public final reply", async () => {
		const base = {
			sessionId: "session",
			turnId: "turn",
			state: "completed" as const,
			createdAt: "2026-10-30T00:00:00Z",
		};
		const items: ItemView[] = [
			{
				...base,
				itemId: "tool",
				role: "assistant",
				content: [{ type: "tool_call", toolCallId: "edit", name: "edit", state: "completed" }],
			},
			{
				...base,
				itemId: "result",
				role: "tool",
				content: [
					{
						type: "tool_result",
						toolCallId: "edit",
						name: "edit",
						isError: false,
						output: "ok",
						codeChanges: { ...step, turnFiles: step.files },
					},
				],
			},
			{ ...base, itemId: "final", role: "assistant", content: [{ type: "text", text: "Done." }] },
		];
		const { container, dispose } = await mount(<CodeTranscriptTurn items={items} />);
		const answer = container.querySelector("[data-transcript-answer]")!;
		expect(answer.compareDocumentPosition(container.querySelector(".code-turn-changes")!)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		await dispose();
	});
});
