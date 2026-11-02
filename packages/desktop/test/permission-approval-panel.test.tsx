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
		command: "curl https://example.test",
		rememberSessionEligible: true,
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

function press(element: HTMLElement, key: string, options: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options });
	element.dispatchEvent(event);
	return event;
}

function more(container: HTMLElement) {
	const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
	if (!trigger) throw new Error("Missing approval choice menu");
	return trigger;
}

describe("permission approval panel", () => {
	it("shows only the confirmation, complete command, and compact decision controls", () => {
		const { container } = mount();
		const text = visibleText(container);
		expect(container.querySelector("h2")?.textContent).toBe("Allow Metis to execute the following command?");
		expect(container.querySelector(".permission-approval-command")?.textContent).toBe("curl https://example.test");
		for (const hidden of [
			"Details",
			"Working directory",
			"Network destination needs approval",
			"Automatic security review",
			"/tmp/work/out.txt",
			REDACTED,
		]) {
			expect(text).not.toContain(hidden);
		}
		expect(button(container, "Reject")).toBeTruthy();
		expect(button(container, "Allow once")).toBeTruthy();
		expect(more(container)).toBeTruthy();
	});

	it("shows the Windows directory write scope and its subdirectory meaning", () => {
		const directory = "C:\\Users\\dev\\project\\src";
		const { container } = mount(
			approval({
				details: [
					{ label: "Working directory", value: "C:\\Users\\dev\\project" },
					{ label: "Writable directory", value: directory },
					{ label: "Network", value: "10.0.0.1:8443" },
				],
			}),
		);
		const scope = container.querySelector<HTMLElement>(".permission-approval-scope");
		expect(scope?.textContent).toContain("Writable directories");
		expect(scope?.textContent).toContain(directory);
		expect(scope?.textContent).toContain("Includes new files and subdirectories.");
		const text = visibleText(container);
		expect(text).not.toContain("Working directory");
		expect(text).not.toContain("10.0.0.1:8443");
	});

	it("localizes the Windows directory write scope", async () => {
		await setLocale("zh-CN");
		const { container } = mount(approval({ details: [{ label: "Writable directory", value: "C:\\项目\\src" }] }));
		const scope = container.querySelector<HTMLElement>(".permission-approval-scope");
		expect(scope?.textContent).toContain("可写目录");
		expect(scope?.textContent).toContain("C:\\项目\\src");
		expect(scope?.textContent).toContain("包含新建文件和子目录。");
	});

	it("uses the agreed Chinese confirmation and compact remembered choices", async () => {
		await setLocale("zh-CN");
		const { container } = mount();
		expect(container.querySelector("h2")?.textContent).toBe("允许 Metis 执行以下命令吗？");
		expect(button(container, "允许一次")).toBeTruthy();
		await act(async () => more(container).click());
		expect(button(container, "记住到项目")).toBeTruthy();
	});

	it("keeps a long multiline command including Unicode paths complete", () => {
		const command = Array.from({ length: 100 }, () => "rg --files 'src/中文目录' | head -n 1").join(" &&\n");
		expect(Buffer.byteLength(command)).toBeGreaterThan(256);
		const { container } = mount(approval({ command }));
		expect(container.querySelector("pre code")?.textContent).toBe(command);
	});

	it("uses the action wording and exact targets for a non-shell operation", () => {
		const { container } = mount(
			approval({
				toolLabel: "write_file",
				command: undefined,
				details: [{ label: "Path", value: "/tmp/目标.txt" }],
			}),
		);
		expect(container.querySelector("h2")?.textContent).toBe("Allow Metis to perform the following action?");
		expect(container.querySelector("pre")?.textContent).toContain("write_file");
		expect(container.querySelector("pre")?.textContent).toContain("/tmp/目标.txt");
	});

	it("does not recreate a missing full command from legacy truncated rows", async () => {
		const { container, onRespond } = mount(approval({ command: undefined }));
		expect(container.querySelector("pre")).toBeNull();
		expect(container.textContent).not.toContain("curl https://example.test");
		expect(button(container, "Allow once").disabled).toBe(true);
		await act(async () => press(panel(container), "Enter"));
		expect(onRespond).not.toHaveBeenCalled();
	});

	it("keeps only a short sandbox failure and blocks every allow path", async () => {
		const { container, onRespond } = mount(approval(), vi.fn().mockResolvedValue(undefined), "unavailable");
		expect(container.textContent).toContain("Workspace sandbox is unavailable");
		expect(button(container, "Allow once").disabled).toBe(true);
		expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
		await act(async () => press(panel(container), "Enter"));
		expect(onRespond).not.toHaveBeenCalled();
		expect(button(container, "Reject").disabled).toBe(false);
	});

	it.each([{ scopeComplete: false }, { riskLevel: "critical" as const }])(
		"does not offer remembered authorization for an ineligible action",
		(change) => {
			const { container } = mount(approval(change));
			expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
			expect(button(container, "Allow once").disabled).toBe(false);
			expect(visibleText(container)).not.toContain("This operation may not be reversible");
		},
	);

	it("offers only server-supplied remembered choices and checks session eligibility", async () => {
		const { container, onRespond } = mount(
			approval({ choices: ["allow-once", "deny-once", "allow-session-exact"], rememberSessionEligible: true }),
		);
		await act(async () => more(container).click());
		expect(button(container, "Allow for this session")).toBeTruthy();
		expect(container.textContent).not.toContain("Remember for this project");
		await act(async () => button(container, "Allow for this session").click());
		expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ choice: "allow-session-exact" }));
	});

	it("hides a session choice when the current request is not eligible", () => {
		const { container } = mount(
			approval({ choices: ["allow-once", "deny-once", "allow-session-exact"], rememberSessionEligible: false }),
		);
		expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
	});

	it("has no empty dropdown when only one-time decisions are available", () => {
		const { container } = mount(approval({ choices: ["allow-once", "deny-once"] }));
		expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
	});

	it("focuses the dialog for reading, submits the exact choice once, and locks all controls", async () => {
		const onRespond = vi.fn(async () => new Promise<void>(() => {}));
		const { container } = mount(approval(), onRespond);
		await act(async () => Promise.resolve());
		expect(document.activeElement).toBe(panel(container));
		await act(async () => button(container, "Allow once").click());
		expect(button(container, "Allow once").disabled).toBe(true);
		expect(button(container, "Reject").disabled).toBe(true);
		expect(more(container).disabled).toBe(true);
		await act(async () => button(container, "Allow once").click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({
			interactionId: approval().interactionId,
			kind: "session_permission_approval",
			choice: "allow-once",
		});
	});

	it("keeps inline approvals unfocused until the user enters the card", async () => {
		const composer = document.createElement("div");
		composer.contentEditable = "true";
		composer.tabIndex = 0;
		const card = document.createElement("div");
		card.className = "conversation-interaction-card";
		document.body.append(composer, card);
		composer.focus();
		const { container, onRespond } = mount(approval(), vi.fn().mockResolvedValue(undefined), "healthy", card);
		await act(async () => Promise.resolve());
		expect(document.activeElement).toBe(composer);
		await act(async () => {
			press(composer, "Enter");
			press(composer, "Escape");
		});
		expect(onRespond).not.toHaveBeenCalled();
		await act(async () => {
			panel(container).focus();
			press(panel(container), "Enter");
		});
		expect(onRespond).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ choice: "allow-once" }));
	});

	it("allows once with Enter only after modifiers, composition, repeat and selection guards", async () => {
		const { container, onRespond } = mount();
		await act(async () => {
			press(panel(container), "Enter", { ctrlKey: true });
			press(panel(container), "Enter", { shiftKey: true });
			expect(press(button(container, "Allow once"), "Enter", { isComposing: true }).defaultPrevented).toBe(true);
			expect(press(button(container, "Allow once"), "Enter", { repeat: true }).defaultPrevented).toBe(true);
		});
		const range = document.createRange();
		range.selectNodeContents(container.querySelector("pre")!);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
		expect(window.getSelection()!.isCollapsed).toBe(false);
		await act(async () => press(panel(container), "Enter"));
		expect(onRespond).not.toHaveBeenCalled();
		window.getSelection()!.removeAllRanges();
		await act(async () => press(panel(container), "Enter"));
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ choice: "allow-once" }));
	});

	it("does not turn menu Enter or its first Escape into a one-time approval", async () => {
		const { container, onRespond } = mount();
		await act(async () => more(container).click());
		await act(async () => press(more(container), "Enter"));
		expect(onRespond).not.toHaveBeenCalled();
		await act(async () => press(more(container), "Escape"));
		expect(onRespond).not.toHaveBeenCalled();
		expect(more(container).getAttribute("aria-expanded")).toBe("false");
		await act(async () => {
			press(panel(container), "Escape");
			press(panel(container), "Escape");
		});
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ choice: "deny-once" }));
	});

	it("does not approve a new request from a repeated Enter key", async () => {
		const { container, root } = mount();
		const next = vi.fn().mockResolvedValue(undefined);
		rerender(root, approval({ interactionId: "00000000-0000-4000-8000-000000000319" }), next);
		await act(async () => press(button(container, "Allow once"), "Enter", { repeat: true }));
		expect(next).not.toHaveBeenCalled();
	});

	it("ignores the second click of a double click and catches synchronous response failures", async () => {
		const onRespond = vi.fn(() => {
			throw new Error("synchronous failure");
		});
		const { container } = mount(approval(), onRespond);
		await act(async () =>
			button(container, "Allow once").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })),
		);
		expect(onRespond).not.toHaveBeenCalled();
		await act(async () => button(container, "Allow once").click());
		expect(container.querySelector(".error-copy")?.textContent).toContain("synchronous failure");
		expect(button(container, "Allow once").disabled).toBe(false);
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
