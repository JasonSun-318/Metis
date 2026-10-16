// @vitest-environment jsdom
import type { SessionSummary } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemorySessionSettings } from "../src/renderer/components/MemorySessionSettings.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const session = (id: string, cwd: string): SessionSummary => ({
	sessionId: id,
	name: "Same title",
	mode: "code",
	cwd,
	cwdOrigin: "user-selected",
	createdAt: "2026-09-18T00:00:00Z",
	updatedAt: "2026-09-18T00:00:00Z",
	archived: false,
	unread: false,
	state: "idle",
	useMemory: true,
	contributeMemory: true,
});
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});
afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

it("loads every page and changes the selected conversation without changing another conversation", async () => {
	const api = {
		listSessions: vi
			.fn()
			.mockResolvedValueOnce({ sessions: [session("one", "/work/alpha")], nextAfterSessionId: "one" })
			.mockResolvedValueOnce({
				sessions: [{ ...session("two", "/work/beta"), archived: true }],
				nextAfterSessionId: null,
			}),
		setSessionMemoryFlags: vi.fn().mockResolvedValue({ useMemory: true, contributeMemory: false }),
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(<MemorySessionSettings api={api} serverReady currentSessionId="one" />));
		expect(container.querySelector("dialog")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".memory-manage-row")!.click());
		expect(container.querySelector("dialog[open]")).not.toBeNull();
		expect(api.listSessions).toHaveBeenLastCalledWith({ includeArchived: true, limit: 200, afterSessionId: "one" });
		const rows = container.querySelectorAll(".memory-session-row");
		expect(rows).toHaveLength(2);
		expect(rows[0]!.textContent).toContain("Current conversation");
		expect(rows[1]!.textContent).toContain("/work/beta");
		expect(rows[1]!.textContent).toContain("Archived");
		await act(async () => rows[1]!.querySelectorAll<HTMLInputElement>("input")[1]!.click());
		expect(api.setSessionMemoryFlags).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "two", contributeMemory: false }),
		);
		expect(rows[0]!.querySelectorAll<HTMLInputElement>("input")[1]!.checked).toBe(true);
		expect(rows[1]!.querySelectorAll<HTMLInputElement>("input")[1]!.checked).toBe(false);
		expect(container.textContent).toContain("1 with exceptions");
		const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "beta");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(container.querySelectorAll(".memory-session-row")).toHaveLength(1);
		expect(container.querySelector(".memory-session-row")?.textContent).toContain("/work/beta");
		api.setSessionMemoryFlags.mockResolvedValue({ useMemory: true, contributeMemory: true });
		await act(async () => container.querySelectorAll<HTMLInputElement>(".memory-session-row input")[1]!.click());
		expect(api.setSessionMemoryFlags).toHaveBeenLastCalledWith(
			expect.objectContaining({ sessionId: "two", contributeMemory: true }),
		);
	} finally {
		await act(async () => root.unmount());
	}
});

it("keeps saved flags on failure, allows retry, and sends the use-memory exclusion independently", async () => {
	const api = {
		listSessions: vi.fn().mockResolvedValue({ sessions: [session("one", "/work/alpha")], nextAfterSessionId: null }),
		setSessionMemoryFlags: vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue({ useMemory: false, contributeMemory: true }),
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(<MemorySessionSettings api={api} serverReady />));
		await act(async () => container.querySelector<HTMLButtonElement>(".memory-manage-row")!.click());
		const checkbox = container.querySelector<HTMLInputElement>(".memory-session-row input")!;
		await act(async () => checkbox.click());
		expect(checkbox.checked).toBe(true);
		expect(checkbox.getAttribute("aria-checked")).toBe("true");
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		await act(async () => checkbox.click());
		expect(api.setSessionMemoryFlags).toHaveBeenLastCalledWith(
			expect.objectContaining({ sessionId: "one", useMemory: false }),
		);
		expect(api.setSessionMemoryFlags.mock.calls.at(-1)![0]).not.toHaveProperty("contributeMemory");
		expect(checkbox.checked).toBe(false);
		expect(checkbox.getAttribute("aria-checked")).toBe("false");
		await act(async () => root.render(<MemorySessionSettings api={api} serverReady={false} />));
		expect(container.querySelector(".memory-session-row")).toBeNull();
	} finally {
		await act(async () => root.unmount());
	}
});

it("retries loading and excludes read-only scheduled runs", async () => {
	const api = {
		listSessions: vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue({
				sessions: [
					{ ...session("scheduled", "/work/alpha"), scheduled: { taskId: "task", runId: "run" } },
					session("one", "/work/alpha"),
				],
				nextAfterSessionId: null,
			}),
		setSessionMemoryFlags: vi.fn(),
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(<MemorySessionSettings api={api} serverReady />));
		await act(async () => container.querySelector<HTMLButtonElement>(".memory-manage-row")!.click());
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Retry")!.click(),
		);
		expect(container.querySelectorAll(".memory-session-row")).toHaveLength(1);
	} finally {
		await act(async () => root.unmount());
	}
});
