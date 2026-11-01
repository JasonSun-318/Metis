// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxEnvironmentCard } from "../src/renderer/components/SandboxEnvironmentCard.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const checkedAt = "2026-10-29T08:00:00.000Z";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function readinessReport(overrides: Record<string, unknown> = {}) {
	return {
		status: "healthy",
		code: "ready",
		checkedAt,
		platform: "darwin",
		mode: "readiness",
		checks: [
			{ id: "platform", status: "passed" },
			{ id: "package", status: "skipped", reason: "not-applicable" },
			{ id: "dependencies", status: "passed" },
		],
		recoveryActions: [],
		...overrides,
	};
}

function apiStub(overrides: Record<string, unknown> = {}) {
	const api = {
		getPermissionSandboxHealth: vi.fn().mockResolvedValue(readinessReport()),
		runPermissionSandboxSelfTest: vi.fn(),
		installWorkspaceSandbox: vi.fn().mockResolvedValue("installed"),
		checkForUpdate: vi.fn(),
		startUpdate: vi.fn().mockResolvedValue(undefined),
		subscribeUpdate: vi.fn(() => () => {}),
		...overrides,
	};
	return api as unknown as MetisDesktopApi & typeof api;
}

function render(api: MetisDesktopApi, serverReady = true) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	return {
		container,
		root,
		async mount() {
			await act(async () => root.render(<SandboxEnvironmentCard api={api} serverReady={serverReady} />));
			await flush();
		},
	};
}

let mounted: { root: Root; container: HTMLElement }[] = [];
beforeEach(async () => {
	await setLocale("en");
});

afterEach(() => {
	for (const { root, container } of mounted) {
		act(() => root.unmount());
		container.remove();
	}
	mounted = [];
	vi.restoreAllMocks();
});

function mount(api: MetisDesktopApi) {
	const rendered = render(api);
	mounted.push(rendered);
	return rendered;
}

describe("SandboxEnvironmentCard", () => {
	it("keeps readiness compact without displaying passed or inapplicable checks", async () => {
		const api = apiStub();
		const { container, mount: start } = mount(api);
		await start();

		expect(container.textContent).toContain("Sandbox environment");
		expect(container.textContent).toContain("Not checked");
		expect(container.textContent).not.toContain("Available");
		expect(container.textContent).not.toContain("Last checked");
		expect(container.textContent).not.toContain("Platform: macOS");
		expect(container.textContent).not.toContain("This check does not apply on this platform.");
		expect(container.textContent).not.toContain("Not run yet.");
		expect(container.textContent).not.toContain("does not contact external websites");
		expect(button(container, "Run sandbox self-test")).not.toBeNull();
		expect(container.textContent).not.toContain("Full");
	});

	it("shows only the result after a real self-test, without expanding diagnostic content", async () => {
		let finish!: (value: unknown) => void;
		const api = apiStub({
			runPermissionSandboxSelfTest: vi.fn(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			),
		});
		const { container, mount: start } = mount(api);
		await start();
		await act(async () => button(container, "Run sandbox self-test")!.click());
		expect(container.querySelector("article")?.getAttribute("aria-busy")).toBe("true");
		expect(container.querySelector(".sandbox-environment-status")?.textContent).toBe("Checking…");
		expect(button(container, "Run sandbox self-test")!.disabled).toBe(true);
		await act(async () =>
			finish(
				readinessReport({
					mode: "self-test",
					checks: [
						{ id: "platform", status: "passed" },
						{ id: "package", status: "skipped", reason: "not-applicable" },
						{ id: "sandbox-startup", status: "passed" },
						{ id: "filesystem-permitted", status: "passed" },
						{ id: "filesystem-denied", status: "passed" },
						{ id: "network-denied", status: "passed" },
					],
				}),
			),
		);
		expect(container.querySelector(".sandbox-environment-status")?.textContent).toBe("Available");
		expect(container.querySelector("details, ul, .sandbox-environment-notice")).toBeNull();
		expect(container.querySelectorAll("button")).toHaveLength(1);
	});

	it("renders explicit self-test failures and skips as separate states with supported recovery", async () => {
		const api = apiStub({
			runPermissionSandboxSelfTest: vi.fn().mockResolvedValue({
				status: "misconfigured",
				code: "self-test-failed",
				checkedAt,
				platform: "darwin",
				mode: "self-test",
				checks: [
					{ id: "platform", status: "passed" },
					{ id: "package", status: "skipped", reason: "not-applicable" },
					{ id: "dependencies", status: "passed" },
					{ id: "sandbox-startup", status: "passed" },
					{ id: "filesystem-permitted", status: "passed" },
					{ id: "filesystem-denied", status: "failed", reason: "outside-read-not-denied" },
					{ id: "network-denied", status: "skipped", reason: "network-probe-unavailable" },
				],
				recoveryActions: ["check-app-update"],
			}),
		});
		const { container, mount: start } = mount(api);
		await start();

		await act(async () => button(container, "Run sandbox self-test")?.click());
		await flush();

		expect(api.runPermissionSandboxSelfTest).toHaveBeenCalledOnce();
		expect(container.textContent).toContain("Unavailable");
		expect(container.textContent).toContain("Reading outside the temporary workspace was not blocked.");
		expect(container.textContent).toContain("No local network probe was available.");
		expect(container.textContent).toContain("Check for app update");
		expect(container.textContent).not.toMatch(/\bFull\b/);
	});

	it("shows one startup failure and summarizes dependent checks that did not run", async () => {
		const api = apiStub({
			runPermissionSandboxSelfTest: vi.fn().mockResolvedValue(
				readinessReport({
					status: "misconfigured",
					code: "self-test-failed",
					platform: "win32",
					mode: "self-test",
					checks: [
						{ id: "sandbox-startup", status: "failed", reason: "sandbox-start-failed" },
						{ id: "filesystem-permitted", status: "skipped", reason: "sandbox-unavailable" },
						{ id: "filesystem-denied", status: "skipped", reason: "sandbox-unavailable" },
						{ id: "network-denied", status: "skipped", reason: "sandbox-unavailable" },
					],
					recoveryActions: ["install-windows-sandbox", "check-app-update"],
				}),
			),
		});
		const { container, mount: start } = mount(api);
		await start();
		await act(async () => button(container, "Run sandbox self-test")!.click());
		await flush();

		expect(container.querySelectorAll(".sandbox-environment-issue")).toHaveLength(1);
		expect(container.textContent).toContain("The sandbox could not start.");
		expect(container.querySelector(".sandbox-environment-notice")?.textContent).toBe(
			"Remaining checks were not run. Resolve the issue above and check again.",
		);
		expect(button(container, "Repair Windows sandbox")).not.toBeNull();
		expect(button(container, "Retry")).toBeNull();
	});

	it("does not claim the self-test passed when checks were skipped", async () => {
		const api = apiStub({
			runPermissionSandboxSelfTest: vi.fn().mockResolvedValue({
				status: "healthy",
				code: "self-test-incomplete",
				checkedAt,
				platform: "darwin",
				mode: "self-test",
				checks: [
					{ id: "platform", status: "passed" },
					{ id: "package", status: "skipped", reason: "not-applicable" },
					{ id: "dependencies", status: "passed" },
					{ id: "sandbox-startup", status: "passed" },
					{ id: "filesystem-permitted", status: "passed" },
					{ id: "filesystem-denied", status: "passed" },
					{ id: "network-denied", status: "skipped", reason: "network-probe-unavailable" },
				],
				recoveryActions: [],
			}),
		});
		const { container, mount: start } = mount(api);
		await start();

		await act(async () => button(container, "Run sandbox self-test")?.click());
		await flush();

		expect(container.textContent).toContain("Check incomplete");
		expect(container.textContent).toContain("No local network probe was available.");
		expect(container.textContent).not.toContain("Sandbox self-test passed.");
		expect(container.textContent).not.toMatch(/\bFull\b/);
	});

	it("shows an actionable error and retries the readiness check", async () => {
		const getPermissionSandboxHealth = vi
			.fn()
			.mockRejectedValueOnce(new Error("private failure"))
			.mockResolvedValueOnce(readinessReport());
		const api = apiStub({ getPermissionSandboxHealth });
		const { container, mount: start } = mount(api);
		await start();

		expect(container.textContent).toContain("The sandbox check could not be completed.");
		expect(container.textContent).not.toContain("private failure");

		await act(async () => button(container, "Retry")?.click());
		await flush();

		expect(getPermissionSandboxHealth).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Not checked");
	});

	it("uses the real Windows sandbox setup result and reloads readiness", async () => {
		const api = apiStub({
			getPermissionSandboxHealth: vi.fn().mockResolvedValue(
				readinessReport({
					status: "unavailable",
					code: "dependencies-unavailable",
					platform: "win32",
					checks: [
						{ id: "platform", status: "passed" },
						{ id: "package", status: "passed" },
						{ id: "dependencies", status: "failed", reason: "dependency-unavailable" },
					],
					recoveryActions: ["install-windows-sandbox", "check-app-update"],
				}),
			),
			installWorkspaceSandbox: vi.fn().mockResolvedValue("installed"),
		});
		const { container, mount: start } = mount(api);
		await start();

		await act(async () => button(container, "Repair Windows sandbox")?.click());
		await flush();

		expect(api.installWorkspaceSandbox).toHaveBeenCalledOnce();
		expect(api.getPermissionSandboxHealth).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Windows sandbox is ready.");
	});

	it("keeps the Windows repair action on a failed isolation check", async () => {
		const api = apiStub({
			runPermissionSandboxSelfTest: vi.fn().mockResolvedValue(
				readinessReport({
					platform: "win32",
					mode: "self-test",
					status: "misconfigured",
					code: "self-test-failed",
					checks: [{ id: "network-denied", status: "failed", reason: "network-not-denied" }],
					recoveryActions: ["install-windows-sandbox", "check-app-update"],
				}),
			),
		});
		const { container, mount: start } = mount(api);
		await start();
		await act(async () => button(container, "Run sandbox self-test")!.click());
		await act(async () => button(container, "Repair Windows sandbox")!.click());
		expect(api.installWorkspaceSandbox).toHaveBeenCalledOnce();
	});

	it("checks for a real app update and only then offers the download action", async () => {
		const api = apiStub({
			getPermissionSandboxHealth: vi.fn().mockResolvedValue(
				readinessReport({
					status: "misconfigured",
					code: "package-invalid",
					checks: [
						{ id: "platform", status: "passed" },
						{ id: "package", status: "failed", reason: "helper-invalid" },
						{ id: "dependencies", status: "skipped", reason: "readiness-failed" },
					],
					recoveryActions: ["check-app-update"],
				}),
			),
			checkForUpdate: vi.fn().mockResolvedValue({ status: "available", version: "9.9.9", releaseNotes: "Notes" }),
		});
		const { container, mount: start } = mount(api);
		await start();

		expect(button(container, "Download and open update")).toBeNull();
		await act(async () => button(container, "Check for app update")?.click());
		await flush();

		expect(container.textContent).toContain("Version 9.9.9 is available.");
		await act(async () => button(container, "Download and open update")?.click());
		await flush();

		expect(api.subscribeUpdate).toHaveBeenCalledOnce();
		expect(api.startUpdate).toHaveBeenCalledOnce();
		expect(container.textContent).toContain("The update installer was opened.");
	});
});
