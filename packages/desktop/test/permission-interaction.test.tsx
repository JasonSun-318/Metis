// @vitest-environment jsdom

import type { InteractionView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionHost } from "../src/renderer/components/InteractionHost.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

type Approval = Extract<InteractionView, { kind: "session_permission_approval" }>;

const SECRET = "sk-live-secret-value";
const REDACTED = `[REDACTED] ${"x".repeat(240)}`;

function approval(overrides: Partial<Approval> = {}): Approval {
	return {
		interactionId: "00000000-0000-4000-8000-000000000301",
		sessionId: "session-1",
		title: "Approve bash?",
		message: "Review this action.",
		createdAt: "2026-08-11T00:00:00.000Z",
		kind: "session_permission_approval",
		requestId: "00000000-0000-4000-8000-000000000301",
		actionId: "action-bash-1",
		toolLabel: "bash",
		command: "curl https://example.test",
		rememberSessionEligible: false,
		riskLevel: "high",
		executionTarget: "sandbox",
		reason: "Network destination needs approval",
		scopeComplete: true,
		details: [
			{ label: "Command", value: "curl https://example.test" },
			{ label: "Path", value: "/tmp/work/out.txt" },
			{ label: "Network", value: "example.test" },
			{ label: "Details", value: REDACTED },
		],
		choices: ["allow-once", "deny-once", "always-allow-exact", "always-deny-exact"],
		...overrides,
	};
}

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
});

function mount(
	interaction: Approval | undefined,
	onRespond = vi.fn().mockResolvedValue(undefined),
	sandboxHealth: "healthy" | "unavailable" | "misconfigured" = "healthy",
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	act(() =>
		root.render(<InteractionHost interaction={interaction} onRespond={onRespond} sandboxHealth={sandboxHealth} />),
	);
	return { container, onRespond, root };
}

function choice(container: HTMLElement, label: string) {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes(label),
	);
	if (!match) throw new Error(`Missing choice: ${label}`);
	return match;
}

describe("permission approval interaction", () => {
	it("shows the complete command without technical approval or hidden reasoning blocks", () => {
		const { container } = mount(
			approval({
				priorReviewer: "model",
				priorReviewerOutcome: "unavailable",
				riskLevel: "critical",
				executionTarget: "external",
			}),
		);
		const panel = container.querySelector(".permission-approval-panel")!;
		expect(container.querySelector(".modal-backdrop, [aria-modal='true']")).toBeNull();
		expect(panel.querySelector("h2")?.textContent).toBe("Allow Metis to execute the following command?");
		expect(panel.querySelector("pre")?.textContent).toBe("curl https://example.test");
		for (const hidden of [
			"Automatic security review",
			"This operation may not be reversible",
			"Network destination needs approval",
			REDACTED,
			SECRET,
			"base64",
		])
			expect(panel.textContent).not.toContain(hidden);
		expect(panel.textContent).not.toMatch(/hidden reasoning|system prompt/i);
		expect(choice(container, "Allow once")).toBeTruthy();
		expect(choice(container, "Reject")).toBeTruthy();
		expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
	});

	it("focuses the dialog for reading, submits once, and restores focus after close", async () => {
		const previous = document.createElement("button");
		previous.textContent = "composer";
		document.body.append(previous);
		previous.focus();
		const onRespond = vi.fn().mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const { container, root } = mount(approval(), onRespond);
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.activeElement).toBe(container.querySelector(".permission-approval-panel"));
		await act(async () => choice(container, "Allow once").click());
		expect(choice(container, "Allow once").disabled).toBe(true);
		expect(container.querySelector("[aria-live='polite']")?.textContent).toContain("Sending your decision…");
		await act(async () => choice(container, "Allow once").click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000301",
			kind: "session_permission_approval",
			choice: "allow-once",
		});
		await act(async () => root.render(<InteractionHost interaction={undefined} onRespond={onRespond} />));
		expect(document.activeElement).toBe(previous);
	});

	it("denies with Escape and closes a stale response without authorizing", async () => {
		const onRespond = vi
			.fn()
			.mockRejectedValueOnce(new Error("Approval was unavailable or cancelled"))
			.mockResolvedValue(undefined);
		const { container } = mount(approval(), onRespond);
		await act(async () =>
			container
				.querySelector(".permission-approval-panel")!
				.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
		);
		expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ choice: "deny-once" }));
		expect(container.textContent).toContain("This approval is no longer available.");
		expect(container.querySelector(".permission-approval-panel")).toBeNull();
		expect(onRespond).toHaveBeenCalledTimes(1);
	});

	it("blocks sandbox actions when sandbox health is unhealthy instead of offering a host fallback", async () => {
		const { container, onRespond } = mount(approval(), vi.fn().mockResolvedValue(undefined), "misconfigured");
		expect(container.textContent).toContain("Workspace sandbox is unavailable");
		expect(choice(container, "Allow once").disabled).toBe(true);
		expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
		expect(choice(container, "Reject").disabled).toBe(false);
		await act(async () => choice(container, "Reject").click());
		expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ choice: "deny-once" }));
	});

	it("keeps Allow once enabled when the action scope is incomplete", () => {
		const { container } = mount(approval({ scopeComplete: false }));
		expect(choice(container, "Allow once").disabled).toBe(false);
		expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
		expect(choice(container, "Reject").disabled).toBe(false);
	});

	it("does not submit a disabled interaction during reconnect", async () => {
		const onRespond = vi.fn().mockResolvedValue(undefined);
		const { container, root } = mount(approval(), onRespond);
		await act(async () => root.render(<InteractionHost interaction={approval()} onRespond={onRespond} disabled />));
		expect(choice(container, "Allow once").disabled).toBe(true);
		await act(async () => choice(container, "Allow once").click());
		expect(onRespond).not.toHaveBeenCalled();
	});
});
