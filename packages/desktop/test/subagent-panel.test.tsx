// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionSnapshot } from "@arcmind/app-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcMindDesktopApi } from "../src/shared/desktop-api.ts";
import { SubagentPanel } from "../src/renderer/components/SubagentPanel.tsx";

afterEach(() => document.body.replaceChildren());

describe("SubagentPanel", () => {
	it("shows immutable configuration and pages a read-only tool transcript", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 340, bottom: 640, width: 340, height: 640, toJSON: () => ({}) });
		const readSubagentItems = vi
			.fn()
			.mockResolvedValueOnce({
				items: [{ itemId: "new", sessionId: "child-session-123456", role: "assistant", state: "completed", content: [{ type: "text", text: "handoff" }], createdAt: "2026-07-18T00:00:01.000Z" }],
				nextBeforeItemId: "new",
			})
			.mockResolvedValueOnce({
				items: [{ itemId: "old", sessionId: "child-session-123456", role: "tool", state: "completed", content: [{ type: "tool_result", name: "read", output: "older output", isError: false }], createdAt: "2026-07-18T00:00:00.000Z" }],
				nextBeforeItemId: null,
			});
		const api = { readSubagentItems } as unknown as ArcMindDesktopApi;
		const subagents: SessionSnapshot["subagents"] = [{
			agentId: "child-session-123456",
			name: "researcher",
			status: "done",
			taskSummary: "Inspect the runtime",
			configuration: { mode: "chat", tools: ["read"], permissionMode: "ask", model: { provider: "openai", modelId: "gpt-test" }, thinkingLevel: "high", cwd: "/tmp/project", forkTurns: 0, timeoutSeconds: 60 },
			usage: { model: { provider: "openai", modelId: "gpt-test" }, input: 3, output: 5, cacheRead: 1, cacheWrite: 0, elapsedMs: 1250 },
			createdAt: "2026-07-18T00:00:00.000Z",
			updatedAt: "2026-07-18T00:00:01.000Z",
		}];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<SubagentPanel api={api} sessionId="parent-1" subagents={subagents} />));
		expect(container.textContent).toContain("chat · ask · openai/gpt-test");
		expect(container.textContent).toContain("9 tokens · 1.3s");
		await act(async () => container.querySelector<HTMLButtonElement>(".subagent-card")!.click());
		expect(readSubagentItems).toHaveBeenCalledWith({ sessionId: "parent-1", agentId: "child-session-123456", limit: 100 });
		expect(container.textContent).toContain("handoff");
		const older = [...container.querySelectorAll("button")].find((button) => button.textContent === "Load older activity")!;
		await act(async () => older.click());
		expect(readSubagentItems).toHaveBeenLastCalledWith({ sessionId: "parent-1", agentId: "child-session-123456", beforeItemId: "new", limit: 100 });
		expect(container.textContent).toContain("older output");
		await act(async () => root.unmount());
	});
});
