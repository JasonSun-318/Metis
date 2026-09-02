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
	act(() => root.render(<InteractionHost interaction={interaction} onRespond={onRespond} sandboxHealth={sandboxHealth} />));
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
	it("renders exact risk, target, path, and domain details without secrets or hidden reasoning", async () => {
		const { container } = mount(approval({
			priorReviewer: "model",
			priorReviewerOutcome: "unavailable",
			riskLevel: "critical",
			executionTarget: "external",
		}));
		const panel = container.querySelector(".permission-approval-panel")!;
		expect(panel.textContent).toContain("Metis wants to use bash");
		expect(panel.textContent).toContain("Command");
		expect(panel.textContent).toContain("curl https://example.test");
		expect(panel.textContent).toContain("Path");
		expect(panel.textContent).toContain("/tmp/work/out.txt");
		expect(panel.textContent).toContain("Network");
		expect(panel.textContent).toContain("example.test");
		expect(panel.textContent).toContain(REDACTED);
		expect(panel.textContent).toContain("This action reaches a network or external service.");
		expect(panel.textContent).toContain("Automatic security review could not approve this action.");
		expect(panel.textContent).toContain("This operation may not be reversible.");
		expect(panel.textContent).not.toContain(SECRET);
		expect(panel.textContent).not.toContain("base64");
		expect(panel.textContent).not.toMatch(/hidden reasoning|system prompt/i);
		expect(choice(container, "Allow once")).not.toBeNull();
		expect(choice(container, "Reject")).not.toBeNull();
		expect(choice(container, "Always allow this exact action")).not.toBeNull();
		expect(choice(container, "Always deny this exact action")).not.toBeNull();
	});

	it("focuses the deny control, traps Tab, submits once, and restores focus after close", async () => {
		const previous = document.createElement("button");
		previous.textContent = "composer";
		document.body.append(previous);
		previous.focus();
		const onRespond = vi.fn().mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const { container, root } = mount(approval(), onRespond);
		await act(async () => { await Promise.resolve(); });
		expect(document.activeElement?.textContent).toContain("Reject");
		await act(async () => {
			document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab", shiftKey: true }));
		});
		expect(document.activeElement?.textContent).toContain("Allow once");
		await act(async () => {
			document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
		});
		expect(document.activeElement?.textContent).toContain("Reject");
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
		const onRespond = vi.fn()
			.mockRejectedValueOnce(new Error("Approval was unavailable or cancelled"))
			.mockResolvedValue(undefined);
		const { container } = mount(approval(), onRespond);
		await act(async () =>
			container.querySelector(".permission-approval-panel")!.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
			),
		);
		expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ choice: "deny-once" }));
		expect(container.textContent).toContain("This approval is no longer available.");
		expect(container.querySelector(".permission-approval-panel")).toBeNull();
		expect(onRespond).toHaveBeenCalledTimes(1);
	});

	it("blocks sandbox actions when sandbox health is unhealthy instead of offering a host fallback", async () => {
		const { container, onRespond } = mount(approval(), vi.fn().mockResolvedValue(undefined), "misconfigured");
		expect(container.textContent).toContain("This action stays blocked instead of running on the host.");
		expect(choice(container, "Allow once").disabled).toBe(true);
		expect(choice(container, "Always allow this exact action").disabled).toBe(true);
		expect(choice(container, "Reject").disabled).toBe(false);
		await act(async () => choice(container, "Reject").click());
		expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ choice: "deny-once" }));
	});

	it("translates the live review and approval surface", async () => {
		await setLocale("zh-CN");
		const { container } = mount(approval({
			priorReviewer: "model",
			priorReviewerOutcome: "deny",
			executionTarget: "host",
		}));
		expect(container.textContent).toContain("始终允许此精确操作");
		expect(container.textContent).toContain("始终拒绝此精确操作");
		expect(container.textContent).toContain("自动安全审查拒绝了此操作。");
		expect(container.textContent).toContain("此操作将在沙箱外以当前用户权限运行。");
	});
});
