import type { Component } from "@metis/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DreamRunResult } from "../src/core/memory/dream/types.ts";
import type { ChangelogEntry } from "../src/core/memory/vault-history.ts";
import type { MemoryPromptSnapshot } from "../src/core/memory/vault-snapshot.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type MemoryCommandContext = {
	settingsManager: {
		getAutoMemoryEnabled: () => boolean;
	};
	session: {
		setAutoMemoryEnabled: (enabled: boolean) => Promise<void>;
		undoMemoryChange: (prefix?: string) => Promise<{ ok: boolean; error?: string }>;
		undoMemoryRun: (runId: string) => Promise<{ undone: string[]; skipped: { changeId: string; reason: string }[] }>;
		getMemorySnapshot: () => MemoryPromptSnapshot | undefined;
		getMemoryChanges: (limit?: number) => ChangelogEntry[];
	};
	runMemoryDream: (ignoreGate: boolean) => Promise<DreamRunResult>;
	chatContainer: { addChild: (component: unknown) => void };
	ui: { requestRender: () => void };
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
};

type MemoryEventContext = {
	isInitialized: boolean;
	footer: { invalidate: () => void };
	session: { sessionId: string };
	showStatus: (message: string) => void;
};

type InteractiveModePrototype = {
	handleMemoryCommand(this: MemoryCommandContext, action: string): Promise<void>;
	handleEvent(this: MemoryEventContext, event: unknown): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const USAGE = "Usage: /memory [on|off|use on|off|contribute on|off|undo [id]|undo-run <runId>|dream]";

const snapshot: MemoryPromptSnapshot = {
	protocol: "protocol",
	global: { pinned: "", index: "", dir: "/agent/memory/global" },
	project: {
		pinned: "",
		index: "",
		dir: "/agent/memory/projects/abc",
		root: "/workspace",
	},
	truncated: false,
};

const change: ChangelogEntry = {
	id: "12345678-90ab-cdef-0123-4567890abcde",
	ts: "2026-09-16T00:00:00.000Z",
	actor: { kind: "agent", sessionId: "session" },
	op: "create",
	scope: "project",
	projectKey: "abc",
	target: { slug: "architecture" },
};

function context(
	overrides: Partial<MemoryCommandContext["session"]> = {},
	enabled = true,
	dream: DreamRunResult = { ran: false, reason: "insufficient-sessions" },
) {
	return {
		settingsManager: { getAutoMemoryEnabled: () => enabled },
		session: {
			setAutoMemoryEnabled: vi.fn(async () => undefined),
			undoMemoryChange: vi.fn(async () => ({ ok: true })),
			undoMemoryRun: vi.fn(async () => ({ undone: [], skipped: [] })),
			getMemorySnapshot: () => snapshot,
			getMemoryChanges: vi.fn(() => [change]),
			...overrides,
		},
		runMemoryDream: vi.fn(async () => dream),
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
	} satisfies MemoryCommandContext;
}

describe("InteractiveMode /memory", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		["on", true, "Long-term memory enabled"],
		["off", false, "Long-term memory disabled"],
	] as const)("applies /memory %s immediately", async (action, enabled, message) => {
		const ctx = context();
		await prototype.handleMemoryCommand.call(ctx, action);
		expect(ctx.session.setAutoMemoryEnabled).toHaveBeenCalledWith(enabled);
		expect(ctx.showStatus).toHaveBeenCalledWith(message);
		expect(ctx.showWarning).not.toHaveBeenCalled();
	});

	it("warns when the toggle fails", async () => {
		const ctx = context({
			setAutoMemoryEnabled: vi.fn(async () => {
				throw new Error("read-only settings");
			}),
		});
		await prototype.handleMemoryCommand.call(ctx, "off");
		expect(ctx.showWarning).toHaveBeenCalledWith("read-only settings");
	});

	it("undoes the latest change and a prefixed change", async () => {
		const ctx = context();
		await prototype.handleMemoryCommand.call(ctx, "undo");
		expect(ctx.session.undoMemoryChange).toHaveBeenCalledWith(undefined);
		expect(ctx.showStatus).toHaveBeenCalledWith("Undid the memory change");

		await prototype.handleMemoryCommand.call(ctx, "undo 12345678");
		expect(ctx.session.undoMemoryChange).toHaveBeenCalledWith("12345678");
	});

	it("warns when undo finds nothing", async () => {
		const ctx = context({
			undoMemoryChange: vi.fn(async () => ({ ok: false, error: "no changes to undo" })),
		});
		await prototype.handleMemoryCommand.call(ctx, "undo");
		expect(ctx.showWarning).toHaveBeenCalledWith("no changes to undo");
	});

	it("rejects unknown arguments without changing state", async () => {
		const ctx = context();
		await prototype.handleMemoryCommand.call(ctx, "maybe");
		expect(ctx.showWarning).toHaveBeenCalledWith(USAGE);
		expect(ctx.session.setAutoMemoryEnabled).not.toHaveBeenCalled();
	});

	it("warns when memory is unavailable", async () => {
		const ctx = context({ getMemorySnapshot: () => undefined });
		await prototype.handleMemoryCommand.call(ctx, "");
		expect(ctx.showWarning).toHaveBeenCalledWith("Long-term memory is unavailable or disabled for this session.");
	});

	it("shows on/off state, scope dirs, and recent changes", async () => {
		const ctx = context();
		await prototype.handleMemoryCommand.call(ctx, "");

		expect(ctx.session.getMemoryChanges).toHaveBeenCalledWith(10);
		const rendered = ctx.chatContainer.addChild.mock.calls
			.map(([component]) => component as Component)
			.flatMap((component) => component.render(1000))
			.join("\n");
		expect(rendered).toMatch(/on/i);
		expect(rendered).toContain("/agent/memory/global");
		expect(rendered).toContain("/agent/memory/projects/abc");
		expect(rendered).toContain("create");
		expect(rendered).toContain("architecture");
		expect(rendered).toContain("12345678");
		expect(ctx.ui.requestRender).toHaveBeenCalled();
	});

	it("runs a manual dream and reports the summary", async () => {
		const ctx = context({}, true, {
			ran: true,
			runId: "12345678-90ab-cdef-0123-4567890abcde",
			added: 2,
			updated: 1,
			deleted: 0,
			sessions: 4,
			candidates: 6,
		});
		await prototype.handleMemoryCommand.call(ctx, "dream");
		expect(ctx.runMemoryDream).toHaveBeenCalledWith(true);
		expect(ctx.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("2 added"));
		expect(ctx.showWarning).not.toHaveBeenCalled();
	});

	it("reports the gate reason when the dream does not run", async () => {
		const ctx = context({}, true, { ran: false, reason: "insufficient-sessions" });
		await prototype.handleMemoryCommand.call(ctx, "dream");
		expect(ctx.showWarning).toHaveBeenCalledWith("Dream did not run: not enough unprocessed sessions");
	});

	it("reports a dream run error", async () => {
		const ctx = context({}, true, { ran: false, reason: "error", error: "model blew up" });
		await prototype.handleMemoryCommand.call(ctx, "dream");
		expect(ctx.showWarning).toHaveBeenCalledWith("Dream failed: model blew up");
	});

	it("undoes an entire Dream run with an explicit run ID", async () => {
		const undoMemoryRun = vi.fn(async () => ({ undone: [change.id], skipped: [] }));
		const ctx = context({ undoMemoryRun });
		await prototype.handleMemoryCommand.call(ctx, "undo-run run-123");
		expect(undoMemoryRun).toHaveBeenCalledWith("run-123");
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("1 change(s) undone"));
	});

	it("lists skipped reasons and warns on a missing run ID", async () => {
		const undoMemoryRun = vi.fn(async () => ({
			undone: [],
			skipped: [{ changeId: "abc", reason: "file modified after the run" }],
		}));
		const ctx = context({ undoMemoryRun });
		await prototype.handleMemoryCommand.call(ctx, "undo-run run-7");
		expect(undoMemoryRun).toHaveBeenCalledWith("run-7");
		expect(ctx.showWarning).toHaveBeenCalledWith("abc: file modified after the run");

		const empty = context();
		await prototype.handleMemoryCommand.call(empty, "undo-run");
		expect(empty.showWarning).toHaveBeenCalledWith(USAGE);
		expect(empty.session.undoMemoryRun).not.toHaveBeenCalled();

		const none = context({ undoMemoryRun: vi.fn(async () => ({ undone: [], skipped: [] })) });
		await prototype.handleMemoryCommand.call(none, "undo-run run-none");
		expect(none.showWarning).toHaveBeenCalledWith("No changes found for that Dream run");
	});

	it("announces external memory writes and skips self, dream, and group noise", async () => {
		const ctx: MemoryEventContext = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { sessionId: "session" },
			showStatus: vi.fn((_message: string) => undefined),
		};
		const emit = (entry: ChangelogEntry) => prototype.handleEvent.call(ctx, { type: "memory_changed", entry });

		const showStatus = vi.mocked(ctx.showStatus);
		await emit({ ...change, actor: { kind: "user" } });
		expect(showStatus).toHaveBeenCalledWith("Saved memory: project/architecture · /memory undo 12345678");
		showStatus.mockClear();

		await emit({ ...change, actor: { kind: "agent", sessionId: "session" } });
		await emit({ ...change, actor: { kind: "dream", runId: "run-1" } });
		await emit({ ...change, id: "ffffffff-0000-4000-8000-000000000000", operationId: change.id });
		expect(showStatus).not.toHaveBeenCalled();

		await emit({ ...change, actor: { kind: "user" }, op: "undo" });
		expect(showStatus).toHaveBeenCalledWith("Reverted memory: project/architecture");
	});
});
