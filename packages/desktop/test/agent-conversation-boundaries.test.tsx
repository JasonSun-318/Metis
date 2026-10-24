// @vitest-environment jsdom
import type { DurableImageRefView, InteractionView, ItemView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeTranscriptTurn } from "../src/renderer/components/CodeTranscriptTurn.tsx";
import { ConversationScopeContext } from "../src/renderer/components/ConversationScope.tsx";
import { previewCacheKey } from "../src/renderer/components/preview/preview-bytes-cache.ts";
import { ToolResultImages } from "../src/renderer/components/ToolResultImages.tsx";
import { TranscriptTurn } from "../src/renderer/components/TranscriptTurn.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { firstInteractionForSession } from "../src/renderer/session-view-utils.ts";
import { validateReadPreviewFileInput } from "../src/shared/desktop-api.ts";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const roots: Root[] = [];
const notice: ItemView = {
	sessionId: ROOT,
	itemId: "notice",
	role: "system",
	origin: { kind: "system", eventId: "event" },
	agentTargetId: CHILD,
	deliveryState: "accepted",
	content: [{ type: "text", text: "User corrected the image task" }],
	state: "completed",
	createdAt: "2026-10-23T00:00:00.000Z",
};
const image: DurableImageRefView = { hash: "a".repeat(64), mediaType: "image/png", byteLength: 10 };
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});
describe("agent conversation boundaries", () => {
	it.each(["chat", "code"])("keeps %s internal coordination out of the parent transcript", async (mode) => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		const openAgent = vi.fn();
		const notices: ItemView[] = [
			{ ...notice, agentMessageId: "intervention-message" },
			{ ...notice, itemId: "terminal", content: [{ type: "text", text: "Worker: done\nLong internal report" }] },
			{ ...notice, itemId: "control", content: [{ type: "text", text: "You stopped Worker and its agents." }] },
		];
		const parentSummary: ItemView = {
			...notice,
			itemId: "parent-summary",
			role: "assistant",
			origin: undefined,
			content: [{ type: "text", text: "The worker stopped at your request." }],
		};
		await act(async () =>
			root.render(
				<ConversationScopeContext.Provider value={{ openAgent }}>
					{mode === "chat" ? (
						<TranscriptTurn items={[...notices, parentSummary]} />
					) : (
						<CodeTranscriptTurn items={[...notices, parentSummary]} />
					)}
				</ConversationScopeContext.Provider>,
			),
		);
		expect(container.textContent).toContain("The worker stopped at your request.");
		expect(container.textContent).not.toMatch(/User corrected|Long internal report|You stopped Worker|Saved/);
		expect(container.querySelector(".agent-coordination-message")).toBeNull();
		expect(container.querySelector(".message-origin")).toBeNull();
		expect(openAgent).not.toHaveBeenCalled();
		// Rendering must not consume the durable events or replace their content.
		expect(notices[0]!.agentMessageId).toBe("intervention-message");
		expect(notices[1]!.content).toEqual([{ type: "text", text: "Worker: done\nLong internal report" }]);
	});
	it.each(["chat", "code"])(
		"preserves %s human messages, agent instructions and ordinary system warnings",
		async (mode) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			roots.push(root);
			const input: ItemView = {
				...notice,
				role: "user",
				origin: { kind: "user" },
				agentMessageId: "human-message",
				content: [{ type: "text", text: "Use the revised brief" }],
			};
			const instruction: ItemView = {
				...input,
				itemId: "instruction",
				origin: { kind: "agent", sessionId: ROOT },
				content: [{ type: "text", text: "Inspect the requested directory" }],
			};
			const warning: ItemView = {
				...notice,
				itemId: "warning",
				agentTargetId: undefined,
				agentMessageId: "system-notice",
				content: [{ type: "notice", level: "warning", text: "Connection interrupted" }],
			};
			const items = [input, instruction, warning];
			await act(async () =>
				root.render(mode === "chat" ? <TranscriptTurn items={items} /> : <CodeTranscriptTurn items={items} />),
			);
			expect(container.textContent).toContain("Use the revised brief");
			expect(container.textContent).toContain("Inspect the requested directory");
			expect(container.querySelector(".notice-warning")?.textContent).toBe("Connection interrupted");
			expect(container.querySelectorAll("[data-user-message]")).toHaveLength(2);
		},
	);
	it("reads child tool images through the root owner without replacing the child id", async () => {
		const readSessionImage = vi.fn().mockResolvedValue({ mediaType: "image/png", data: "aGVsbG8=" });
		vi.stubGlobal("metis", { readSessionImage });
		const container = document.createElement("div");
		const root = createRoot(container);
		roots.push(root);
		await act(async () =>
			root.render(
				<ConversationScopeContext.Provider value={{ rootSessionId: ROOT }}>
					<ToolResultImages sessionId={CHILD} images={[image]} />
				</ConversationScopeContext.Provider>,
			),
		);
		expect(readSessionImage).toHaveBeenCalledWith({ sessionId: CHILD, rootSessionId: ROOT, image });
	});
	it("routes root-owned interactions to their actual child actor", () => {
		const pending: InteractionView = {
			interactionId: "question",
			sessionId: ROOT,
			rootSessionId: ROOT,
			actorSessionId: CHILD,
			kind: "confirm",
			title: "Continue?",
			message: "Confirm step",
			createdAt: "2026-10-23T00:00:00.000Z",
		};
		const interactions = new Map([[pending.interactionId, pending]]);
		expect(firstInteractionForSession([pending.interactionId], interactions, ROOT)).toBeUndefined();
		expect(firstInteractionForSession([pending.interactionId], interactions, CHILD)).toBe(pending);
	});
	it("preserves and validates preview ownership and keeps its cache separate", () => {
		const owned = { source: "delivered" as const, sessionId: CHILD, rootSessionId: ROOT, fileId: "aaaaaaaaaaaaaaaa" };
		expect(validateReadPreviewFileInput(owned)).toEqual(owned);
		expect(validateReadPreviewFileInput({ source: "delivered", sessionId: ROOT, fileId: owned.fileId })).toEqual({
			source: "delivered",
			sessionId: ROOT,
			fileId: owned.fileId,
		});
		expect(() => validateReadPreviewFileInput({ ...owned, rootSessionId: "../private" })).toThrow();
		expect(previewCacheKey(owned)).not.toBe(
			previewCacheKey({ source: "delivered", sessionId: CHILD, fileId: owned.fileId }),
		);
	});
});
