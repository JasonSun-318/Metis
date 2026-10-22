// @vitest-environment jsdom

import type { DeclarativeHookView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HookDraft, HookEditorDialog } from "../src/renderer/components/HookEditorDialog.tsx";
import { PluginsPanel } from "../src/renderer/components/PluginsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function setInputValue(input: HTMLInputElement, value: string) {
	const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	nativeSetter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

function button(root: ParentNode, label: string) {
	return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent?.trim() === label,
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

describe("HookEditorDialog and PluginsPanel", () => {
	let container: HTMLDivElement;

	beforeEach(async () => {
		await setLocale("en");
		container = document.createElement("div");
		document.body.append(container);
	});

	afterEach(() => {
		container.remove();
	});

	it("defaults protocol to command-v1 in create mode", async () => {
		let submitted: HookDraft | undefined;
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<HookEditorDialog
					error={null}
					mode="create"
					onCancel={() => {}}
					onSubmit={(draft) => {
						submitted = draft;
					}}
					pending={false}
				/>,
			);
		});
		await flush();

		expect(container.textContent).toContain("When to run");
		expect(container.textContent).toContain("What to run");
		expect(container.querySelector('[aria-label="Protocol"]')).toBeNull();

		// Fill required fields
		const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="For example, check tool calls"]');
		const commandInput = container.querySelector<HTMLInputElement>('input[placeholder="node"]');
		expect(nameInput).not.toBeNull();
		expect(commandInput).not.toBeNull();

		await act(async () => {
			setInputValue(nameInput!, "my-command-hook");
			setInputValue(commandInput!, "node script.js");
		});
		await flush();

		// Switching to an event without a matcher must not leave a hidden rule blocking save.
		await act(async () => {
			setInputValue(container.querySelector<HTMLInputElement>('input[placeholder="bash|read|write"]')!, "bash");
			container.querySelector<HTMLButtonElement>('button[aria-label="Event"]')!.click();
		});
		await flush();
		await act(async () => {
			Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
				.find((option) => option.textContent === "User prompt submit")!
				.click();
		});
		await flush();
		expect(container.querySelector('input[placeholder="bash|read|write"]')).toBeNull();

		// Submit form
		const form = container.querySelector("form")!;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(submitted).toBeDefined();
		expect(submitted!.protocol).toBe("command-v1");
		expect(submitted!.name).toBe("my-command-hook");
		expect(submitted!.event).toBe("UserPromptSubmit");
		expect(submitted!.matcher).toBe("");
	});

	it("defaults protocol to legacy in edit mode when protocol is omitted", async () => {
		let submitted: HookDraft | undefined;
		const initial: DeclarativeHookView = {
			id: "hook-old",
			name: "old-hook",
			enabled: true,
			event: "PreToolUse",
			runMode: "process",
			command: "python lint.py",
		};

		const root = createRoot(container);
		await act(async () => {
			root.render(
				<HookEditorDialog
					error={null}
					initial={initial}
					mode="edit"
					onCancel={() => {}}
					onSubmit={(draft) => {
						submitted = draft;
					}}
					pending={false}
				/>,
			);
		});
		await flush();

		const form = container.querySelector("form")!;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(submitted).toBeDefined();
		expect(submitted!.protocol).toBe("legacy");
	});

	it("shows in-place validation error for invalid regex matcher in command-v1", async () => {
		let submitted = false;
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<HookEditorDialog
					error={null}
					mode="create"
					onCancel={() => {}}
					onSubmit={() => {
						submitted = true;
					}}
					pending={false}
				/>,
			);
		});
		await flush();

		const nameInput = container.querySelector<HTMLInputElement>(
			'input[placeholder="For example, check tool calls"]',
		)!;
		const commandInput = container.querySelector<HTMLInputElement>('input[placeholder="node"]')!;
		const matcherInput = container.querySelector<HTMLInputElement>('input[placeholder="bash|read|write"]')!;

		await act(async () => {
			setInputValue(nameInput, "regex-hook");
			setInputValue(commandInput, "echo test");
			// Invalid regex (unmatched bracket)
			setInputValue(matcherInput, "[a-z");
		});
		await flush();

		// In-place regex error should be visible
		expect(container.textContent).toContain("Invalid regular expression.");

		// Try to submit: should be blocked
		const form = container.querySelector("form")!;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(submitted).toBe(false);
	});

	it("renders hook detail in PluginsPanel with protocol, default 60s timeout, and timing", async () => {
		const hook: DeclarativeHookView = {
			id: "hook-detail-1",
			name: "detail-test-hook",
			enabled: true,
			event: "SessionStart",
			protocol: "command-v1",
			runMode: "shell",
			command: "echo startup",
			statusMessage: "Preparing environment",
		};

		const apiStub = {
			listHooks: vi.fn().mockResolvedValue({ hooks: [hook], loadErrors: [] }),
			listSkills: vi.fn().mockResolvedValue({ skills: [] }),
			listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
			getPermissionAutoSettings: vi.fn().mockResolvedValue({ rules: [], suggestions: [] }),
			selectProjectFolder: vi.fn(),
		} as unknown as MetisDesktopApi;

		const root = createRoot(container);
		await act(async () => {
			root.render(
				<PluginsPanel
					api={apiStub}
					initialSection="hooks"
					onSkillsChanged={() => {}}
					preferences={new Map()}
					serverReady={true}
					state={{ activeSessionId: null, sessionsById: new Map() } as any}
				/>,
			);
		});
		await flush();

		// Click the hook row to open details
		const row = container.querySelector<HTMLButtonElement>(".plugins-list-row");
		expect(row).not.toBeNull();
		await act(async () => {
			row!.click();
		});
		await flush();

		// Verify detail page elements
		expect(container.textContent).toContain("detail-test-hook");
		expect(container.textContent).toContain("command-v1");
		expect(container.textContent).toContain("Default (60s)");
		expect(container.textContent).not.toContain("Default (30s)");
		expect(container.textContent).toContain("Event effect");
		expect(container.textContent).toContain("Execution timing");
		expect(container.textContent).toContain("Injects startup context into the first model prompt.");
		expect(container.textContent).toContain("Runs once when the session is initialized or reloaded.");
	});

	it("preserves protocol, args, timeout, and metadata round-trip through HookEditorDialog", async () => {
		let submitted: HookDraft | undefined;
		const initial: DeclarativeHookView = {
			id: "hook-full-spec",
			name: "full-spec-hook",
			enabled: true,
			event: "PostToolUse",
			protocol: "command-v1",
			matcher: "bash|write",
			runMode: "process",
			command: "/usr/bin/python3",
			args: ["--analyze", "--level=2"],
			timeoutSeconds: 120,
			statusMessage: "Analyzing output...",
			metadata: { env: "staging", priority: 1 },
		};

		const root = createRoot(container);
		await act(async () => {
			root.render(
				<HookEditorDialog
					error={null}
					initial={initial}
					mode="edit"
					onCancel={() => {}}
					onSubmit={(draft) => {
						submitted = draft;
					}}
					pending={false}
				/>,
			);
		});
		await flush();

		const form = container.querySelector("form")!;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(submitted).toBeDefined();
		expect(submitted!.id).toBe("hook-full-spec");
		expect(submitted!.name).toBe("full-spec-hook");
		expect(submitted!.protocol).toBe("command-v1");
		expect(submitted!.event).toBe("PostToolUse");
		expect(submitted!.matcher).toBe("bash|write");
		expect(submitted!.runMode).toBe("process");
		expect(submitted!.command).toBe("/usr/bin/python3");
		expect(submitted!.args).toBe("--analyze\n--level=2");
		expect(submitted!.timeout).toBe("120");
		expect(submitted!.statusMessage).toBe("Analyzing output...");
		expect(JSON.parse(submitted!.metadataJson)).toEqual({ env: "staging", priority: 1 });
	});

	it("coalesces repeated hook toggles, disables detail actions, and keeps the prior state on failure", async () => {
		const hook: DeclarativeHookView = {
			id: "hook-toggle-race",
			name: "toggle-race-hook",
			enabled: true,
			event: "PreToolUse",
			protocol: "command-v1",
			runMode: "shell",
			command: "echo check",
		};
		const first = deferred<{ hooks: DeclarativeHookView[] }>();
		const second = deferred<{ hooks: DeclarativeHookView[] }>();
		const upsertHook = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const apiStub = {
			listHooks: vi.fn().mockResolvedValue({ hooks: [hook], loadErrors: [] }),
			listSkills: vi.fn().mockResolvedValue({ skills: [] }),
			listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
			getPermissionAutoSettings: vi.fn().mockResolvedValue({ rules: [], suggestions: [] }),
			upsertHook,
		} as unknown as MetisDesktopApi;

		const root = createRoot(container);
		await act(async () => {
			root.render(
				<PluginsPanel
					api={apiStub}
					initialSection="hooks"
					onSkillsChanged={() => {}}
					preferences={new Map()}
					serverReady={true}
					state={{ activeSessionId: null, sessionsById: new Map() } as any}
				/>,
			);
		});
		await flush();

		await act(async () => container.querySelector<HTMLButtonElement>(".plugins-list-row")!.click());
		await flush();

		const toggleButton = button(container, "Disable");
		expect(toggleButton).not.toBeUndefined();
		await act(async () => {
			toggleButton!.click();
			toggleButton!.click();
		});

		expect(upsertHook).toHaveBeenCalledTimes(1);
		expect(upsertHook).toHaveBeenCalledWith({
			hook: expect.objectContaining({ id: "hook-toggle-race", enabled: false }),
		});
		expect(toggleButton!.disabled).toBe(true);
		expect(button(container, "Edit")!.disabled).toBe(true);
		expect(button(container, "Delete")!.disabled).toBe(true);
		expect(container.querySelector('[data-plugin-detail="hook"]')?.getAttribute("aria-busy")).toBe("true");
		expect(container.textContent).toContain("Updating…");
		expect(container.textContent).toContain("Enabled");

		await act(async () => {
			first.reject(new Error("Could not update the hook."));
		});
		await flush();

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not update the hook.");
		expect(button(container, "Disable")!.disabled).toBe(false);
		expect(button(container, "Edit")!.disabled).toBe(false);
		expect(button(container, "Delete")!.disabled).toBe(false);
		expect(container.querySelector('[data-plugin-detail="hook"]')?.textContent).toContain("Enabled");

		await act(async () => button(container, "Back to Hooks")!.click());
		await flush();
		expect(container.querySelector(".plugins-detail-error")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".plugins-list-row")!.click());
		await flush();
		expect(container.querySelector(".plugins-detail-error")).toBeNull();

		const retryButton = button(container, "Disable")!;
		await act(async () => retryButton.click());
		expect(upsertHook).toHaveBeenCalledTimes(2);
		expect(retryButton.disabled).toBe(true);

		await act(async () => {
			second.resolve({ hooks: [{ ...hook, enabled: false }] });
		});
		await flush();

		expect(button(container, "Enable")?.disabled).toBe(false);
		expect(container.querySelector('[data-plugin-detail="hook"]')?.textContent).toContain("Disabled");
		expect(container.querySelector(".plugins-detail-error")).toBeNull();
	});
});
