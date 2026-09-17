// @vitest-environment jsdom

import type {
	MemoryChangelogEntryView,
	MemoryNoteSummaryView,
	MemoryNoteView,
	MemorySettingsView,
	ModelSettingsView,
} from "@metis/app-protocol";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
	PatchDiff: ({ patch }: { readonly patch: string }) => <pre data-testid="patch">{patch}</pre>,
	WorkerPoolContextProvider: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import { MemorySettingsPanel } from "../src/renderer/components/MemorySettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(name));
	if (!match) throw new Error(`Missing button: ${name}`);
	return match as HTMLButtonElement;
}

async function fillNumber(container: HTMLElement, label: string, value: string) {
	const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
	expect(input).not.toBeNull();
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function selectOption(container: HTMLElement, label: string, value: string) {
	const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
	expect(select).not.toBeNull();
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

function toggle(container: HTMLElement, label: string): HTMLInputElement {
	const match = [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find(
		(item) => item.getAttribute("aria-label") === label,
	);
	if (!match) throw new Error(`Missing toggle: ${label}`);
	return match;
}

const UUID = "11111111-2222-4333-8444-555566667777";

const memorySettings: MemorySettingsView = {
	enabled: true,
	dream: { enabled: false, minHours: 24, minSessions: 5, maxUnusedDays: 90, nextEligible: false },
	activeContext: true,
	vault: { globalDir: "/tmp/agent/memory/global" },
};

const historyEntry: MemoryChangelogEntryView = {
	id: UUID,
	ts: "2026-09-16T10:00:00.000Z",
	actor: { kind: "agent", sessionId: "99999999-8888-4777-8666-555544443333" },
	op: "create",
	scope: "global",
	target: { slug: "prefers-concise-replies" },
};

const noteSummary: MemoryNoteSummaryView = {
	scope: "global",
	slug: "prefers-concise-replies",
	type: "user",
	name: "Prefers concise replies",
	description: "Keep answers short",
	updated: "2026-09-16",
};

const noteView: MemoryNoteView = {
	scope: "global",
	slug: "prefers-concise-replies",
	name: "Prefers concise replies",
	description: "Keep answers short",
	type: "user",
	created: "2026-09-10",
	updated: "2026-09-16",
	sources: ["user"],
	confidence: "high",
	body: "Answer briefly.",
	links: [],
	backlinks: [],
};

function makeApi(overrides: Partial<MetisDesktopApi> = {}) {
	return {
		getMemorySettings: vi.fn().mockResolvedValue(memorySettings),
		updateMemorySettings: vi.fn().mockResolvedValue(memorySettings),
		listMemoryNotes: vi.fn().mockResolvedValue({ notes: [noteSummary] }),
		readMemoryNote: vi.fn().mockResolvedValue({ note: noteView }),
		writeMemoryNote: vi.fn().mockResolvedValue({ ok: true, changeId: UUID }),
		listMemoryHistory: vi.fn().mockResolvedValue({ entries: [historyEntry] }),
		readMemoryHistory: vi
			.fn()
			.mockResolvedValue({ entry: historyEntry, patch: "--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-old\n+new\n" }),
		undoMemoryChange: vi.fn().mockResolvedValue({ ok: true }),
		undoMemoryRun: vi.fn().mockResolvedValue({ undone: [UUID], skipped: [] }),
		runMemoryDream: vi.fn().mockResolvedValue({ ok: true, runId: "run-1" }),
		setSessionMemoryFlags: vi.fn().mockResolvedValue({ useMemory: true, contributeMemory: false }),
		getModelSettings: vi.fn().mockResolvedValue({
			defaultModel: null,
			vision: null,
			defaultThinkingSelection: "off",
			providers: [],
			loadError: null,
		} satisfies ModelSettingsView),
		...overrides,
	} as unknown as MetisDesktopApi;
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("MemorySettingsPanel", () => {
	it("loads settings and history, renders toggles and the vault path", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		expect(api.getMemorySettings).toHaveBeenCalledTimes(1);
		expect(api.listMemoryHistory).toHaveBeenCalledWith({ limit: 20 });
		expect(toggle(container, "Enable long-term memory").checked).toBe(true);
		expect(toggle(container, "Active context").checked).toBe(true);
		expect(toggle(container, "Consolidate memory while idle").checked).toBe(false);
		expect(container.querySelector(".memory-vault-path")?.textContent).toContain("/tmp/agent/memory/global");
		expect(container.querySelector(".memory-history-target")?.textContent).toContain("prefers-concise-replies");
		await act(async () => root.unmount());
	});

	it("saves enabled, activeContext, and dream toggles", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => toggle(container, "Enable long-term memory").click());
		await act(async () => toggle(container, "Consolidate memory while idle").click());
		await act(async () => button(container, "Save").click());
		await flush();

		expect(api.updateMemorySettings).toHaveBeenCalledWith({
			enabled: false,
			activeContext: true,
			dream: { enabled: true, model: null, minHours: 24, minSessions: 5, maxUnusedDays: 90 },
		});
		expect(container.querySelector('.system-notice[data-tone="success"]')?.textContent).toContain("Saved");
		await act(async () => root.unmount());
	});

	it("reports dirty state through onDirtyChange", async () => {
		const api = makeApi();
		const onDirtyChange = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} onDirtyChange={onDirtyChange} serverReady />));
		await flush();
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);

		await act(async () => toggle(container, "Active context").click());
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		await act(async () => root.unmount());
	});

	it("undoes a history entry and reloads the list", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Undo").click());
		await flush();

		expect(api.undoMemoryChange).toHaveBeenCalledWith({ changeId: UUID });
		expect(api.listMemoryHistory).toHaveBeenCalledTimes(2);
		await act(async () => root.unmount());
	});

	it("shows an empty history hint when there are no changes", async () => {
		const api = makeApi({ listMemoryHistory: vi.fn().mockResolvedValue({ entries: [] }) });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		expect(container.textContent).toContain("No memory changes yet.");
		expect(container.querySelector(".memory-history-row")).toBeNull();
		await act(async () => root.unmount());
	});

	it("runs a dream on demand and refreshes the view", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Run now").click());
		await flush();

		expect(api.runMemoryDream).toHaveBeenCalledTimes(1);
		expect(api.getMemorySettings).toHaveBeenCalledTimes(2);
		expect(api.listMemoryHistory).toHaveBeenCalledTimes(2);
		await act(async () => root.unmount());
	});

	it("surfaces a failed dream run", async () => {
		const api = makeApi({ runMemoryDream: vi.fn().mockResolvedValue({ ok: false, error: "No credentialed model is available" }) });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Run now").click());
		await flush();

		expect(container.querySelector(".settings-action-message")?.textContent).toContain("No credentialed model");
		await act(async () => root.unmount());
	});

	it("disables Run now when no dream model is available", async () => {
		const noModel: MemorySettingsView = {
			...memorySettings,
			dream: { ...memorySettings.dream, modelAvailable: false },
		};
		const api = makeApi({ getMemorySettings: vi.fn().mockResolvedValue(noModel) });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		expect(button(container, "Run now").disabled).toBe(true);
		await act(async () => root.unmount());
	});

	it("lists notes and opens the editor for a selected note", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		expect(api.listMemoryNotes).toHaveBeenCalledWith({ scope: "global", limit: 100 });
		expect(button(container, "Prefers concise replies")).toBeDefined();

		await act(async () => button(container, "Prefers concise replies").click());
		await flush();

		expect(api.readMemoryNote).toHaveBeenCalledWith({ scope: "global", slug: "prefers-concise-replies" });
		const body = container.querySelector<HTMLTextAreaElement>(".memory-note-body");
		expect(body?.value).toBe("Answer briefly.");

		await act(async () => button(container, "Save note").click());
		await flush();

		expect(api.writeMemoryNote).toHaveBeenCalledWith(
			expect.objectContaining({
				op: "replace",
				scope: "global",
				target: { slug: "prefers-concise-replies" },
				content: "Answer briefly.",
			}),
		);
		await act(async () => root.unmount());
	});

	it("creates a note from the New note editor", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "New note").click());
		await flush();

		const slugInput = container.querySelector<HTMLInputElement>('input[aria-label="Note ID"]')!;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setter.call(slugInput, "new-note");
			slugInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => button(container, "Save note").click());
		await flush();

		expect(api.writeMemoryNote).toHaveBeenCalledWith(
			expect.objectContaining({ op: "create", scope: "global", target: { slug: "new-note" } }),
		);
		await act(async () => root.unmount());
	});

	it("deletes the open note", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Prefers concise replies").click());
		await flush();
		await act(async () => button(container, "Delete").click());
		await flush();

		expect(api.writeMemoryNote).toHaveBeenCalledWith(
			expect.objectContaining({ op: "delete", target: { slug: "prefers-concise-replies" } }),
		);
		await act(async () => root.unmount());
	});

	it("shows session memory toggles and applies them immediately", async () => {
		const withSession: MemorySettingsView = {
			...memorySettings,
			session: { useMemory: true, contributeMemory: true },
		};
		const api = makeApi({ getMemorySettings: vi.fn().mockResolvedValue(withSession) });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(<MemorySettingsPanel api={api} serverReady sessionId="99999999-8888-4777-8666-555544443333" />),
		);
		await flush();

		expect(api.getMemorySettings).toHaveBeenCalledWith({ sessionId: "99999999-8888-4777-8666-555544443333" });
		expect(api.listMemoryNotes).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "99999999-8888-4777-8666-555544443333" }),
		);
		expect(toggle(container, "Use memory in this session").checked).toBe(true);
		expect(toggle(container, "Learn from this session").checked).toBe(true);

		await act(async () => toggle(container, "Learn from this session").click());
		await flush();

		expect(api.setSessionMemoryFlags).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "99999999-8888-4777-8666-555544443333", contributeMemory: false }),
		);
		await act(async () => root.unmount());
	});

	it("expands a history entry into a rendered patch", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		const historyRow = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((item) =>
			item.textContent?.includes("prefers-concise-replies"),
		)!;
		await act(async () => historyRow.click());
		await flush();

		expect(api.readMemoryHistory).toHaveBeenCalledWith({ changeId: UUID });
		expect(container.querySelector('[data-testid="patch"]')?.textContent).toContain("-old");
		await act(async () => root.unmount());
	});

	it("undoes the last dream run", async () => {
		const withRun: MemorySettingsView = {
			...memorySettings,
			dream: {
				...memorySettings.dream,
				lastRunAt: "2026-09-16T12:00:00.000Z",
				lastRun: { runId: "run-9", added: 2, updated: 1, deleted: 0, at: "2026-09-16T12:00:00.000Z" },
			},
		};
		const api = makeApi({ getMemorySettings: vi.fn().mockResolvedValue(withRun) });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Undo last run").click());
		await flush();

		expect(api.undoMemoryRun).toHaveBeenCalledWith({ runId: "run-9" });
		await act(async () => root.unmount());
	});

	it("saves all Dream parameters together", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
			await flush();
			await fillNumber(container, "Minimum interval (hours)", "48");
			await fillNumber(container, "Minimum eligible sessions", "9");
			await fillNumber(container, "Unused-note age (days)", "120");
			await act(async () => button(container, "Save").click());
			await flush();
			expect(api.updateMemorySettings).toHaveBeenCalledWith(
				expect.objectContaining({
					dream: { enabled: false, model: null, minHours: 48, minSessions: 9, maxUnusedDays: 120 },
				}),
			);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it.each(["", "0", "1.5"])("rejects invalid Dream number %s without calling the RPC", async (value) => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
			await flush();
			await fillNumber(container, "Minimum interval (hours)", value);
			expect(button(container, "Save").disabled).toBe(true);
			expect(container.textContent).toContain("Minimum interval must be an integer");
			await act(async () => button(container, "Save").click());
			await flush();
			expect(api.updateMemorySettings).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("sends model:null after choosing Automatic over a saved override", async () => {
		const withOverride: MemorySettingsView = {
			...memorySettings,
			dream: { ...memorySettings.dream, model: { provider: "openai", modelId: "gpt-5" } },
		};
		const api = makeApi({
			getMemorySettings: vi.fn().mockResolvedValue(withOverride),
			getModelSettings: vi.fn().mockResolvedValue({
				defaultModel: null,
				vision: null,
				defaultThinkingSelection: "off",
				loadError: null,
				providers: [
					{
						provider: "openai",
						name: "OpenAI",
						builtin: true,
						baseUrl: null,
						api: null,
						auth: { configured: true, source: "stored", label: "••••1234" },
						models: [
							{
								provider: "openai",
								modelId: "gpt-5",
								name: "GPT-5",
								contextWindow: 400_000,
								maxOutputTokens: 128_000,
								reasoning: true,
								thinkingLevels: ["high"],
								reasoningMode: null,
								reasoningSource: null,
								imageInput: true,
								custom: false,
							},
						],
					},
				],
			} satisfies ModelSettingsView),
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
			await flush();
			const select = container.querySelector<HTMLSelectElement>('select[aria-label="Memory model"]')!;
			expect(select.value).toBe(JSON.stringify(["openai", "gpt-5"]));
			await selectOption(container, "Memory model", "");
			await act(async () => button(container, "Save").click());
			await flush();
			expect(api.updateMemorySettings).toHaveBeenCalledWith(
				expect.objectContaining({ dream: expect.objectContaining({ model: null }) }),
			);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps a saved but currently unavailable model override", async () => {
		const withOverride: MemorySettingsView = {
			...memorySettings,
			dream: { ...memorySettings.dream, model: { provider: "acme", modelId: "gone-model" } },
		};
		const api = makeApi({ getMemorySettings: vi.fn().mockResolvedValue(withOverride) });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
			await flush();
			const select = container.querySelector<HTMLSelectElement>('select[aria-label="Memory model"]')!;
			expect(select.value).toBe(JSON.stringify(["acme", "gone-model"]));
			const savedOption = [...select.options].find((o) => o.value === select.value)!;
			expect(savedOption.textContent).toContain("Saved model (currently unavailable)");
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("undoes a failed dream run by its runId", async () => {
		const api = makeApi({
			runMemoryDream: vi.fn().mockResolvedValue({ ok: false, runId: "run-fail", error: "aborted" }),
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
			await flush();
			await act(async () => button(container, "Run now").click());
			await flush();
			expect(container.textContent).toContain("Consolidation did not finish");
			await act(async () => button(container, "Undo changes from failed run").click());
			await flush();
			expect(api.undoMemoryRun).toHaveBeenCalledWith({ runId: "run-fail" });
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("hides the failed-run undo button when the failure has no runId", async () => {
		const api = makeApi({
			runMemoryDream: vi.fn().mockResolvedValue({ ok: false, error: "gated" }),
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
			await flush();
			await act(async () => button(container, "Run now").click());
			await flush();
			expect(container.textContent).toContain("gated");
			expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("failed run"))).toBe(false);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps unsaved Dream numbers after a run reload", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
			await flush();
			await fillNumber(container, "Minimum interval (hours)", "48");
			await act(async () => button(container, "Run now").click());
			await flush();
			expect(api.getMemorySettings).toHaveBeenCalledTimes(2);
			expect(container.querySelector<HTMLInputElement>('input[aria-label="Minimum interval (hours)"]')!.value).toBe(
				"48",
			);
			expect(container.textContent).toContain("Save changes to use them for the next run.");
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("labels the history diff as before-to-current", async () => {
		const api = makeApi();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<MemorySettingsPanel api={api} serverReady />));
			await flush();
			const historyRow = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((item) =>
				item.textContent?.includes("prefers-concise-replies"),
			)!;
			await act(async () => historyRow.click());
			await flush();
			expect(container.textContent).toContain("Before this change → current version");
		} finally {
			await act(async () => root.unmount());
		}
	});
});
