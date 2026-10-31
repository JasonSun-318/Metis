// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoCommandAllowlistPanel } from "../src/renderer/components/AutoCommandAllowlistPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	acceptedRules,
	autoSettingsView,
	makeRuleView,
	type TestPermissionRuleView,
} from "./fixtures/permission-rules.ts";

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

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function menuItem(label: string): HTMLButtonElement | null {
	return (
		[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
			(candidate) => candidate.textContent?.trim() === label,
		) ?? null
	);
}

function dialogButton(dialog: Element, label: string): HTMLButtonElement | null {
	return (
		[...dialog.querySelectorAll("button")].find(
			(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
		) ?? null
	);
}

async function openAdvanced(dialog: Element) {
	const details = dialog.querySelector<HTMLDetailsElement>("details")!;
	if (!details.open) await act(async () => details.querySelector("summary")!.click());
	await flush();
	expect(details.open).toBe(true);
	return details;
}

async function chooseScope(dialog: Element, label: string) {
	await act(async () => dialogButton(dialog, "File scope")!.click());
	await flush();
	const option = [...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	expect(option).toBeTruthy();
	await act(async () => option!.click());
	await flush();
}

function clientStub(rules: readonly TestPermissionRuleView[], defaults: readonly TestPermissionRuleView[] = []) {
	const get = vi.fn().mockResolvedValue(autoSettingsView(rules, defaults));
	const update = vi
		.fn()
		.mockImplementation(async (input: { permissionRules: readonly Record<string, unknown>[] }) =>
			autoSettingsView(acceptedRules(input.permissionRules), defaults),
		);
	return {
		client: { getPermissionAutoSettings: get, updatePermissionAutoSettings: update } as unknown as MetisDesktopApi,
		get,
		update,
	};
}

async function renderPanel(
	client: MetisDesktopApi,
	focusRuleId?: string,
	scopePreview?: Parameters<typeof AutoCommandAllowlistPanel>[0]["scopePreview"],
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<AutoCommandAllowlistPanel
				api={client}
				embedded
				focusRuleId={focusRuleId}
				scopePreview={scopePreview}
				serverReady
			/>,
		),
	);
	await flush();
	return { container, root };
}

function payloadOf(call: unknown): { permissionRules: readonly Record<string, unknown>[] } {
	return (call as { permissionRules: readonly Record<string, unknown>[] }) ?? { permissionRules: [] };
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	Element.prototype.scrollIntoView = vi.fn();
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("AutoCommandAllowlistPanel", () => {
	it("explains an audit link to a tool permission without adding it to the command list", async () => {
		const tool = makeRuleView({ id: "T01", name: "Read file", kind: "tool", command: undefined, toolName: "read" });
		const { client, update } = clientStub([tool, makeRuleView({ id: "C04", name: "cat" })]);
		const { container, root } = await renderPanel(client, "T01");
		expect(container.querySelector("output.settings-helper")?.textContent).toContain(
			"Read file is a tool permission. This list manages command rules.",
		);
		expect(container.querySelector('[data-rule-id="T01"]')).toBeNull();
		expect(container.querySelector('[data-rule-id="C04"]')).not.toBeNull();
		expect(update).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("lists only command rules in one-line rows with mode and directory markers", async () => {
		const tool = makeRuleView({
			id: "T01",
			name: "Read file",
			kind: "tool",
			toolName: "read",
			command: undefined,
		});
		const { container, root } = await renderPanel(
			clientStub([
				makeRuleView({ id: "C04", name: "cat" }),
				makeRuleView({ id: "user-deploy", name: "deploy" }),
				makeRuleView({
					id: "user-external",
					name: "cargo test",
					scope: "directories",
					directories: ["/external"],
				}),
				makeRuleView({
					id: "E01",
					name: "OfficeCLI 命令",
					kind: "compatibility",
					modes: ["ask", "auto"],
					scope: "all",
					command: "officecli",
				}),
				tool,
			]).client,
		);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
		const rows = [...container.querySelectorAll(".permission-rules-row")];
		expect(rows.map((row) => row.querySelector("code")?.textContent)).toEqual([
			"cargo test",
			"cat",
			"deploy",
			"OfficeCLI commands",
		]);
		expect(container.textContent).not.toContain("Read file");
		expect(rows[0]!.textContent).not.toContain("Default");
		expect(rows[2]!.textContent).not.toContain("Your rule");
		expect(rows[0]!.textContent).toContain("Auto");
		const externalRow = container.querySelector('.permission-rules-row[data-rule-id="user-external"]')!;
		expect(externalRow.textContent).toContain("Directories (1)");
		expect(externalRow.querySelector(".permission-rule-directory")?.getAttribute("title")).toBe("/external");
		expect(container.querySelector(".permission-rules-scroll")).not.toBeNull();
		expect(container.textContent).toContain("4 enabled");
		await act(async () => root.unmount());
	});

	it("keeps non-command rule records when a command is saved", async () => {
		const tool = makeRuleView({
			id: "T01",
			name: "Read file",
			kind: "tool",
			toolName: "read",
			command: undefined,
			enabled: false,
		});
		const stub = clientStub([makeRuleView({ id: "C04", name: "cat" }), tool]);
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Edit cat")!.click());
		const dialog = container.querySelector("dialog")!;
		await openAdvanced(dialog);
		await chooseScope(dialog, "Selected directories");
		setValue(dialog.querySelector<HTMLTextAreaElement>("textarea")!, "/external/read-only");
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		const payload = payloadOf(stub.update.mock.calls[0]![0]).permissionRules;
		expect(payload.find((rule) => rule.id === "C04")).toMatchObject({
			scope: "directories",
			directories: ["/external/read-only"],
			command: "cat",
		});
		expect(payload.find((rule) => rule.id === "T01")).toMatchObject({
			kind: "tool",
			toolName: "read",
			enabled: false,
		});
		await act(async () => root.unmount());
	});

	it("marks disabled rules and can reenable them without changing other records", async () => {
		const disabledTool = makeRuleView({
			id: "T01",
			name: "Read file",
			kind: "tool",
			toolName: "read",
			command: undefined,
			enabled: false,
		});
		const stub = clientStub([
			makeRuleView({ id: "user-docker", name: "docker ps", command: "docker ps", enabled: false }),
			disabledTool,
			makeRuleView({ id: "C04", name: "cat" }),
		]);
		const { container, root } = await renderPanel(stub.client);
		const disabledRow = container.querySelector('.permission-rules-row[data-rule-id="user-docker"]')!;
		expect(disabledRow.textContent).toContain("Disabled");
		expect(container.querySelector('.permission-rules-row[data-rule-id="C04"]')!.textContent).not.toContain(
			"Disabled",
		);
		expect(container.textContent).toContain("1 enabled");

		await act(async () => button(container, "Edit docker ps")!.click());
		const dialog = container.querySelector("dialog")!;
		await openAdvanced(dialog);
		const enable = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((candidate) =>
			candidate.closest("label")?.textContent?.includes("Enable rule"),
		)!;
		expect(enable.checked).toBe(false);
		await act(async () => enable.click());
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();

		const payload = payloadOf(stub.update.mock.calls[0]![0]).permissionRules;
		expect(payload.find((rule) => rule.id === "user-docker")).toMatchObject({ enabled: true });
		expect(payload.find((rule) => rule.id === "T01")).toMatchObject({ enabled: false, toolName: "read" });
		expect(payload.find((rule) => rule.id === "C04")).toMatchObject({ enabled: true });
		expect(container.querySelector('.permission-rules-row[data-rule-id="user-docker"]')?.textContent).not.toContain(
			"Disabled",
		);
		await act(async () => root.unmount());
	});

	it("searches every command rule without pagination", async () => {
		const rules = Array.from({ length: 30 }, (_, index) =>
			makeRuleView({ id: `user-${index}`, name: `cmd-${String(index).padStart(2, "0")}` }),
		);
		const { container, root } = await renderPanel(clientStub(rules).client);
		expect(container.querySelectorAll(".permission-rules-row")).toHaveLength(30);
		expect(container.textContent).not.toContain("Page 1 of");
		setValue(container.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!, "cmd-29");
		await flush();
		expect(container.querySelectorAll(".permission-rules-row")).toHaveLength(1);
		expect(container.textContent).toContain("cmd-29");
		await act(async () => root.unmount());
	});

	it("highlights and scrolls a focused command row into view", async () => {
		const { container, root } = await renderPanel(
			clientStub([makeRuleView({ id: "C04", name: "cat" }), makeRuleView({ id: "C22", name: "git status" })]).client,
			"C22",
		);
		const focused = container.querySelector('.permission-rules-row[data-rule-id="C22"]')!;
		expect(focused.classList.contains("is-focused")).toBe(true);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("edits a user command and keeps its name in sync", async () => {
		const stub = clientStub([makeRuleView({ id: "user-git-status", name: "git status", command: "git status" })]);
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Edit git status")!.click());
		const dialog = container.querySelector("dialog")!;
		setValue(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, "git diff");
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		const payload = payloadOf(stub.update.mock.calls[0]![0]).permissionRules;
		expect(payload[0]).toMatchObject({
			id: "user-git-status",
			name: "git diff",
			command: "git diff",
			origin: "user",
		});
		expect(container.querySelector("dialog")).toBeNull();
		await act(async () => root.unmount());
	});

	it("keeps the default editor minimal and puts constraints in collapsed advanced options", async () => {
		const stub = clientStub([makeRuleView({ id: "C04", name: "cat" })]);
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Edit cat")!.click());
		const dialog = container.querySelector("dialog")!;
		expect(dialog.querySelector(".permission-rule-static")?.textContent).toContain("cat");
		expect(dialog.querySelector('input[type="text"]')).toBeNull();
		const body = dialog.querySelector(".model-provider-editor-body")!;
		expect([...body.children].filter((child) => child.tagName !== "DETAILS")).toHaveLength(1);
		const advanced = dialog.querySelector<HTMLDetailsElement>("details")!;
		expect(advanced.open).toBe(false);
		expect(advanced.querySelector("fieldset legend")?.textContent).toBe("Applies in");
		await openAdvanced(dialog);
		expect(dialogButton(dialog, "File scope")).not.toBeNull();
		expect(dialog.querySelector<HTMLInputElement>(".permission-rule-check input")?.checked).toBe(true);
		expect(dialog.textContent).toContain("Sensitive files, writes, network access, and unknown options");
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		const payload = payloadOf(stub.update.mock.calls[0]![0]).permissionRules;
		expect(payload[0]).toMatchObject({ id: "C04", name: "cat", command: "cat", origin: "default" });
		await act(async () => root.unmount());
	});

	it("adds a command with the default Auto-only mode", async () => {
		const stub = clientStub([makeRuleView({ id: "C04", name: "cat" })]);
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Add command")!.click());
		const dialog = container.querySelector("dialog")!;
		setValue(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, "git log");
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		const payload = payloadOf(stub.update.mock.calls[0]![0]).permissionRules;
		expect(payload).toHaveLength(2);
		expect(payload[1]).toMatchObject({
			name: "git log",
			command: "git log",
			origin: "user",
			kind: "command",
			modes: ["auto"],
			enabled: true,
		});
		expect(payload[1]!.id).toMatch(/^user-[0-9a-f-]{36}$/u);
		await act(async () => root.unmount());
	});

	it("requires and saves exact network destinations from advanced options", async () => {
		const stub = clientStub([]);
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Add command")!.click());
		const dialog = container.querySelector("dialog")!;
		setValue(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, "curl");
		await openAdvanced(dialog);
		const network = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((candidate) =>
			candidate.closest("label")?.textContent?.includes("Allow exact network destinations"),
		)!;
		await act(async () => network.click());
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		expect(stub.update).not.toHaveBeenCalled();
		expect(dialog.textContent).toContain("Add an exact hostname and port");
		await act(async () => dialogButton(dialog, "Add destination")!.click());
		setValue(dialog.querySelector<HTMLInputElement>('input[aria-label="Hostname"]')!, "api.example.com");
		setValue(dialog.querySelector<HTMLInputElement>('input[aria-label="Port"]')!, "443");
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		const payload = payloadOf(stub.update.mock.calls[0]![0]).permissionRules;
		expect(payload[0]).toMatchObject({
			command: "curl",
			allowNetwork: true,
			networkTargets: [{ hostname: "api.example.com", port: 443 }],
		});
		await act(async () => root.unmount());
	});

	it("deletes immediately with an undo that keeps later changes and the original position", async () => {
		const stub = clientStub([
			makeRuleView({ id: "C04", name: "cat" }),
			makeRuleView({ id: "C22", name: "git status" }),
			makeRuleView({ id: "C01", name: "pwd" }),
		]);
		const { container, root } = await renderPanel(stub.client);
		expect(container.querySelector("dialog")).toBeNull();
		await act(async () => button(container, "Delete cat")!.click());
		await flush();
		expect(stub.update).toHaveBeenCalledTimes(1);
		expect(payloadOf(stub.update.mock.calls[0]![0]).permissionRules.map((rule) => rule.name)).toEqual([
			"git status",
			"pwd",
		]);
		expect(container.querySelector('.permission-rules-row[data-rule-id="C04"]')).toBeNull();
		expect(button(container, "Undo")).not.toBeNull();

		// A later save must survive the undo.
		await act(async () => button(container, "Add command")!.click());
		const dialog = container.querySelector("dialog")!;
		setValue(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, "git log");
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		await act(async () => button(container, "Undo")!.click());
		await flush();
		const restored = payloadOf(stub.update.mock.calls.at(-1)![0]).permissionRules;
		expect(restored.map((rule) => rule.name)).toEqual(["cat", "git status", "pwd", "git log"]);
		expect(restored[0]).toMatchObject({ id: "C04", command: "cat" });
		expect(restored.some((rule) => rule.id === "C04")).toBe(true);
		await act(async () => root.unmount());
	});

	it("keeps the row and reports a failed delete without offering undo", async () => {
		const stub = clientStub([makeRuleView({ id: "C04", name: "cat" })]);
		stub.update.mockRejectedValueOnce(new Error("DELETE_FAILED"));
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Delete cat")!.click());
		await flush();
		expect(container.textContent).toContain("cat");
		expect(container.textContent).toContain("DELETE_FAILED");
		expect(button(container, "Undo")).toBeNull();
		await act(async () => root.unmount());
	});

	it("restores only command defaults and leaves non-command defaults untouched", async () => {
		const pwd = makeRuleView({ id: "C01", name: "pwd" });
		const read = makeRuleView({ id: "T01", name: "Read file", kind: "tool", toolName: "read", command: undefined });
		const stub = clientStub(
			[makeRuleView({ id: "C04", name: "cat" }), makeRuleView({ id: "user-deploy", name: "deploy" })],
			[pwd, read],
		);
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Rule list actions")!.click());
		await flush();
		await act(async () => menuItem("Restore default rules")!.click());
		await flush();
		const dialog = container.querySelector("dialog")!;
		expect(dialog.textContent).toContain("pwd");
		expect(dialog.textContent).toContain("Missing");
		expect(dialog.textContent).not.toContain("Read file");
		await act(async () => dialogButton(dialog, "Restore selected")!.click());
		await flush();
		const payload = payloadOf(stub.update.mock.calls[0]![0]).permissionRules;
		expect(payload.map((rule) => rule.name).sort()).toEqual(["cat", "deploy", "pwd"]);
		expect(payload.some((rule) => rule.id === "T01")).toBe(false);
		await act(async () => root.unmount());
	});

	it("keeps an unsupported command visible with delete but no editor", async () => {
		const legacy = makeRuleView({
			id: "user-docker",
			name: "docker ps",
			support: "legacy-unsupported",
			supportReason: "Docker commands still need manual confirmation.",
		});
		const { container, root } = await renderPanel(clientStub([legacy]).client);
		expect(container.textContent).toContain("Not supported yet");
		expect(button(container, "Edit docker ps")?.disabled).toBe(true);
		expect(button(container, "Delete docker ps")?.disabled).toBe(false);
		await act(async () => button(container, "Delete docker ps")!.click());
		await flush();
		expect(container.querySelector('.permission-rules-row[data-rule-id="user-docker"]')).toBeNull();
		await act(async () => root.unmount());
	});

	it("shows a load error with retry instead of an empty rule list", async () => {
		const stub = clientStub([makeRuleView({ id: "C04", name: "cat" })]);
		stub.get.mockRejectedValueOnce(new Error("READ_FAILED"));
		const { container, root } = await renderPanel(stub.client);
		expect(container.textContent).toContain("READ_FAILED");
		expect(button(container, "Retry")).not.toBeNull();
		expect(container.querySelector(".permission-rules-card")).toBeNull();
		await act(async () => button(container, "Retry")!.click());
		await flush();
		expect(container.textContent).toContain("cat");
		await act(async () => root.unmount());
	});

	it("keeps the draft and dialog open when saving fails", async () => {
		const stub = clientStub([makeRuleView({ id: "C04", name: "cat" })]);
		stub.update.mockRejectedValueOnce(new Error("STORE_WRITE_FAILED"));
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Add command")!.click());
		const dialog = container.querySelector("dialog")!;
		setValue(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, "git log");
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		expect(container.querySelector("dialog")).not.toBeNull();
		expect(dialog.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("git log");
		expect(dialog.textContent).toContain("STORE_WRITE_FAILED");
		await act(async () => root.unmount());
	});

	it("ignores Escape while a save is in flight", async () => {
		const stub = clientStub([makeRuleView({ id: "C04", name: "cat" })]);
		let resolveSave: ((value: unknown) => void) | undefined;
		stub.update.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveSave = resolve;
				}),
		);
		const { container, root } = await renderPanel(stub.client);
		await act(async () => button(container, "Add command")!.click());
		const dialog = container.querySelector("dialog")!;
		setValue(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, "git log");
		await act(async () => dialogButton(dialog, "Save rule")!.click());
		await flush();
		await act(async () => {
			dialog.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
		});
		expect(container.querySelector("dialog")).not.toBeNull();
		await act(async () =>
			resolveSave?.(
				autoSettingsView([
					makeRuleView({ id: "C04", name: "cat" }),
					makeRuleView({ id: "user-new", name: "git log" }),
				]),
			),
		);
		await flush();
		expect(container.querySelector("dialog")).toBeNull();
		await act(async () => root.unmount());
	});
});
