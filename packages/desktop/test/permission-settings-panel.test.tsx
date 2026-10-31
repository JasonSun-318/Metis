// @vitest-environment jsdom

import type { ClientResult } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionSettingsPanel } from "../src/renderer/components/PermissionSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { makeRememberedRule, rememberedCatalog } from "./fixtures/permission-rules.ts";

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

function checkbox(container: ParentNode, label: string): HTMLInputElement | null {
	return (
		[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
			(candidate) => candidate.getAttribute("aria-label") === label,
		) ?? null
	);
}

async function selectMenu(container: ParentNode, name: string, label: string) {
	await act(async () => button(container, name)!.click());
	const option = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) =>
		item.textContent?.startsWith(label),
	);
	expect(option).toBeDefined();
	await act(async () => option!.click());
}

function reviewerSettings(permissionReviewer: {
	config: Record<string, unknown> | null;
	status: "unconfigured" | "configured" | "invalid";
	authConfigured?: boolean;
}) {
	return {
		defaultModel: null,
		vision: null,
		defaultThinkingSelection: "medium",
		permissionReviewer,
		providers: [
			{
				provider: "review-provider",
				name: "Review Provider",
				builtin: false,
				baseUrl: null,
				api: null,
				auth: { configured: true, source: "stored", label: "••••abcd" },
				models: [
					{
						provider: "review-provider",
						modelId: "review-model",
						name: "Review Model",
						contextWindow: 200_000,
						maxOutputTokens: 8_192,
						imageInput: false,
						thinkingLevels: ["off"],
					},
				],
			},
		],
		loadError: null,
	};
}

const configuredReviewer = {
	config: {
		provider: "review-provider",
		modelId: "review-model",
		thinkingLevel: "off",
		timeoutMs: 8000,
		maxOutputTokens: 512,
	},
	status: "configured" as const,
};

const alphaProjectRule = makeRememberedRule({
	id: "alpha-allow",
	decision: "allow",
	command: "git status",
	paths: ["/projects/alpha/src"],
	details: [{ label: "Execution target", value: "sandbox" }],
});
const alphaProjectDeny = makeRememberedRule({ id: "alpha-deny", decision: "deny", command: "rm" });
const alphaSessionRule = makeRememberedRule({ id: "alpha-session", decision: "allow", command: "npm test" });
const betaRule = makeRememberedRule({ id: "beta-deny", decision: "deny", command: "curl" });

function catalogWithGrants() {
	return rememberedCatalog([
		{
			scope: "project",
			projectPath: "/projects/alpha",
			projectName: "Alpha",
			rules: [alphaProjectRule, alphaProjectDeny],
		},
		{
			scope: "session",
			projectPath: "/projects/alpha",
			projectName: "Alpha",
			sessionId: "session-1",
			sessionTitle: "Release audit",
			rules: [alphaSessionRule],
		},
		{
			scope: "project",
			projectPath: "/projects/beta",
			projectName: "Beta",
			rules: [betaRule],
		},
	]);
}

interface PanelOverrides {
	getPermissionAutoSettings?: () => Promise<unknown>;
	updatePermissionAutoSettings?: (input: Record<string, unknown>) => Promise<unknown>;
	getModelSettings?: () => Promise<unknown>;
	listRememberedPermissionRules?: () => Promise<ClientResult<"permission/rules/catalog">>;
	revokeRememberedPermissionRule?: (input: Record<string, unknown>) => Promise<{ deleted: true }>;
}

function clientStub(overrides: PanelOverrides = {}): MetisDesktopApi {
	return {
		getPermissionAutoSettings:
			overrides.getPermissionAutoSettings ??
			vi.fn().mockResolvedValue({ reviewerEnabled: false, rules: [], suggestions: [] }),
		updatePermissionAutoSettings:
			overrides.updatePermissionAutoSettings ??
			vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
				reviewerEnabled: input.reviewerEnabled ?? false,
				rules: [],
				suggestions: [],
				permissionRules: [],
				permissionRuleDefaults: [],
			})),
		getModelSettings:
			overrides.getModelSettings ??
			vi.fn().mockResolvedValue(reviewerSettings({ config: null, status: "unconfigured" })),
		listRememberedPermissionRules:
			overrides.listRememberedPermissionRules ?? vi.fn().mockResolvedValue(rememberedCatalog([])),
		revokeRememberedPermissionRule:
			overrides.revokeRememberedPermissionRule ?? vi.fn().mockResolvedValue({ deleted: true }),
		getPermissionSandboxHealth: vi.fn().mockResolvedValue({ status: "healthy", code: "ready", mode: "readiness" }),
		setPermissionPreset: vi.fn(),
	} as unknown as MetisDesktopApi;
}

interface PanelProps {
	readonly focusRuleId?: string;
	readonly focusRuleScope?: string;
	readonly onOpenBrowserSettings?: () => void;
	readonly permissionPreset?: "ask" | "auto" | "full";
	readonly sessionId?: string;
}

async function renderPanel(api: MetisDesktopApi, props: PanelProps = {}) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<PermissionSettingsPanel
				api={api}
				focusRuleId={props.focusRuleId}
				focusRuleScope={props.focusRuleScope}
				onOpenBrowserSettings={props.onOpenBrowserSettings}
				permissionPreset={props.permissionPreset}
				serverReady
				sessionId={props.sessionId}
			/>,
		),
	);
	await flush();
	return { container, root };
}

async function openManager(container: ParentNode) {
	await act(async () => button(container, "Manage remembered permissions")!.click());
	await flush();
	return container.querySelector<HTMLDialogElement>('dialog[aria-label="Remembered permissions"]')!;
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

describe("PermissionSettingsPanel", () => {
	it("starts with the allowed commands heading and has no conversation context card", async () => {
		const listRememberedPermissionRules = vi.fn().mockResolvedValue(rememberedCatalog([]));
		const api = clientStub({ listRememberedPermissionRules });
		const { container, root } = await renderPanel(api);
		const page = container.querySelector(".permission-settings-page")!;
		expect(page.firstElementChild?.querySelector("h3")?.textContent).toBe("Allowed commands");
		expect(container.querySelector(".permission-settings-caption")).toBeNull();
		expect(container.textContent).not.toContain("Current context");
		expect(container.textContent).not.toContain("No current project");
		expect(container.querySelector(".permission-context-card")).toBeNull();
		expect(container.textContent).toContain("Allowed commands");
		expect(container.textContent).toContain("Auto model approvals");
		expect(container.textContent).toContain("No approval model configured");
		expect(container.textContent).toContain("Remembered permissions");
		expect(container.textContent).toContain("Remembered: 0");
		expect(container.querySelector(".permission-execution-environment")).not.toBeNull();
		expect(listRememberedPermissionRules).toHaveBeenCalledTimes(1);
		expect(container.textContent).not.toContain("Open a conversation");
		await act(async () => root.unmount());
	});

	it("keeps the global page independent of the conversation preset and session", async () => {
		const { container, root } = await renderPanel(clientStub(), {
			permissionPreset: "full",
			sessionId: "session-1",
		});
		expect(container.querySelector(".permission-settings-caption")).toBeNull();
		expect(container.textContent).not.toContain("This conversation is in Full mode.");
		expect(container.querySelector(".permission-context-card")).toBeNull();
		await act(async () => root.unmount());
	});

	it("shows an uncluttered empty manager without unused filters", async () => {
		const { container, root } = await renderPanel(clientStub());
		const dialog = await openManager(container);
		expect(dialog.textContent).toContain("No remembered permissions yet.");
		expect(dialog.querySelector(".remembered-permissions-toolbar, select, footer")).toBeNull();
		await act(async () => root.unmount());
	});

	it("summarizes global grants and opens the all-projects manager", async () => {
		const api = clientStub({ listRememberedPermissionRules: vi.fn().mockResolvedValue(catalogWithGrants()) });
		const { container, root } = await renderPanel(api);
		expect(container.textContent).toContain("Remembered: 4");
		expect(container.textContent).not.toContain("Allow: 2");
		expect(container.textContent).not.toContain("Deny: 2");
		expect(container.textContent).not.toContain("Projects: 2");
		expect(container.textContent).not.toContain("Live sessions: 1");
		const dialog = await openManager(container);
		expect(dialog).not.toBeNull();
		expect(button(dialog, "Project")?.textContent).toContain("All projects");
		expect(dialog.querySelector("select")).toBeNull();
		await act(async () => button(dialog, "Project")!.click());
		expect(
			[...dialog.querySelectorAll('[role="option"] .menu-select-option-copy > span')].map(
				(item) => item.textContent,
			),
		).toEqual(["Alpha", "Beta"]);
		await act(async () => button(dialog, "Project")!.click());
		expect(dialog.querySelectorAll(".remembered-rule-row")).toHaveLength(4);
		expect(dialog.textContent).toContain("Release audit");
		const details = dialog.querySelector<HTMLDetailsElement>(".remembered-rule-details")!;
		expect(details.open).toBe(false);
		expect(details.textContent).toContain("/projects/alpha/src");
		await act(async () => details.querySelector("summary")!.click());
		expect(details.open).toBe(true);
		await act(async () => root.unmount());
	});

	it("filters the manager by project, scope, decision, and command search", async () => {
		const api = clientStub({ listRememberedPermissionRules: vi.fn().mockResolvedValue(catalogWithGrants()) });
		const { container, root } = await renderPanel(api);
		const dialog = await openManager(container);

		await selectMenu(dialog, "Project", "Alpha");
		await flush();
		expect(dialog.querySelectorAll(".remembered-rule-row")).toHaveLength(3);
		expect(dialog.textContent).not.toContain("curl");

		await selectMenu(dialog, "Scope", "Session");
		await flush();
		expect(dialog.querySelectorAll(".remembered-rule-row")).toHaveLength(1);
		expect(dialog.textContent).toContain("npm test");
		expect(dialog.textContent).not.toContain("git status");

		await selectMenu(dialog, "Decision", "Deny");
		await flush();
		expect(dialog.textContent).toContain("No permissions match these filters.");

		await selectMenu(dialog, "Scope", "All scopes");
		await flush();
		expect(dialog.querySelectorAll(".remembered-rule-row")).toHaveLength(1);
		expect(dialog.textContent).toContain("rm");

		await selectMenu(dialog, "Decision", "All decisions");
		await selectMenu(dialog, "Project", "All projects");
		await flush();
		const search = dialog.querySelector<HTMLInputElement>('input[aria-label="Search remembered permissions"]')!;
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "curl");
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();
		expect(dialog.querySelectorAll(".remembered-rule-row")).toHaveLength(1);
		expect(dialog.textContent).toContain("curl");
		expect(dialog.textContent).not.toContain("git status");
		await act(async () => root.unmount());
	});

	it("revokes the original project and session owners without crossing scope", async () => {
		const revokeRememberedPermissionRule = vi.fn().mockResolvedValue({ deleted: true });
		const api = clientStub({
			listRememberedPermissionRules: vi.fn().mockResolvedValue(catalogWithGrants()),
			revokeRememberedPermissionRule,
		});
		const { container, root } = await renderPanel(api);
		const dialog = await openManager(container);

		await act(async () => button(dialog, "Revoke git status")!.click());
		await flush();
		expect(revokeRememberedPermissionRule).toHaveBeenCalledWith({
			requestId: expect.any(String),
			scope: "project",
			projectPath: "/projects/alpha",
			ruleId: "alpha-allow",
		});
		expect(dialog.textContent).not.toContain("git status");
		expect(dialog.textContent).toContain("Remembered: 3");

		await act(async () => button(dialog, "Revoke npm test")!.click());
		await flush();
		expect(revokeRememberedPermissionRule).toHaveBeenLastCalledWith({
			requestId: expect.any(String),
			scope: "session",
			sessionId: "session-1",
			ruleId: "alpha-session",
		});
		expect(dialog.textContent).not.toContain("npm test");
		expect(dialog.textContent).toContain("Remembered: 2");
		await act(async () => root.unmount());
	});

	it("opens the owning group for a remembered audit link", async () => {
		const api = clientStub({ listRememberedPermissionRules: vi.fn().mockResolvedValue(catalogWithGrants()) });
		const { container, root } = await renderPanel(api, {
			focusRuleId: "alpha-session",
			focusRuleScope: "session",
		});
		const dialog = container.querySelector<HTMLDialogElement>('dialog[aria-label="Remembered permissions"]')!;
		expect(dialog).not.toBeNull();
		expect(button(dialog, "Project")?.textContent).toContain("Alpha");
		expect(button(dialog, "Scope")?.textContent).toContain("Session");
		expect(dialog.querySelectorAll(".remembered-rule-row")).toHaveLength(1);
		expect(dialog.textContent).toContain("npm test");
		expect(dialog.textContent).not.toContain("git status");
		expect(
			dialog.querySelector('.remembered-rule-row[data-remembered-rule-id="alpha-session"]')?.className,
		).toContain("is-focused");
		await act(async () => root.unmount());
	});

	it("shows a remembered-grant load error with retry instead of an empty summary", async () => {
		const listRememberedPermissionRules = vi
			.fn()
			.mockRejectedValueOnce(new Error("CATALOG_FAILED"))
			.mockResolvedValue(rememberedCatalog([]));
		const api = clientStub({ listRememberedPermissionRules });
		const { container, root } = await renderPanel(api);
		expect(container.textContent).toContain("CATALOG_FAILED");
		expect(container.textContent).not.toContain("Remembered: 0");
		expect(button(container, "Retry")).not.toBeNull();
		await act(async () => button(container.querySelector(".permission-remembered")!, "Retry")!.click());
		await flush();
		expect(container.textContent).toContain("Remembered: 0");
		await act(async () => root.unmount());
	});

	it("patches only the reviewer switch and never the rules or the session mode", async () => {
		const api = clientStub({
			getPermissionAutoSettings: vi.fn().mockResolvedValue({
				reviewerEnabled: true,
				rules: [{ command: "ls", allowNetwork: false }],
				suggestions: [],
			}),
		});
		const { container, root } = await renderPanel(api);
		const toggle = checkbox(container, "Use the approval model in Auto mode");
		expect(toggle?.checked).toBe(true);
		await act(async () => toggle!.click());
		await flush();
		expect(api.updatePermissionAutoSettings).toHaveBeenCalledTimes(1);
		expect(api.updatePermissionAutoSettings).toHaveBeenCalledWith({
			requestId: expect.any(String),
			reviewerEnabled: false,
		});
		const payload = (api.updatePermissionAutoSettings as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(payload).not.toHaveProperty("rules");
		expect(payload).not.toHaveProperty("permissionRules");
		expect(api.setPermissionPreset).not.toHaveBeenCalled();
		expect(checkbox(container, "Use the approval model in Auto mode")?.checked).toBe(false);
		await act(async () => root.unmount());
	});

	it("opens the same approval model dialog from the compact reviewer card", async () => {
		const api = clientStub({ getModelSettings: vi.fn().mockResolvedValue(reviewerSettings(configuredReviewer)) });
		const { container, root } = await renderPanel(api);
		expect(container.textContent).toContain("Review Model");
		const configure = button(container, "Edit approval model");
		expect(configure).not.toBeNull();
		await act(async () => configure!.click());
		await flush();
		const dialog = container.querySelector("dialog")!;
		expect(dialog).not.toBeNull();
		expect(dialog.getAttribute("aria-label")).toBe("Approval model");
		expect(dialog.textContent).toContain("Save approval model");
		expect(dialog.textContent).toContain("Review Provider");
		const cancel = [...dialog.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === "Cancel",
		)!;
		await act(async () => cancel.click());
		expect(container.querySelector("dialog")).toBeNull();
		await act(async () => root.unmount());
	});

	it("summarizes a dedicated approval connection without exposing its key", async () => {
		const api = clientStub({
			getModelSettings: vi.fn().mockResolvedValue(
				reviewerSettings({
					config: {
						source: "dedicated",
						name: "Independent reviewer",
						api: "openai-completions",
						baseUrl: "https://reviewer.example.invalid/v1",
						modelId: "review-model",
						thinkingLevel: "off",
						timeoutMs: 8000,
						maxOutputTokens: 512,
						reasoningMode: "off",
					},
					status: "configured",
					authConfigured: true,
				}),
			),
		});
		const { container, root } = await renderPanel(api);
		expect(container.textContent).toContain("Independent reviewer");
		expect(container.textContent).toContain("review-model");
		expect(container.textContent).not.toContain("reviewer-key");
		expect(container.querySelector(".permission-approval-summary.ok")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("flags a dedicated approval connection whose saved key is missing", async () => {
		const api = clientStub({
			getModelSettings: vi.fn().mockResolvedValue(
				reviewerSettings({
					config: {
						source: "dedicated",
						name: "Independent reviewer",
						api: "openai-completions",
						baseUrl: "https://reviewer.example.invalid/v1",
						modelId: "review-model",
						thinkingLevel: "off",
						timeoutMs: 8000,
						maxOutputTokens: 512,
						reasoningMode: "off",
					},
					status: "configured",
					authConfigured: false,
				}),
			),
		});
		const { container, root } = await renderPanel(api);
		expect(container.textContent).toContain("missing its API key");
		expect(container.querySelector(".permission-approval-summary.invalid")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("shows the invalid approval model state without reviving the configuration", async () => {
		const api = clientStub({
			getModelSettings: vi.fn().mockResolvedValue(reviewerSettings({ config: null, status: "invalid" })),
		});
		const { container, root } = await renderPanel(api);
		expect(container.textContent).toContain(
			"The saved approval model configuration is invalid. Choose a supported provider, model, and reasoning level.",
		);
		await act(async () => root.unmount());
	});

	it("disables the approval model dialog and offers a retry when model settings fail", async () => {
		const getModelSettings = vi
			.fn()
			.mockRejectedValueOnce(new Error("MODEL_FAILED"))
			.mockResolvedValue(reviewerSettings({ config: null, status: "unconfigured" }));
		const api = clientStub({ getModelSettings });
		const { container, root } = await renderPanel(api);
		expect(container.textContent).toContain("MODEL_FAILED");
		expect(button(container, "Configure approval model")?.disabled).toBe(true);
		await act(async () => button(container.querySelector(".permission-auto-approval")!, "Retry")!.click());
		await flush();
		expect(container.textContent).toContain("No approval model configured");
		expect(button(container, "Configure approval model")?.disabled).toBe(false);
		await act(async () => root.unmount());
	});

	it("keeps the browser settings entry in the environment section", async () => {
		const onOpenBrowserSettings = vi.fn();
		const api = clientStub();
		const { container, root } = await renderPanel(api, { onOpenBrowserSettings });
		const environment = container.querySelector(".permission-execution-environment")!;
		const browserLink = environment.querySelector(".permission-browser-link")!;
		expect(browserLink.textContent).toContain("Browser actions are managed by the browser confirmation flow.");
		expect(environment.querySelector(".settings-card.permission-browser-card")).toBeNull();
		await act(async () => button(container, "Manage browser settings")!.click());
		expect(onOpenBrowserSettings).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("ignores a remembered focus that no longer exists", async () => {
		const api = clientStub({ listRememberedPermissionRules: vi.fn().mockResolvedValue(catalogWithGrants()) });
		const { container, root } = await renderPanel(api, { focusRuleId: "deleted-rule", focusRuleScope: "project" });
		expect(container.querySelector('dialog[aria-label="Remembered permissions"]')).toBeNull();
		await act(async () => root.unmount());
	});
});
