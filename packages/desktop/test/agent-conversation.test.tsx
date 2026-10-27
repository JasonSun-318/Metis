// @vitest-environment jsdom
import type { AgentSummaryView, ItemView, QueuedTurnView } from "@metis/app-protocol";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConversation } from "../src/renderer/components/AgentConversation.tsx";
import type { Composer } from "../src/renderer/components/Composer.tsx";
import type { SessionChatViewContext } from "../src/renderer/components/SessionChatView.tsx";
import type { Transcript } from "../src/renderer/components/Transcript.tsx";
import { mergeAgentItems, refreshAgentItems } from "../src/renderer/hooks/use-agent-history.ts";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";

const mock = vi.hoisted(() => ({
	composers: new Map<string, ComponentProps<typeof Composer>>(),
	transcripts: [] as ComponentProps<typeof Transcript>[],
}));
vi.mock("../src/renderer/components/Composer.tsx", () => ({
	Composer: (props: ComponentProps<typeof Composer>) => {
		mock.composers.set(props.inputId!, props);
		return (
			<div data-composer={props.inputId}>
				{props.collaborationControl}
				{props.queuedTurnControl}
			</div>
		);
	},
}));
vi.mock("../src/renderer/components/Transcript.tsx", () => ({
	Transcript: (props: ComponentProps<typeof Transcript>) => {
		mock.transcripts.push(props);
		const { itemIds, itemsById } = props;
		return (
			<div data-transcript>
				{itemIds.map((id) => (
					<p key={id}>
						{itemsById
							.get(id)
							?.content.map((block) => (block.type === "text" ? block.text : ""))
							.join("")}
					</p>
				))}
			</div>
		);
	},
}));

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const DATE = "2026-10-23T00:00:00.000Z";
function agent(): AgentSummaryView {
	return {
		agentId: CHILD,
		rootSessionId: ROOT,
		parentSessionId: ROOT,
		agentPath: [CHILD],
		name: "Image review",
		agentType: "reviewer",
		depth: 1,
		status: "running",
		archived: false,
		tasks: [],
		createdAt: DATE,
		updatedAt: DATE,
		mode: "chat",
		tools: ["read"],
		writePolicy: "deny",
		runControl: "enabled",
	};
}
function item(id: string, text: string): ItemView {
	return {
		sessionId: CHILD,
		itemId: id,
		role: "assistant",
		state: "completed",
		content: [{ type: "text", text }],
		createdAt: DATE,
	};
}
const roots: Root[] = [];
function setup() {
	const listeners = new Set<(event: DesktopApiEvent) => void>();
	const api = {
		readAgentQueuedMessages: vi.fn().mockResolvedValue({ queuedTurns: [] as QueuedTurnView[] }),
		deleteAgentQueuedMessage: vi.fn().mockResolvedValue({ queueItemId: "pending", deleted: true }),
		sendAgentQueuedMessage: vi.fn().mockResolvedValue({
			agentId: CHILD,
			taskId: TASK,
			messageId: "pending",
			requestId: "request",
			delivery: "steer",
			state: "accepted",
			instructionRevision: 1,
		}),
		listAgents: vi.fn().mockResolvedValue({ agents: [agent()], nextAfterAgentId: null }),
		readAgentItems: vi
			.fn()
			.mockResolvedValue({ items: [item("first", "original assignment")], nextBeforeItemId: null }),
		subscribe: vi.fn((listener: (event: DesktopApiEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		sendAgentMessage: vi.fn().mockResolvedValue({
			agentId: CHILD,
			taskId: TASK,
			messageId: "message-1",
			requestId: "request-1",
			delivery: "steer",
			state: "accepted",
			instructionRevision: 1,
		}),
		controlAgent: vi
			.fn()
			.mockResolvedValue({ agentId: CHILD, state: "user_paused", scope: "subtree", requestId: "request-2" }),
		openSession: vi.fn(),
		subscribeSession: vi.fn(),
	} satisfies Partial<MetisDesktopApi>;
	const store = new AppStore();
	const context = {
		api,
		store,
		bootstrapped: true,
		onError: vi.fn(),
		onNotice: vi.fn(),
	} as unknown as SessionChatViewContext;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onOpenParent = vi.fn();
	const render = async (agentId = CHILD) => {
		await act(async () =>
			root.render(
				<AgentConversation
					context={context}
					target={{ sessionId: ROOT, agentId, name: "Image review" }}
					visible
					onOpenParent={onOpenParent}
				/>,
			),
		);
	};
	return { api, container, render, listeners, onOpenParent, context, store };
}
const submission = { text: "Check sizes first", attachments: [{ path: "/tmp/image.png", name: "image.png" }] };
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	mock.composers.clear();
	mock.transcripts.length = 0;
});
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("AgentConversation", () => {
	it("does not restore an edited queued message into a different child's composer after navigation", async () => {
		const { api, container, render } = setup();
		api.readAgentQueuedMessages.mockResolvedValue({
			queuedTurns: [
				{ queueItemId: "pending", revision: "rev", text: "Child A only", state: "queued", attachments: [] },
			],
		});
		let resolve!: () => void;
		api.deleteAgentQueuedMessage.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = () => done({ queueItemId: "pending", deleted: true });
				}),
		);
		await render();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')!.click());
		const other = "55555555-5555-4555-8555-555555555555";
		await render(other);
		await act(async () => resolve());
		expect(mock.composers.get(`agent-composer-${other}`)?.prefillRequest).toBeUndefined();
	});
	it("preserves older paged messages sharing the tail boundary timestamp", () => {
		const older = item("older", "Earlier message in the same millisecond");
		const boundary = item("boundary", "First tail message");
		const next = item("next", "New answer");
		expect(refreshAgentItems([older, boundary], [boundary, next], []).map((entry) => entry.itemId)).toEqual([
			"older",
			"boundary",
			"next",
		]);
	});
	it("replaces completed stream and admission placeholders with durable history", () => {
		const old = { ...item("older", "Earlier task"), createdAt: "2026-10-22T00:00:00.000Z" };
		const live = item("agent-live:answer", "Same answer");
		const pending = item("agent-input:request", "Correction");
		const durable = [item("saved-input", "Correction"), item("saved-answer", "Same answer")];
		const next = { ...item("agent-live:next", "New streamed answer"), state: "streaming" as const };
		expect(refreshAgentItems([old, live, pending], durable, [next]).map((entry) => entry.itemId)).toEqual([
			"older",
			"saved-input",
			"saved-answer",
			"agent-live:next",
		]);
	});
	it.each(["chat", "code"] as const)(
		"renders %s child progress in its current transcript turn, then clears on completion",
		async (mode) => {
			const { api, container, render, listeners } = setup();
			const task = {
				taskId: TASK,
				status: "running" as const,
				taskSummary: "Current task",
				createdAt: DATE,
				updatedAt: DATE,
			};
			const child = { ...agent(), mode, currentTask: task, retry: { attempt: 1, maxAttempts: 5, delayMs: 1000 } };
			api.listAgents.mockResolvedValue({ agents: [child], nextAfterAgentId: null });
			api.readAgentItems.mockResolvedValue({
				items: [
					{ ...item("old", "Old answer"), turnId: "old-turn", createdAt: "2026-10-22T00:00:00.000Z" },
					{ ...item("current", "Current tools"), turnId: "current-turn" },
					{ ...item("queued", "Next assignment"), agentTaskId: "next-task", deliveryState: "queued" },
				],
				nextBeforeItemId: null,
			});
			await render();
			expect(mock.transcripts.at(-1)).toMatchObject({
				activeTurnId: "current-turn",
				activeTurnStartedAt: DATE,
				retry: child.retry,
			});
			expect(container.querySelector(".conversation-composer .turn-runtime-status")).toBeNull();
			await act(async () => {
				for (const listener of listeners)
					listener({
						type: "app-server",
						envelope: {
							jsonrpc: "2.0",
							method: "connection/events",
							params: {
								serverEpoch: ROOT,
								fromCursor: 1,
								toCursor: 1,
								events: [
									{
										type: "agent/updated",
										sessionId: ROOT,
										agent: { ...child, status: "done", currentTask: undefined, retry: undefined },
									},
								],
							},
						},
					});
			});
			expect(mock.transcripts.at(-1)).toMatchObject({ activeTurnId: null, retry: undefined });
		},
	);

	it("does not label a previous task running while the next task has no turn yet", async () => {
		const { api, render } = setup();
		api.listAgents.mockResolvedValue({
			agents: [
				{
					...agent(),
					currentTask: {
						taskId: TASK,
						status: "running",
						taskSummary: "New task",
						createdAt: "2026-10-24T00:00:00.000Z",
						updatedAt: DATE,
					},
				},
			],
			nextAfterAgentId: null,
		});
		api.readAgentItems.mockResolvedValue({
			items: [{ ...item("old", "Old answer"), turnId: "old-turn" }],
			nextBeforeItemId: null,
		});
		await render();
		expect(mock.transcripts.at(-1)?.activeTurnId).toBe(`agent-task:${TASK}`);
	});

	it("reads full history without opening a root runtime or sending a message", async () => {
		const { api, container, render } = setup();
		await render();
		expect(api.readAgentItems).toHaveBeenCalledWith({
			sessionId: ROOT,
			agentId: CHILD,
			beforeItemId: null,
			limit: 200,
		});
		expect(container.textContent).toContain("original assignment");
		expect(api.openSession).not.toHaveBeenCalled();
		expect(api.subscribeSession).not.toHaveBeenCalled();
		expect(api.sendAgentMessage).not.toHaveBeenCalled();
	});
	it("sends attachment input to the root owner and child target with server-selected delivery", async () => {
		const { api, container, render } = setup();
		await render();
		await act(async () => mock.composers.get(`agent-composer-${CHILD}`)!.onSubmit(submission));
		expect(api.sendAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: ROOT, agentId: CHILD, delivery: "queue", input: submission }),
		);
		expect(container.textContent).toContain("Message saved; waiting for delivery");
		expect(container.textContent).not.toContain("Sent to the agent’s model");
	});
	it("lets the user queue a followup and stop the child subtree", async () => {
		const { api, container, render } = setup();
		await render();
		expect(container.querySelector('[aria-label="Message timing"]')).toBeNull();
		await act(async () => mock.composers.get(`agent-composer-${CHILD}`)!.onSubmit(submission));
		expect(api.sendAgentMessage).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: "queue" }));
		await act(async () => mock.composers.get(`agent-composer-${CHILD}`)!.onInterrupt());
		expect(api.controlAgent).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: ROOT, agentId: CHILD, action: "stop", scope: "subtree" }),
		);
	});
	it("keeps technical details out of the composer and opens them on demand", async () => {
		const { container, render } = setup();
		await render();
		expect(container.querySelector(".agent-conversation-capabilities")).toBeNull();
		expect(container.textContent).not.toContain("Filesystem writes denied");
		expect(container.querySelector(".agent-conversation-state")?.textContent).toBe("Running");
		const info = container.querySelector<HTMLButtonElement>('[aria-label="Agent details"]')!;
		info.focus();
		await act(async () => info.click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(dialog.textContent).toContain("Filesystem writes denied");
		expect(dialog.textContent).toContain("Independent context");
		await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(info);
	});
	it("keeps an explicit stop action available while a steering message is drafted", async () => {
		const { api, container, render } = setup();
		await render();
		const props = mock.composers.get(`agent-composer-${CHILD}`)!;
		await act(async () => props.onSubmit({ text: "不用看了", attachments: [] }));
		expect(api.controlAgent).not.toHaveBeenCalled();
		expect(api.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ delivery: "queue" }));
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop agent"]')!.click());
		expect(api.controlAgent).toHaveBeenCalledWith(expect.objectContaining({ action: "stop", scope: "subtree" }));
	});
	it("does not leave a delivered-model receipt in the composer footer", async () => {
		const { api, container, render } = setup();
		api.sendAgentMessage.mockResolvedValueOnce({
			agentId: CHILD,
			taskId: TASK,
			messageId: "message-1",
			requestId: "request-1",
			delivery: "steer",
			state: "delivered",
			instructionRevision: 1,
		});
		await render();
		await act(async () => mock.composers.get(`agent-composer-${CHILD}`)!.onSubmit(submission));
		expect(container.querySelector(".agent-delivery-pending")).toBeNull();
		expect(container.textContent).not.toContain("Sent to the agent’s model");
	});

	it("retries an uncertain send with the same request id", async () => {
		const { api, render } = setup();
		await render();
		api.sendAgentMessage.mockRejectedValueOnce(new Error("Disconnected"));
		await act(async () => {
			await expect(mock.composers.get(`agent-composer-${CHILD}`)!.onSubmit(submission)).rejects.toThrow(
				"Disconnected",
			);
		});
		await act(async () => mock.composers.get(`agent-composer-${CHILD}`)!.onSubmit(submission));
		expect(api.sendAgentMessage.mock.calls[0]![0].requestId).toBe(api.sendAgentMessage.mock.calls[1]![0].requestId);
	});
	it("uses child streaming events and ignores another child's messages", async () => {
		const { listeners, render, container } = setup();
		await render();
		const streaming = { ...item("stream", "hello"), state: "streaming" as const };
		await act(async () => {
			const event: DesktopApiEvent = {
				type: "app-server",
				envelope: {
					jsonrpc: "2.0",
					method: "connection/events",
					params: {
						serverEpoch: ROOT,
						fromCursor: 1,
						toCursor: 3,
						events: [
							{ type: "agent/item/started", sessionId: ROOT, agentId: CHILD, item: streaming },
							{
								type: "agent/item/delta",
								sessionId: ROOT,
								agentId: CHILD,
								itemId: "stream",
								delta: { type: "text", text: " world" },
							},
							{
								type: "agent/item/started",
								sessionId: ROOT,
								agentId: ROOT,
								item: { ...item("foreign", "other child"), sessionId: ROOT },
							},
						],
					},
				},
			};
			for (const listener of listeners) listener(event);
		});
		expect(container.textContent).toContain("hello world");
		expect(container.textContent).not.toContain("other child");
	});
	it("keeps supplied journal order for equal timestamps", () => {
		expect(
			mergeAgentItems([], [item("z-user", "task"), item("a-assistant", "answer")]).map((entry) => entry.itemId),
		).toEqual(["z-user", "a-assistant"]);
	});
});

it("reloads the durable tail when a cold catalog reaches done after the history read", async () => {
	const { api, container, render } = setup();
	let finishCatalog!: (value: Awaited<ReturnType<MetisDesktopApi["listAgents"]>>) => void;
	api.listAgents.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishCatalog = resolve;
			}),
	);
	const user = { ...item("user", "still there"), role: "user" as const, turnId: "turn" };
	api.readAgentItems.mockResolvedValue({ items: [user], nextBeforeItemId: null });
	await render();
	expect(container.textContent).not.toContain("durable final reply");
	api.readAgentItems.mockResolvedValue({
		items: [user, item("reply", "durable final reply")],
		nextBeforeItemId: null,
	});
	api.listAgents.mockResolvedValue({
		agents: [{ ...agent(), status: "done", updatedAt: "2026-10-23T00:00:09Z" }],
		nextAfterAgentId: null,
	});
	await act(async () =>
		finishCatalog({
			agents: [{ ...agent(), status: "done", updatedAt: "2026-10-23T00:00:09Z" }],
			nextAfterAgentId: null,
		}),
	);
	expect(container.textContent).toContain("durable final reply");
	expect(container.querySelector(".agent-conversation-state")?.textContent).toBe("Completed");
	expect(mock.transcripts.at(-1)?.activeTurnId).toBeNull();
});
