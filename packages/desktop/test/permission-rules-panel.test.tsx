// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionRulesPanel } from "../src/renderer/components/PermissionRulesPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const SESSION_ID = "session-a";
const RULE = {
	id: "a".repeat(64),
	decision: "allow" as const,
	toolName: "bash",
	command: "npm test",
	paths: [],
	details: [
		{ label: "Command", value: "npm test" },
		{ label: "Working directory", value: "/work/project" },
	],
	omittedDetails: 2,
	risks: ["shell"],
	executionTarget: "sandbox" as const,
	createdAt: "2026-08-11T00:00:00.000Z",
};

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function api() {
	return {
		listPermissionRules: vi.fn().mockResolvedValue({ projectPath: "/work/project", rules: [RULE] }),
		deletePermissionRule: vi.fn().mockResolvedValue({ projectPath: "/work/project", rules: [] }),
		clearPermissionRules: vi.fn().mockResolvedValue({ projectPath: "/work/project", rules: [] }),
	} as unknown as MetisDesktopApi;
}

beforeEach(async () => {
	await setLocale("en");
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("PermissionRulesPanel", () => {
	it("loads the current project and revokes only the selected exact rule", async () => {
		const client = api();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<PermissionRulesPanel api={client} serverReady sessionId={SESSION_ID} />));
		await flush();

		expect(client.listPermissionRules).toHaveBeenCalledWith({ sessionId: SESSION_ID });
		expect(container.textContent).toContain("/work/project");
		expect(container.textContent).toContain("npm test");
		expect(container.textContent).toContain("Working directory");
		expect(container.textContent).toContain("Always allow");
		expect(container.textContent).toContain(RULE.id.slice(0, 12));
		expect(container.textContent).toContain("2 additional details omitted");
		await act(async () =>
			container.querySelector<HTMLButtonElement>('[aria-label="Remove bash permission"]')!.click(),
		);
		await flush();
		expect(client.deletePermissionRule).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: SESSION_ID,
				ruleId: RULE.id,
			}),
		);
		expect(container.textContent).toContain("No remembered permission decisions for this project.");
		await act(async () => root.unmount());
	});

	it("preserves visible rules on failure and clears them only after confirmation", async () => {
		const client = api();
		vi.mocked(client.deletePermissionRule).mockRejectedValueOnce(new Error("remove failed"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<PermissionRulesPanel api={client} serverReady sessionId={SESSION_ID} />));
		await flush();

		await act(async () =>
			container.querySelector<HTMLButtonElement>('[aria-label="Remove bash permission"]')!.click(),
		);
		await flush();
		expect(container.textContent).toContain("remove failed");
		expect(container.textContent).toContain("npm test");
		const clearButtons = () =>
			[...container.querySelectorAll<HTMLButtonElement>("button")].filter(
				(button) => button.textContent === "Clear all",
			);
		await act(async () => clearButtons()[0]!.click());
		expect(container.querySelector('[aria-labelledby="clear-permissions-title"]')).not.toBeNull();
		await act(async () => clearButtons().at(-1)!.click());
		await flush();
		expect(client.clearPermissionRules).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID }));
		expect(container.textContent).toContain("No remembered permission decisions for this project.");
		await act(async () => root.unmount());
	});

	it("lists exact rule details including an external target", async () => {
		const client = api();
		vi.mocked(client.listPermissionRules).mockResolvedValueOnce({
			projectPath: "/work/project",
			rules: [
				{
					...RULE,
					executionTarget: "external",
					details: [
						{ label: "Address", value: "https://example.test" },
						{ label: "Details", value: "[REDACTED]" },
					],
				},
			],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<PermissionRulesPanel api={client} serverReady sessionId={SESSION_ID} />));
		await flush();
		expect(container.textContent).toContain("External");
		expect(container.textContent).toContain("https://example.test");
		expect(container.textContent).toContain("[REDACTED]");
		expect(container.textContent).not.toContain("sk-");
		await act(async () => root.unmount());
	});

	it("distinguishes an exact remembered deny from an allow", async () => {
		const client = api();
		vi.mocked(client.listPermissionRules).mockResolvedValueOnce({
			projectPath: "/work/project",
			rules: [{ ...RULE, decision: "deny" }],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<PermissionRulesPanel api={client} serverReady sessionId={SESSION_ID} />));
		await flush();

		expect(container.textContent).toContain("Always deny");
		expect(container.textContent).not.toContain("Always allow");
		await act(async () => root.unmount());
	});

	it("does not call the server without an active project session", async () => {
		const client = api();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<PermissionRulesPanel api={client} serverReady sessionId={null} />));
		expect(container.textContent).toContain("Open a project to manage its remembered permission decisions.");
		expect(client.listPermissionRules).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});
});
