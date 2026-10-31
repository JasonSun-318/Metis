// @vitest-environment jsdom
import type { ItemView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineInteraction } from "../src/renderer/components/ConversationInteractionCards.tsx";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { COMPOSER_SESSION_ID, composerInteraction } from "./fixtures/composer-session.ts";

vi.mock("@pierre/diffs/react", () => ({
	FileDiff: () => null,
	WorkerPoolContextProvider: ({ children }: { children: unknown }) => children,
}));
let root: Root;
let container: HTMLDivElement;
const onRespond = vi.fn<() => Promise<void>>();
function item(id: string, content: ItemView["content"], turnId = "turn-1"): ItemView {
	return {
		itemId: id,
		sessionId: COMPOSER_SESSION_ID,
		turnId,
		role: "assistant",
		state: "completed",
		content,
		createdAt: "2026-10-29T00:00:00.000Z",
	};
}
const call = (id: string, name: string, extra = {}) => ({
	type: "tool_call" as const,
	toolCallId: id,
	name,
	state: "completed" as const,
	...extra,
});
const result = (id: string, name: string, output: string, isError = false) => ({
	type: "tool_result" as const,
	toolCallId: id,
	name,
	output,
	isError,
});
async function render(items: ItemView[], requests: InlineInteraction[] = [], appearance: "chat" | "code" = "chat") {
	await act(async () =>
		root.render(
			<Transcript
				appearance={appearance}
				hasOlder={false}
				loadingOlder={false}
				onLoadOlder={async () => {}}
				itemIds={items.map((item) => item.itemId)}
				itemsById={new Map(items.map((item) => [item.itemId, item]))}
				interactions={{ requests, onRespond }}
			/>,
		),
	);
}
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	onRespond.mockReset().mockResolvedValue(undefined);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});
describe("conversation interaction cards", () => {
	it.each(["chat", "code"] as const)("keeps settled approvals inside one %s execution group", async (mode) => {
		const entries = [
			item("read", [call("read", "bash"), result("read", "bash", "read output")]),
			...(["allow", "unavailable", "deny"] as const).map((outcome) =>
				item(outcome, [
					call(outcome, "bash", {
						inputPreview: JSON.stringify({ command: `echo ${outcome}` }),
						permissionDecision: { source: "user", outcome },
					}),
					result(outcome, "bash", `${outcome} output`, outcome !== "allow"),
				]),
			),
			item("last", [call("last", "read"), result("last", "read", "last output")]),
		];
		await render(entries, [], mode);
		const groups = container.querySelectorAll<HTMLDetailsElement>(".code-execution, .execution-chain");
		expect(groups).toHaveLength(1);
		const execution = groups[0]!;
		expect(execution.querySelectorAll(".conversation-permission-receipt")).toHaveLength(3);
		expect(container.querySelectorAll(".transcript-tool-group > .conversation-permission-receipt")).toHaveLength(0);
		await act(async () => execution.querySelector<HTMLElement>(":scope > summary")!.click());
		expect(execution.textContent).toContain("read output");
		expect(execution.textContent).toContain("unavailable output");
		expect(execution.textContent).toContain("Rejected");
		expect(execution.querySelectorAll(".code-command, .tool-step")).toHaveLength(5);
	});
	it.each(["chat", "code"] as const)(
		"keeps %s approval actionable then rejoins the existing execution group",
		async (mode) => {
			const request = {
				...composerInteraction("session_permission_approval"),
				toolCallId: "approval",
			} as InlineInteraction;
			const before = item("before", [call("before", "bash"), result("before", "bash", "before output")]);
			await render([before, item("approval", [call("approval", "bash", { state: "running" })])], [request], mode);
			const execution = container.querySelector<HTMLDetailsElement>(".code-execution, .execution-chain")!;
			await act(async () => execution.querySelector<HTMLElement>(":scope > summary")!.click());
			expect(container.querySelector(".permission-approval-panel")?.closest("details")).toBeNull();
			await act(async () => container.querySelector<HTMLButtonElement>(".permission-approval-allow")!.click());
			await render(
				[
					before,
					item("approval", [call("approval", "bash"), result("approval", "bash", "approved output")]),
					item("after", [call("after", "bash"), result("after", "bash", "after output")]),
				],
				[],
				mode,
			);
			expect(container.querySelectorAll(".code-execution, .execution-chain")).toHaveLength(1);
			expect(container.querySelector(".code-execution, .execution-chain")).toBe(execution);
			expect(execution.open).toBe(true);
			expect(execution.querySelector(".conversation-permission-receipt")?.textContent).toContain("Allowed once");
			expect(execution.textContent).toContain("after output");
			expect(container.querySelector(".permission-approval-panel")).toBeNull();
		},
	);
	it.each(["chat", "code"] as const)("keeps task updates inside one nonempty %s execution group", async (mode) => {
		const items = [
			item("tasks-first", [
				call("t1", "set_tasks"),
				{ ...result("t1", "set_tasks", ""), tasks: [{ task: "Verify file", completed: false }] },
			]),
			item("create", [
				call("c1", "bash", { inputPreview: '{"command":"touch report.txt"}' }),
				{
					...result("c1", "bash", "created"),
					codeChanges: {
						version: 1 as const,
						sequence: 1,
						partial: false,
						turn: { additions: 2, deletions: 0, partial: false },
						files: [],
					},
				},
			]),
			item("tasks-update", [call("t2", "set_tasks"), result("t2", "set_tasks", "")]),
			item("read", [
				call("c2", "bash", { inputPreview: '{"command":"cat report.txt"}' }),
				result("c2", "bash", "file content"),
			]),
			item("tasks-last", [
				call("t3", "set_tasks"),
				{ ...result("t3", "set_tasks", ""), tasks: [{ task: "Verify file", completed: true }] },
			]),
		];
		await render(items, [], mode);
		expect(container.querySelectorAll(".conversation-tasks")).toHaveLength(1);
		expect(container.querySelectorAll(".code-execution, .execution-chain")).toHaveLength(1);
		const execution = container.querySelector<HTMLDetailsElement>(".code-execution, .execution-chain")!;
		await act(async () => execution.querySelector<HTMLElement>("summary")!.click());
		expect(execution.textContent).toContain("created");
		expect(execution.textContent).toContain("file content");
		if (mode === "code") expect(execution.querySelector(".code-change-additions")?.textContent).toBe("+2");
	});
	it.each(["chat", "code"] as const)("keeps file-delivery approval actionable in %s", async (mode) => {
		const request = {
			...composerInteraction("session_permission_approval"),
			toolCallId: "file-1",
			toolLabel: "deliver_file",
			command: undefined,
		} as InlineInteraction;
		await render(
			[
				item("delivery", [
					call("file-1", "deliver_file", { state: "running", inputPreview: '{"path":"/external/report.txt"}' }),
				]),
			],
			[request],
			mode,
		);
		const panel = container.querySelector(".permission-approval-panel");
		expect(panel).not.toBeNull();
		expect(panel?.closest("details")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".permission-approval-allow")!.click());
		expect(onRespond).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "session_permission_approval", choice: "allow-once" }),
		);
	});
	it.each(["chat", "code"] as const)(
		"places %s questions outside tool disclosures and preserves selected answers on failed submit",
		async (mode) => {
			const request = { ...composerInteraction("ask_user"), toolCallId: "question-tool" } as InlineInteraction;
			const items = [item("calls", [call("question-tool", "ask_user", { state: "running" })])];
			onRespond.mockRejectedValueOnce(new Error("Retry this response"));
			await render(items, [request], mode);
			const panel = container.querySelector(".ask-user-panel")!;
			expect(panel.closest(".transcript-turn, .code-transcript-turn")).not.toBeNull();
			expect(panel.closest("details")).toBeNull();
			await act(async () => container.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
			await act(async () => container.querySelector<HTMLButtonElement>(".ask-user-step")!.click());
			expect(container.textContent).toContain("Retry this response");
			expect(container.querySelector('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
			await act(async () => container.querySelector<HTMLButtonElement>(".ask-user-step")!.click());
			expect(onRespond).toHaveBeenCalledTimes(2);
			await render(
				[
					...items,
					item("answer", [
						result("question-tool", "ask_user", 'User answers:\n[{"question":"Which?","selected":["Local"]}]'),
					]),
				],
				[],
				mode,
			);
			expect(container.querySelector(".ask-user-panel")).toBeNull();
			expect(container.querySelector(".ask-user-answer-summary")?.textContent).toContain("Local");
			expect(container.querySelector(".ask-user-answer-summary button")).toBeNull();
		},
	);
	it.each(["chat", "code"] as const)(
		"keeps one task card per %s turn and does not overwrite old turns",
		async (mode) => {
			const entries = [
				item("tasks", [
					call("tasks-1", "set_tasks"),
					result("tasks-1", "set_tasks", "- [ ] First task"),
					call("tasks-2", "set_tasks"),
					result("tasks-2", "set_tasks", "- [x] First task"),
				]),
				item(
					"later",
					[call("tasks-3", "set_tasks"), result("tasks-3", "set_tasks", "- [ ] Different task")],
					"turn-2",
				),
			];
			await render(entries, [], mode);
			const cards = container.querySelectorAll(".conversation-tasks");
			expect(cards).toHaveLength(2);
			expect(cards[0]?.textContent).toContain("Completed1/1");
			expect(cards[0]?.textContent).not.toContain("Different task");
			expect(cards[0]?.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
			expect(cards[1]?.textContent).toContain("Different task");
		},
	);
	it("displays manual approval separately from a failed command and restores its exact scope", async () => {
		await render(
			[
				item("permission", [
					call("bash-1", "bash", {
						inputPreview: '{"command":"false"}',
						permissionDecision: { source: "user", outcome: "allow", remember: "session" },
					}),
					result("bash-1", "bash", "Command failed", true),
				]),
			],
			[],
			"code",
		);
		expect(container.querySelector(".conversation-permission-receipt")?.textContent).toContain(
			"Allowed for this session",
		);
		expect(container.querySelector(".permission-approval-allow")).toBeNull();
	});
	it("never offers an action on an expired request", async () => {
		const request = {
			...composerInteraction("session_permission_approval"),
			toolCallId: "bash-1",
			expiresAt: "2020-01-01T00:00:00.000Z",
		} as InlineInteraction;
		await render([item("approval", [call("bash-1", "bash")])], [request]);
		expect(container.textContent).toContain("This request has expired");
		expect(container.querySelector(".permission-approval-allow")).toBeNull();
		expect(onRespond).not.toHaveBeenCalled();
	});
	it("uses structured task and answer history when output previews are truncated", async () => {
		await render([
			item("history", [
				call("tasks", "set_tasks"),
				{
					...result("tasks", "set_tasks", "truncated…"),
					tasks: [{ task: "Preserved final task", completed: false }],
				},
				call("ask", "ask_user"),
				{
					...result("ask", "ask_user", "User answers:\n[truncated…"),
					userAnswers: [{ question: "Saved question", selected: [], customAnswer: "Complete answer" }],
				},
			]),
		]);
		expect(container.querySelector(".conversation-tasks")?.textContent).toContain("Preserved final task");
		expect(container.querySelector(".ask-user-answer-summary")?.textContent).toContain("Complete answer");
	});
});
