// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoCommandAllowlistPanel } from "../src/renderer/components/AutoCommandAllowlistPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(container: ParentNode, label: string): HTMLButtonElement | null {
	return (
		[...container.querySelectorAll("button")].find(
			(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
		) ?? null
	);
}

function clickButton(container: ParentNode, label: string) {
	const match = button(container, label);
	if (!match) throw new Error(`Missing button: ${label}`);
	match.click();
}

function setInput(container: ParentNode, value: string) {
	const input = container.querySelector<HTMLInputElement>('input[type="text"]');
	if (!input) throw new Error("Missing command input");
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickCheckbox(container: ParentNode, label: string) {
	const checkbox = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label || candidate.closest("label")?.textContent?.includes(label),
	);
	if (!checkbox) throw new Error(`Missing checkbox: ${label}`);
	checkbox.click();
}

function clientStub(overrides: Partial<MetisDesktopApi> = {}): MetisDesktopApi {
	return {
		getPermissionAutoSettings: vi.fn().mockResolvedValue({ rules: [], suggestions: ["ls", "curl"] }),
		updatePermissionAutoSettings: vi.fn().mockImplementation(async ({ rules }) => ({
			rules,
			suggestions: ["ls", "curl"],
		})),
		...overrides,
	} as unknown as MetisDesktopApi;
}

async function renderPanel(api: MetisDesktopApi) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<AutoCommandAllowlistPanel api={api} serverReady />));
	await flush();
	return { container, root };
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("AutoCommandAllowlistPanel", () => {
	it("loads global rules and suggestions", async () => {
		const client = clientStub({
			getPermissionAutoSettings: vi.fn().mockResolvedValue({
				rules: [{ command: "git status", allowNetwork: false }],
				suggestions: ["ls", "git status", "curl"],
			}),
		});
		const { container, root } = await renderPanel(client);
		expect(container.textContent).toContain("git status");
		expect(button(container, "Add ls")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("adds a command with the selected network setting", async () => {
		const client = clientStub();
		const { container, root } = await renderPanel(client);
		setInput(container, "curl");
		clickCheckbox(container, "Allow network access");
		await act(async () => clickButton(container, "Add command"));
		await flush();
		expect(client.updatePermissionAutoSettings).toHaveBeenCalledWith({
			requestId: expect.any(String),
			rules: [{ command: "curl", allowNetwork: true }],
		});
		expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("");
		expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
		await act(async () => root.unmount());
	});

	it("does not clear the pending next rule when removing an existing rule", async () => {
		const client = clientStub({
			getPermissionAutoSettings: vi.fn().mockResolvedValue({
				rules: [{ command: "ls", allowNetwork: false }],
				suggestions: [],
			}),
		});
		const { container, root } = await renderPanel(client);
		setInput(container, "curl");
		clickCheckbox(container, "Allow network access");
		await act(async () => clickButton(container, "Remove ls"));
		await flush();
		expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("curl");
		expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
		await act(async () => root.unmount());
	});

	it("removes a rule by replacing the complete list", async () => {
		const client = clientStub({
			getPermissionAutoSettings: vi.fn().mockResolvedValue({
				rules: [
					{ command: "ls", allowNetwork: false },
					{ command: "curl", allowNetwork: true },
				],
				suggestions: [],
			}),
		});
		const { container, root } = await renderPanel(client);
		await act(async () => clickButton(container, "Remove ls"));
		await flush();
		expect(client.updatePermissionAutoSettings).toHaveBeenCalledWith({
			requestId: expect.any(String),
			rules: [{ command: "curl", allowNetwork: true }],
		});
		await act(async () => root.unmount());
	});

	it("adds the typed command when Enter is pressed", async () => {
		const client = clientStub();
		const { container, root } = await renderPanel(client);
		setInput(container, "pwd");
		const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
		await act(async () =>
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
		);
		await flush();
		expect(client.updatePermissionAutoSettings).toHaveBeenCalledWith({
			requestId: expect.any(String),
			rules: [{ command: "pwd", allowNetwork: false }],
		});
		await act(async () => root.unmount());
	});

	it("does not submit a duplicate command", async () => {
		const client = clientStub({
			getPermissionAutoSettings: vi.fn().mockResolvedValue({
				rules: [{ command: "ls", allowNetwork: false }],
				suggestions: ["ls"],
			}),
		});
		const { container, root } = await renderPanel(client);
		setInput(container, " ls ");
		await act(async () => clickButton(container, "Add command"));
		await flush();
		expect(client.updatePermissionAutoSettings).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("disables controls while a save is in flight", async () => {
		let resolveUpdate:
			| ((value: { rules: { command: string; allowNetwork: boolean }[]; suggestions: string[] }) => void)
			| undefined;
		const client = clientStub({
			updatePermissionAutoSettings: vi.fn(
				() =>
					new Promise<Awaited<ReturnType<MetisDesktopApi["updatePermissionAutoSettings"]>>>((resolve) => {
						resolveUpdate = resolve;
					}),
			),
		});
		const { container, root } = await renderPanel(client);
		setInput(container, "cat");
		await act(async () => clickButton(container, "Add command"));
		expect(button(container, "Add command")?.disabled).toBe(true);
		expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.disabled).toBe(true);
		await act(async () => resolveUpdate?.({ rules: [{ command: "cat", allowNetwork: false }], suggestions: ["ls"] }));
		await flush();
		expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.disabled).toBe(false);
		expect(button(container, "Add ls")?.disabled).toBe(false);
		await act(async () => root.unmount());
	});

	it("recovers from a server error and keeps the previous rules", async () => {
		const client = clientStub({
			getPermissionAutoSettings: vi.fn().mockResolvedValue({
				rules: [{ command: "ls", allowNetwork: false }],
				suggestions: ["curl"],
			}),
			updatePermissionAutoSettings: vi
				.fn()
				.mockRejectedValueOnce(new Error("Auto command rules could not be saved."))
				.mockResolvedValue({
					rules: [
						{ command: "ls", allowNetwork: false },
						{ command: "curl", allowNetwork: false },
					],
					suggestions: [],
				}),
		});
		const { container, root } = await renderPanel(client);
		setInput(container, "curl");
		await act(async () => clickButton(container, "Add command"));
		await flush();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Auto command rules could not be saved.",
		);
		expect(container.textContent).toContain("ls");
		await act(async () => clickButton(container, "Add command"));
		await flush();
		expect(client.updatePermissionAutoSettings).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		await act(async () => root.unmount());
	});

	it("adds a suggestion without enabling network", async () => {
		const client = clientStub();
		const { container, root } = await renderPanel(client);
		clickCheckbox(container, "Allow network access");
		await act(async () => clickButton(container, "Add ls"));
		await flush();
		expect(client.updatePermissionAutoSettings).toHaveBeenCalledWith({
			requestId: expect.any(String),
			rules: [{ command: "ls", allowNetwork: false }],
		});
		await act(async () => root.unmount());
	});
});
