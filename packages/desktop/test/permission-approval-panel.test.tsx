// @vitest-environment jsdom

import type { InteractionResponseInput, InteractionView, SessionSnapshot } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionApprovalPanel } from "../src/renderer/components/PermissionApprovalPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

type Approval = Extract<InteractionView, { kind: "session_permission_approval" }>;

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
	interaction: Approval = approval(),
	onRespond: (response: InteractionResponseInput) => Promise<void> = vi.fn().mockResolvedValue(undefined),
	sandboxHealth: SessionSnapshot["sandboxHealth"] = "healthy",
	parent: HTMLElement = document.body,
) {
	const container = document.createElement("div");
	parent.append(container);
	const root = createRoot(container);
	roots.push(root);
	act(() =>
		root.render(
			<PermissionApprovalPanel interaction={interaction} onRespond={onRespond} sandboxHealth={sandboxHealth} />,
		),
	);
	return { container, onRespond, root };
}

function rerender(root: Root, interaction: Approval, onRespond: (response: InteractionResponseInput) => Promise<void>) {
	act(() => root.render(<PermissionApprovalPanel interaction={interaction} onRespond={onRespond} />));
}

function button(container: HTMLElement, label: string) {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function panel(container: HTMLElement) {
	const element = container.querySelector<HTMLElement>(".permission-approval-panel");
	if (!element) throw new Error("Missing approval panel");
	return element;
}

function visibleText(container: HTMLElement) {
	const clone = container.cloneNode(true) as HTMLElement;
	for (const hidden of clone.querySelectorAll("[hidden], .sr-only")) hidden.remove();
	return clone.textContent ?? "";
}

function press(element: HTMLElement, key: string) {
	element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
}

describe("permission approval panel", () => {
	it("leads with the command and target while keeping routine detail collapsed", () => {
		const { container } = mount();
		const text = visibleText(container);

		expect(container.querySelector(".permission-approval-slot .permission-approval-panel")).not.toBeNull();
		expect(container.querySelector("svg.warning, [data-icon='warning']")).toBeNull();
		expect(text).not.toContain("Waiting for approval");
		expect(text).not.toContain("Network destination needs approval");
		expect(text).not.toContain("This command remains limited to the displayed workspace sandbox.");
		expect(text).not.toContain("Automatic security review");
		expect(text).toContain("curl https://example.test");
		expect(text).toContain("/tmp/work/out.txt");
		expect(text).not.toContain(REDACTED);
		expect(text).toContain("Network");

		expect(button(container, "Reject")).not.toBeNull();
		expect(button(container, "Allow once")).not.toBeNull();
		expect(visibleText(container)).not.toContain("Always allow this exact action");
		expect(visibleText(container)).not.toContain("Always deny this exact action");

		const disclosure = button(container, "Details");
		expect(disclosure.getAttribute("aria-expanded")).toBe("false");
		act(() => disclosure.click());
		const details = container.querySelector<HTMLElement>(".permission-approval-details")!;
		expect(disclosure.getAttribute("aria-expanded")).toBe("true");
		expect(disclosure.getAttribute("aria-controls")).toBe(details.id);
		expect(details.hidden).toBe(false);
		expect(visibleText(container)).toContain("example.test");
		expect(details.textContent).toContain(REDACTED);
		expect(details.textContent).toContain("Network destination needs approval");
	});

	it("keeps the working directory visible when a relative command needs it", () => {
		const { container } = mount(
			approval({
				details: [
					{ label: "Command", value: "npm test" },
					{ label: "Working directory", value: "/tmp/work" },
				],
			}),
		);
		const text = visibleText(container);
		expect(text).toContain("npm test");
		expect(text).toContain("/tmp/work");
	});

	it("keeps host, external, critical, blocked, and incomplete decision text visible", () => {
		const { container } = mount(
			approval({
				executionTarget: "external",
				riskLevel: "critical",
				scopeComplete: false,
				priorReviewer: "model",
				priorReviewerOutcome: "deny",
			}),
			vi.fn().mockResolvedValue(undefined),
			"misconfigured",
		);
		const text = visibleText(container);
		expect(text).toContain("This action reaches a network or external service.");
		expect(text).toContain("This operation may not be reversible.");
		expect(text).toContain("This tool did not provide enough target details. Deny and retry with a specific target.");
		expect(text).not.toContain("This action stays blocked instead of running on the host.");
		expect(text).not.toContain("Automatic security review denied this action.");
	});

	it("keeps sandbox blocking visible and disables every allow choice", () => {
		const { container } = mount(approval(), vi.fn().mockResolvedValue(undefined), "unavailable");
		expect(visibleText(container)).toContain(
			"Workspace sandbox is unavailable. This action stays blocked instead of running on the host.",
		);
		expect(button(container, "Allow once").disabled).toBe(true);
		expect(button(container, "Reject").disabled).toBe(false);
		act(() => button(container, "More").click());
		expect(button(container, "Always allow this exact action").disabled).toBe(true);
		expect(button(container, "Always deny this exact action").disabled).toBe(false);
	});

	it("disables only persistent allow when the scope is incomplete", () => {
		const { container } = mount(approval({ scopeComplete: false }));
		expect(visibleText(container)).toContain(
			"This tool did not provide enough target details. Deny and retry with a specific target.",
		);
		expect(button(container, "Allow once").disabled).toBe(false);
		act(() => button(container, "More").click());
		expect(button(container, "Always allow this exact action").disabled).toBe(true);
		expect(button(container, "Always deny this exact action").disabled).toBe(false);
	});

	it("reveals only the persistent exact choices the server supplied", () => {
		const { container } = mount(approval({ choices: ["allow-once", "deny-once", "always-deny-exact"] }));
		expect(visibleText(container)).not.toContain("Always deny this exact action");
		const more = button(container, "More");
		expect(more.getAttribute("aria-expanded")).toBe("false");
		expect(more.getAttribute("aria-controls")).toBeTruthy();
		act(() => more.click());
		expect(more.getAttribute("aria-expanded")).toBe("true");
		const persistent = container.querySelector<HTMLElement>(`[id="${more.getAttribute("aria-controls") ?? ""}"]`)!;
		expect(persistent.hidden).toBe(false);
		expect(button(container, "Always deny this exact action")).not.toBeNull();
		expect(container.textContent).not.toContain("Always allow this exact action");
	});

	it("omits More when the server supplied no persistent choices", () => {
		const { container } = mount(approval({ choices: ["allow-once", "deny-once"] }));
		expect(container.textContent).not.toContain("More");
	});

	it("discloses details and submits the exact choice once", async () => {
		const onRespond = vi.fn().mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const { container } = mount(approval(), onRespond);
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.activeElement?.textContent).toContain("Reject");

		const more = button(container, "More");
		more.focus();
		await act(async () => more.click());
		expect(more.getAttribute("aria-expanded")).toBe("true");
		await act(async () => more.click());
		expect(more.getAttribute("aria-expanded")).toBe("false");

		const details = button(container, "Details");
		details.focus();
		await act(async () => details.click());
		expect(details.getAttribute("aria-expanded")).toBe("true");

		await act(async () => button(container, "Allow once").click());
		expect(button(container, "Allow once").disabled).toBe(true);
		expect(button(container, "Reject").disabled).toBe(true);
		expect(more.disabled).toBe(true);
		expect(container.querySelector("[aria-live='polite']")?.textContent).toContain("Sending your decision…");
		await act(async () => button(container, "Allow once").click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000301",
			kind: "session_permission_approval",
			choice: "allow-once",
		});
	});

	it("denies with Escape even while More is expanded and never sends a second response", async () => {
		const onRespond = vi.fn().mockResolvedValue(undefined);
		const { container } = mount(approval(), onRespond);
		act(() => button(container, "More").click());
		await act(async () => {
			press(panel(container), "Escape");
			press(panel(container), "Escape");
		});
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ choice: "deny-once" }));
	});

	it("retries a failed decision and closes a stale response without authorizing again", async () => {
		const onRespond = vi
			.fn()
			.mockRejectedValueOnce(new Error("network down"))
			.mockRejectedValueOnce(new Error("Approval was unavailable or cancelled"));
		const { container } = mount(approval(), onRespond);
		await act(async () => button(container, "Allow once").click());
		expect(container.querySelector(".error-copy")?.textContent).toContain("network down");
		expect(button(container, "Allow once").disabled).toBe(false);

		await act(async () => button(container, "Reject").click());
		expect(container.textContent).toContain("This approval is no longer available.");
		expect(container.querySelector(".permission-approval-panel")).toBeNull();
		expect(onRespond).toHaveBeenCalledTimes(2);
	});

	it("uses unique aria references and focuses only inside the active owned pane", async () => {
		const previous = document.createElement("button");
		previous.textContent = "composer";
		document.body.append(previous);
		previous.focus();
		const firstPane = document.createElement("section");
		firstPane.className = "conversation-column";
		document.body.append(firstPane);
		const first = mount(approval(), vi.fn().mockResolvedValue(undefined), "healthy", firstPane);
		await act(async () => Promise.resolve());
		const pane = document.createElement("section");
		pane.className = "conversation-column";
		document.body.append(pane);
		const second = mount(
			approval({
				interactionId: "00000000-0000-4000-8000-000000000302",
				requestId: "00000000-0000-4000-8000-000000000302",
			}),
			vi.fn().mockResolvedValue(undefined),
			"healthy",
			pane,
		);
		await act(async () => {
			await Promise.resolve();
		});

		const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(panel(second.container).contains(document.activeElement)).toBe(false);
		expect(panel(first.container).getAttribute("aria-labelledby")).not.toBe("permission-approval-title");

		await act(async () => first.root.unmount());
		expect(panel(second.container).contains(document.activeElement)).toBe(false);
	});

	it("ignores a response that resolves after a newer approval replaced it", async () => {
		let settle: (value: void | PromiseLike<void>) => void = () => {};
		const firstRespond = vi.fn().mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
		);
		const secondRespond = vi.fn().mockResolvedValue(undefined);
		const { container, root } = mount(approval(), firstRespond);
		await act(async () => button(container, "Allow once").click());
		rerender(
			root,
			approval({
				interactionId: "00000000-0000-4000-8000-000000000309",
				requestId: "00000000-0000-4000-8000-000000000309",
			}),
			secondRespond,
		);
		await act(async () => {
			settle();
		});
		expect(container.querySelector(".error-copy")).toBeNull();
		expect(button(container, "Allow once").disabled).toBe(false);
		expect(secondRespond).not.toHaveBeenCalled();
	});
});
