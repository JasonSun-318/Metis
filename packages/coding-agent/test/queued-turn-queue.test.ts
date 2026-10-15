import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_QUEUED_TURNS,
	QueuedTurnConflictError,
	QueuedTurnLimitError,
	QueuedTurnQueue,
} from "../src/core/queued-turn-queue.ts";
import { formatSessionAttachments } from "../src/core/session-attachments.ts";
import { formatSessionFileSelections, splitSessionFileSelectionPrompt } from "../src/core/session-file-selections.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const requestId = (index: number): string => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

describe("QueuedTurnQueue", () => {
	let root: string;
	let manager: SessionManager;
	let queue: QueuedTurnQueue;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-queued-turns-"));
		manager = SessionManager.create(root, join(root, "sessions"), { id: "queued-turns" });
		queue = new QueuedTurnQueue(manager);
	});

	afterEach(() => {
		manager.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps FIFO order and uses journal revisions for edits", () => {
		const first = queue.enqueue({ requestId: requestId(1), input: { text: "first" }, state: "enqueued" });
		queue.enqueue({ requestId: requestId(2), input: { text: "second" }, state: "enqueued" });
		expect(queue.list().map(({ input }) => input.text)).toEqual(["first", "second"]);

		const edited = queue.update({
			queueItemId: first.queueItemId,
			expectedRevision: first.revision,
			text: "edited",
		});
		expect(edited.input.text).toBe("edited");
		expect(edited.revision).not.toBe(first.revision);
		expect(() => queue.delete({ queueItemId: first.queueItemId, expectedRevision: first.revision })).toThrow(
			QueuedTurnConflictError,
		);
	});

	it("reuses its reduced journal projection until the journal changes", () => {
		const internal = queue as unknown as { journalProjection?: object };
		queue.list();
		const first = internal.journalProjection;
		queue.list();
		expect(internal.journalProjection).toBe(first);

		manager.appendMessage({ role: "user", content: "changed", timestamp: 1 });
		queue.list();
		expect(internal.journalProjection).not.toBe(first);
	});

	it("claims once, pauses without reordering, and blocks behind a paused head", () => {
		const first = queue.enqueue({ requestId: requestId(1), input: { text: "first" }, state: "enqueued" });
		queue.enqueue({ requestId: requestId(2), input: { text: "second" }, state: "enqueued" });
		const sending = queue.markDispatching({
			queueItemId: first.queueItemId,
			expectedRevision: first.revision,
			delivery: "start",
		});
		expect(() =>
			queue.markDispatching({
				queueItemId: first.queueItemId,
				expectedRevision: first.revision,
				delivery: "start",
			}),
		).toThrow(QueuedTurnConflictError);

		queue.pauseUndispatched("turn_interrupted");
		expect(queue.list().map(({ queueItemId }) => queueItemId)).toEqual([
			sending.queueItemId,
			queue.list()[1]?.queueItemId,
		]);
		expect(queue.list().every(({ state }) => state === "paused")).toBe(true);
		expect(queue.firstQueued()).toBeUndefined();
	});

	it("deletes terminal rows and preserves attachments during text-only edits", () => {
		const attachment = { name: "design.png", path: "/private/design.png", size: 42 };
		const first = queue.enqueue({
			requestId: requestId(1),
			input: { text: formatSessionAttachments("review", [attachment]) },
			state: "paused",
		});
		const attachmentOnly = queue.update({
			queueItemId: first.queueItemId,
			expectedRevision: first.revision,
			text: "",
		});
		expect(attachmentOnly.input.text).toContain("design.png");

		queue.delete({ queueItemId: attachmentOnly.queueItemId, expectedRevision: attachmentOnly.revision });
		expect(queue.list()).toEqual([]);
	});

	it("deduplicates enqueue IDs only for the same initial input and enforces the limit", () => {
		const first = queue.enqueue({ requestId: requestId(1), input: { text: "same" }, state: "enqueued" });
		expect(queue.enqueue({ requestId: requestId(1), input: { text: "same" }, state: "enqueued" })).toEqual(first);
		expect(() => queue.enqueue({ requestId: requestId(1), input: { text: "different" }, state: "enqueued" })).toThrow(
			"Request ID was reused",
		);

		for (let index = 2; index <= MAX_QUEUED_TURNS; index += 1) {
			queue.enqueue({ requestId: requestId(index), input: { text: String(index) }, state: "enqueued" });
		}
		expect(() =>
			queue.enqueue({ requestId: requestId(MAX_QUEUED_TURNS + 1), input: { text: "overflow" }, state: "enqueued" }),
		).toThrow(QueuedTurnLimitError);
	});

	it("preserves file selections when a queued request is edited and recovered", () => {
		const files = [
			{
				source: "workspace" as const,
				name: "README.md",
				path: "/repo/README.md",
				basis: "markdown" as const,
				selectedText: "old section",
				startLine: 5,
				endLine: 5,
			},
		];
		const first = queue.enqueue({
			requestId: requestId(1),
			input: { text: formatSessionFileSelections("edit", files) },
			state: "paused",
		});
		queue.update({ queueItemId: first.queueItemId, expectedRevision: first.revision, text: "make it shorter" });
		const restored = new QueuedTurnQueue(manager).list()[0]!;
		expect(splitSessionFileSelectionPrompt(restored.input.text)).toEqual({
			text: "make it shorter",
			fileSelections: files,
		});
	});

	it("preserves conversation quotes through queue edits and recovery", async () => {
		const { formatSessionConversationQuotes } = await import("../src/core/session-conversation-quotes.ts");
		const { splitSessionAttachmentPrompt } = await import("../src/core/session-attachments.ts");
		const quotes = [{ sourceItemId: "answer-1", sourceRole: "assistant" as const, selectedText: "Keep this quote" }];
		const first = queue.enqueue({
			requestId: requestId(1),
			input: { text: formatSessionConversationQuotes("explain", quotes) },
			state: "paused",
		});
		queue.update({ queueItemId: first.queueItemId, expectedRevision: first.revision, text: "shorter explanation" });
		const restored = new QueuedTurnQueue(manager).list()[0]!;
		expect(splitSessionAttachmentPrompt(restored.input.text)).toMatchObject({
			text: "shorter explanation",
			conversationQuotes: quotes,
		});
	});

	it("rejects empty edits without attachments", () => {
		const first = queue.enqueue({ requestId: requestId(1), input: { text: "first" }, state: "enqueued" });
		expect(() =>
			queue.update({ queueItemId: first.queueItemId, expectedRevision: first.revision, text: "  " }),
		).toThrow("must not be empty");
	});
});
