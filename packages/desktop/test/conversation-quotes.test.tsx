// @vitest-environment jsdom
import type { ItemView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeTranscriptTurn } from "../src/renderer/components/CodeTranscriptTurn.tsx";
import { Composer, type ComposerSubmission } from "../src/renderer/components/Composer.tsx";
import {
	ConversationQuoteProvider,
	type DraftConversationQuote,
	useConversationQuotes,
} from "../src/renderer/components/ConversationQuoteContext.tsx";
import { selectedConversationQuote } from "../src/renderer/components/TranscriptQuoteSelection.tsx";
import { TranscriptTurn } from "../src/renderer/components/TranscriptTurn.tsx";
import { composerPayload, composerRequestKey } from "../src/renderer/composer-submission.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});
const quote: DraftConversationQuote = {
	id: "quote-1",
	sessionId: "session-one",
	input: { sourceItemId: "answer-1", sourceRole: "assistant", selectedText: "Selected original answer" },
};

describe("conversation quote drafts", () => {
	it("includes literal snapshots in payload and request identity", () => {
		const input = { text: "Explain", attachments: [], conversationQuotes: [quote.input] };
		expect(composerPayload(input)).toEqual({ text: "Explain", conversationQuotes: [quote.input] });
		expect(composerRequestKey(input)).not.toBe(
			composerRequestKey({ ...input, conversationQuotes: [{ ...quote.input, selectedText: "Other text" }] }),
		);
	});
	it("isolates sessions, deduplicates snapshots, retains failed sends and clears only accepted drafts", async () => {
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		let actions!: NonNullable<ReturnType<typeof useConversationQuotes>>;
		let accept!: () => void;
		const unboundSubmit = vi.fn().mockResolvedValue(undefined);
		const submit = vi
			.fn<(input: ComposerSubmission) => Promise<void>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						accept = resolve;
					}),
			);
		function Capture() {
			actions = useConversationQuotes()!;
			return (
				<>
					<div data-composer="one">
						<Composer
							disabled={false}
							running={false}
							selectionSessionId="session-one"
							inputId="composer-one"
							onSubmit={submit}
							onInterrupt={async () => {}}
						/>
					</div>
					<div data-composer="unbound">
						<Composer
							disabled={false}
							running={false}
							inputId="composer-unbound"
							onSubmit={unboundSubmit}
							onInterrupt={async () => {}}
						/>
					</div>
					<div data-composer="two">
						<Composer
							disabled={false}
							running={false}
							selectionSessionId="session-two"
							inputId="composer-two"
							onSubmit={vi.fn()}
							onInterrupt={async () => {}}
						/>
					</div>
				</>
			);
		}
		const render = (enabled: boolean) =>
			root.render(
				<ConversationQuoteProvider enabled={enabled}>
					<Capture />
				</ConversationQuoteProvider>,
			);
		try {
			await act(async () => render(true));
			act(() => {
				actions.add(quote);
				actions.add({ ...quote, id: "duplicate" });
				actions.add({
					...quote,
					id: "other",
					sessionId: "session-two",
					input: { ...quote.input, selectedText: "Other session" },
				});
			});
			expect(actions.drafts).toHaveLength(2);
			expect(node.querySelector('[data-composer="unbound"] .composer-conversation-quotes')).toBeNull();
			const unboundEditor = node.querySelector<HTMLElement>("#composer-unbound")!;
			act(() => {
				unboundEditor.textContent = "A new task";
				unboundEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));
			});
			await act(async () =>
				unboundEditor.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
			);
			expect(unboundSubmit.mock.lastCall?.[0].conversationQuotes).toBeUndefined();
			expect(actions.drafts).toHaveLength(2);

			expect(node.querySelector('[data-composer="one"] .composer-conversation-quotes')?.textContent).toContain(
				quote.input.selectedText,
			);
			expect(node.querySelector('[data-composer="one"] .composer-conversation-quotes')?.textContent).not.toContain(
				"Other session",
			);
			const editor = node.querySelector<HTMLElement>("#composer-one")!;
			act(() => {
				editor.textContent = "Explain this";
				editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
			});
			await act(async () =>
				editor.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
			);
			expect(actions.drafts).toHaveLength(2);
			expect(editor.textContent).toBe("Explain this");
			act(() => editor.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
			expect(submit.mock.lastCall?.[0]).toMatchObject({ conversationQuotes: [quote.input] });
			act(() => actions.add({ ...quote, id: "new", input: { ...quote.input, selectedText: "New selection" } }));
			await act(async () => accept());
			expect(actions.drafts.map((item) => item.id)).toEqual(["other", "new"]);
			expect(actions.lastAccepted?.sessionId).toBe("session-one");
			await act(async () => render(false));
			expect(() => actions.add(quote)).toThrow();
			const stale = actions;
			await act(async () => root.unmount());
			expect(() => stale.add(quote)).toThrow();
		} finally {
			node.remove();
		}
	});
	it("enforces per-session count and UTF-8 size without altering existing drafts", async () => {
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		let actions!: NonNullable<ReturnType<typeof useConversationQuotes>>;
		function Capture() {
			actions = useConversationQuotes()!;
			return null;
		}
		await act(async () =>
			root.render(
				<ConversationQuoteProvider enabled>
					<Capture />
				</ConversationQuoteProvider>,
			),
		);
		expect(() => actions.add({ ...quote, input: { ...quote.input, selectedText: "中".repeat(8001) } })).toThrow();
		act(() => {
			for (let index = 0; index < 8; index++)
				actions.add({ ...quote, id: `q${index}`, input: { ...quote.input, selectedText: `text-${index}` } });
		});
		expect(() => actions.add(quote)).toThrow();
		expect(actions.drafts).toHaveLength(8);
		await act(async () => root.unmount());
	});
});

describe("sent conversation annotations", () => {
	it.each(["chat", "code"] as const)("uses a below-bubble count and safe source popover in %s", async (mode) => {
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		const item: ItemView = {
			itemId: "user-2",
			sessionId: "session-one",
			role: "user",
			state: "completed",
			content: [{ type: "text", text: "Explain this" }],
			createdAt: "2026-10-15T00:00:00Z",
			conversationQuotes: [
				{ ...quote.input, selectedText: "<img src=x onerror=alert(1)>", sourceLiveItemId: "live:alias" },
			],
		};
		const Turn = mode === "chat" ? TranscriptTurn : CodeTranscriptTurn;
		const jump = vi.fn();
		await act(async () => root.render(<Turn items={[item]} onJumpToQuote={jump} />));
		const bubble = node.querySelector(".message-user, .code-turn-user-bubble")!;
		const trigger = node.querySelector<HTMLButtonElement>(".message-annotations-trigger")!;
		expect(bubble.textContent).toBe("Explain this");
		expect(bubble.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(node.querySelectorAll(".message-file-selection")).toHaveLength(0);
		await act(async () => trigger.click());
		const popover = document.querySelector(".message-annotations-popover")!;
		expect(popover.querySelector("blockquote")?.textContent).toBe(item.conversationQuotes![0]!.selectedText);
		expect(popover.querySelector("img")).toBeNull();
		await act(async () => (popover.querySelector(".message-annotation-source button") as HTMLButtonElement).click());
		expect(jump).toHaveBeenCalledWith("answer-1", "live:alias");
		expect(document.querySelector(".message-annotations-popover")).toBeNull();
		await act(async () => trigger.click());
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector(".message-annotations-popover")).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await act(async () => root.unmount());
	});
	it("captures literal same-message selections and rejects cross-message, foreign-session and UI selections", () => {
		const node = document.createElement("div");
		document.body.append(node);
		node.innerHTML =
			'<p data-quote-item="answer-1">Original answer</p><p data-quote-item="answer-2">Other answer</p><button>UI</button>';
		const item = {
			itemId: "answer-1",
			sessionId: "session-one",
			role: "assistant",
			state: "completed",
			content: [],
			createdAt: "2026-10-15T00:00:00Z",
		} as ItemView;
		const items = new Map([[item.itemId, item]]);
		const range = document.createRange();
		range.setStart(node.firstChild!.firstChild!, 2);
		range.setEnd(node.firstChild!.firstChild!, 10);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		expect(selectedConversationQuote(node, "session-one", items, selection)?.input).toEqual({
			sourceItemId: "answer-1",
			sourceRole: "assistant",
			selectedText: "iginal a",
		});
		expect(selectedConversationQuote(node, "session-two", items, selection)).toBeNull();
		range.setEnd(node.children[1]!.firstChild!, 5);
		selection.removeAllRanges();
		selection.addRange(range);
		expect(selectedConversationQuote(node, "session-one", items, selection)).toBeNull();
		range.selectNodeContents(node.children[2]!);
		selection.removeAllRanges();
		selection.addRange(range);
		expect(selectedConversationQuote(node, "session-one", items, selection)).toBeNull();
	});
});
