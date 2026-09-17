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
		getMemorySnapshot: () => MemoryPromptSnapshot | undefined;
		getMemoryChanges: (limit?: number) => ChangelogEntry[];
	};
	runMemoryDream: (ignoreGate: boolean) => Promise<DreamRunResult>;
	chatContainer: { addChild: (component: unknown) => void };
	ui: { requestRender: () => void };
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
};

type InteractiveModePrototype = {
	handleMemoryCommand(this: MemoryCommandContext, action: string): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const USAGE = "Usage: /memory [on|off|use on|off|contribute on|off|undo [id]|dream]";

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
});
