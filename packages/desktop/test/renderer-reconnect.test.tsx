// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectionEventsParams, ItemView, SessionSnapshot } from "@metis/app-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionHost } from "../src/renderer/components/InteractionHost.tsx";
import { RecoveryBanner } from "../src/renderer/components/RecoveryBanner.tsx";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { shouldResnapshotAfterReady } from "../src/renderer/session-workspace-workflow.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

function item(itemId: string, text: string): ItemView {
	return {
		itemId,
		sessionId: "session-1",
		role: "assistant",
		state: "streaming",
		content: [{ type: "text", text }],
		createdAt: "2026-07-16T00:00:00.000Z",
	};
}

function snapshot(serverEpoch: string, cursor: number, text: string): SessionSnapshot {
	return {
		session: {
			sessionId: "session-1",
			mode: "code",
			cwdOrigin: "user-selected",
			cwd: "/tmp/project",
			createdAt: "2026-07-16T00:00:00.000Z",
			updatedAt: "2026-07-16T00:00:00.000Z",
			state: "running",
			archived: false,
		},
		collaborationMode: "default",
		permissionMode: "ask",
		turns: [],
		recentItems: [item("item-1", text)],
		nextBeforeItemId: null,
		activeTurnId: null,
		pendingInteractions: [],
		queuedTurns: [],
		tasks: [],
		deliveredFiles: [],
		goal: null,
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		agents: [],
		serverEpoch,
		cursor,
	};
}

function delta(serverEpoch: string, cursor: number, text: string): ConnectionEventsParams {
	return {
		serverEpoch,
		fromCursor: cursor,
		toCursor: cursor,
		events: [
			{
				type: "item/delta",
				sessionId: "session-1",
				itemId: "item-1",
				delta: { type: "text", text },
			},
		],
	};
}

function projectedText(store: AppStore): string {
	const block = store.getSnapshot().itemsById.get("item-1")?.content[0];
	return block?.type === "text" ? block.text : "";
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("renderer reconnect behavior", () => {
	it("resnapshots when the same app-server epoch reconnects after overload", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0, "before"));
		store.setSupervisor({ state: "ready", serverEpoch: EPOCH_A, restartAttempt: 0, failure: null });
		store.setSupervisor({ state: "restarting", serverEpoch: null, restartAttempt: 0, failure: "overloaded" });

		expect(
			shouldResnapshotAfterReady(store.getSnapshot(), {
				state: "ready",
				serverEpoch: EPOCH_A,
				restartAttempt: 0,
				failure: null,
			}),
		).toBe(true);
	});

	it("converges to the same model after restart and snapshot replacement", () => {
		const uninterrupted = new AppStore();
		uninterrupted.applySnapshot(snapshot(EPOCH_A, 0, "A"));
		uninterrupted.applyBatch(delta(EPOCH_A, 1, "B"));

		const recovered = new AppStore();
		recovered.applySnapshot(snapshot(EPOCH_A, 0, "A"));
		recovered.markResubscribing();
		expect(recovered.applyBatch(delta(EPOCH_A, 1, "lost"))).toBe("resnapshot_required");
		recovered.applySnapshot(snapshot(EPOCH_B, 1, "AB"));

		expect(projectedText(recovered)).toBe(projectedText(uninterrupted));
		expect(recovered.getSnapshot().cursor).toBe(uninterrupted.getSnapshot().cursor);
	});

	it("makes an interrupted recovered turn visible", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(
				<RecoveryBanner
					session={{
						sessionId: "session-1",
						mode: "code",
						cwdOrigin: "user-selected",
						cwd: "/tmp/project",
						createdAt: "2026-07-16T00:00:00.000Z",
						updatedAt: "2026-07-16T00:00:01.000Z",
						state: "interrupted",
						archived: false,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("interrupted");
		await act(async () => root.unmount());
	});

	it("focuses a project-trust choice and restores focus after responding", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const previous = document.createElement("button");
		const container = document.createElement("div");
		document.body.append(previous, container);
		previous.focus();
		const root = createRoot(container);
		const onRespond = vi.fn().mockResolvedValue(undefined);

		await act(async () => {
			root.render(
				<InteractionHost
					interaction={{
						interactionId: "00000000-0000-4000-8000-000000000201",
						sessionId: "session-1",
						title: "Trust this project?",
						message: "Project resources can execute code.",
						createdAt: "2026-07-16T00:00:00.000Z",
						kind: "project_trust",
						projectPath: "/tmp/project",
						choices: [{ id: "trust-once", label: "Trust once" }],
					}}
					onRespond={onRespond}
				/>,
			);
		});

		const choice = container.querySelector("button")!;
		expect(document.activeElement).toBe(choice);
		await act(async () => choice.click());
		expect(onRespond).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000201",
			kind: "project_trust",
			choiceId: "trust-once",
		});
		await act(async () => root.unmount());
		expect(document.activeElement).toBe(previous);
	});

	it("renders permission approval inline and denies it with Escape", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onRespond = vi.fn().mockResolvedValue(undefined);

		await act(async () => {
			root.render(
				<InteractionHost
					interaction={{
						interactionId: "00000000-0000-4000-8000-000000000203",
						sessionId: "session-1",
						title: "Approve bash?",
						message: "Delete the generated cache file.\nRisk: destructive\nCommand: rm cache.tmp",
						createdAt: "2026-07-16T00:00:00.000Z",
						kind: "select",
						presentation: "permission_approval",
						operation: {
							toolName: "bash",
							rows: [
								{ label: "Command", value: "rm cache.tmp" },
								{ label: "Working directory", value: "/tmp/work" },
							],
							omittedRows: 0,
							scopeComplete: true,
							irreversible: true,
							executionTarget: "sandbox",
							rememberProjectEligible: true,
						},
						choices: [
							{ id: "permission:allow-once", label: "Allow once" },
							{ id: "permission:always-project", label: "Always allow for this project" },
							{ id: "permission:deny", label: "Reject" },
						],
					}}
					onRespond={onRespond}
				/>,
			);
		});

		const panel = container.querySelector<HTMLElement>(".permission-approval-panel")!;
		expect(panel).not.toBeNull();
		expect(container.querySelector(".modal-backdrop")).toBeNull();
		expect(panel.textContent).toContain("Metis wants to use bash");
		expect(panel.textContent).toContain("Command");
		expect(panel.textContent).toContain("rm cache.tmp");
		expect(panel.textContent).toContain("Working directory");
		expect(panel.textContent).toContain("/tmp/work");
		expect(panel.textContent).toContain("This operation may not be reversible.");
		expect(panel.textContent).not.toContain("Arguments:");
		expect(panel.textContent).not.toContain('"command"');
		expect(document.activeElement?.textContent).toContain("Reject");
		await act(async () => panel.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
		expect(onRespond).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000203",
			kind: "select",
			choiceId: "permission:deny",
		});
		await act(async () => root.unmount());
	});

	it("allows complete approvals with omitted summary rows but blocks genuinely incomplete approvals", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		for (const [operation, blocked] of [
			[{
				toolName: "read",
				rows: [{ label: "Path", value: "/tmp/target-0" }],
				omittedRows: 2,
				scopeComplete: true,
				irreversible: false,
				executionTarget: "sandbox" as const,
				rememberProjectEligible: false,
			}, false],
			[{
				toolName: "mcp__service__publish",
				rows: [{ label: "Details", value: "No target details were provided" }],
				omittedRows: 0,
				scopeComplete: false,
				irreversible: true,
				executionTarget: "host" as const,
				rememberProjectEligible: false,
			}, true],
		] as const) {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			await act(async () => root.render(
				<InteractionHost
					interaction={{
						interactionId: "00000000-0000-4000-8000-000000000209",
						sessionId: "session-1",
						title: "Approve operation?",
						message: "Review the requested operation.",
						createdAt: "2026-07-16T00:00:00.000Z",
						kind: "select",
						presentation: "permission_approval",
						operation,
						choices: [
							{ id: "permission:allow-once", label: "Allow once" },
							{ id: "permission:deny", label: "Reject" },
						],
					}}
					onRespond={vi.fn().mockResolvedValue(undefined)}
				/>,
			));

			expect([...container.querySelectorAll<HTMLButtonElement>("button")]
				.find((button) => button.textContent?.includes("Allow once"))?.disabled).toBe(blocked);
			expect(container.querySelector('[role="alert"]')).not.toBeNull();
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("shows complete custom-tool arguments and permits the decision", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(
			<InteractionHost
				interaction={{
					interactionId: "00000000-0000-4000-8000-000000000210",
					sessionId: "session-1",
					title: "Approve publish?",
					message: 'Risk: custom, external-side-effect\nArguments:\n{\n  "content": "private payload"\n}',
					createdAt: "2026-07-16T00:00:00.000Z",
					kind: "select",
					presentation: "permission_approval",
					operation: {
						toolName: "mcp__service__publish",
						rows: [{ label: "Details", value: "Publish content" }],
						omittedRows: 0,
						scopeComplete: true,
						irreversible: true,
						executionTarget: "host",
						rememberProjectEligible: false,
					},
					choices: [
						{ id: "permission:allow-once", label: "Allow once" },
						{ id: "permission:deny", label: "Reject" },
					],
				}}
				onRespond={vi.fn().mockResolvedValue(undefined)}
			/>,
		));

		expect(container.querySelector(".permission-approval-complete-details")?.textContent).toContain("private payload");
		expect([...container.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent?.includes("Allow once"))?.disabled).toBe(false);
		await act(async () => root.unmount());
		container.remove();
	});

	it("submits an extension input through the typed interaction response", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onRespond = vi.fn().mockResolvedValue(undefined);

		await act(async () => {
			root.render(
				<InteractionHost
					interaction={{
						interactionId: "00000000-0000-4000-8000-000000000202",
						sessionId: "session-1",
						title: "Extension input",
						message: "Enter a value.",
						createdAt: "2026-07-16T00:00:00.000Z",
						kind: "input",
						secret: true,
					}}
					onRespond={onRespond}
				/>,
			);
		});

		const input = container.querySelector("input")!;
		expect(input.type).toBe("password");
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "typed value");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			container.querySelector("form")!.requestSubmit();
		});
		expect(onRespond).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000202",
			kind: "input",
			value: "typed value",
		});
		await act(async () => root.unmount());
	});

	it("keeps a 10,000-item transcript DOM bounded", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			bottom: 640,
			height: 640,
			left: 0,
			right: 800,
			top: 0,
			width: 800,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
		const itemsById = new Map<string, ItemView>();
		const itemIds = Array.from({ length: 10_000 }, (_, index) => {
			const itemId = `item-${index}`;
			itemsById.set(itemId, item(itemId, `Message ${index}`));
			return itemId;
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(
				<Transcript
					appearance="code"
					hasOlder={false}
					itemIds={itemIds}
					itemsById={itemsById}
					loadingOlder={false}
					onLoadOlder={async () => undefined}
				/>,
			);
		});
		const renderedItems = container.querySelectorAll("[data-transcript-item]").length;
		expect(renderedItems).toBeGreaterThan(0);
		expect(renderedItems).toBeLessThan(100);

		await act(async () => root.unmount());
	});
});
