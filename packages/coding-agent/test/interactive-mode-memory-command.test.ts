import type { Component } from "@metis/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type MemoryCommandContext = {
	settingsManager: {
		getAutoMemoryEnabled: () => boolean;
		getMemoryEngine: () => "index" | "extract";
	};
	session: {
		updateMemorySettings: (update: {
			autoMemoryEnabled?: boolean;
			memoryEngine?: "index" | "extract";
		}) => Promise<void>;
		getAutoMemorySnapshot: () =>
			| {
					global: { indexPath: string; exists: boolean; truncated: boolean; error?: string };
					project: { indexPath: string; exists: boolean; truncated: boolean; error?: string };
			  }
			| undefined;
		getMemoryExtractStatus: (limit?: number) => {
			enabled: boolean;
			active?: {
				id: string;
				sessionId: string;
				mode: "chat" | "code";
				extractMode: "commit" | "reconcile";
				cwd: string;
				trigger: string;
				startedAt: string;
			};
			recent: Array<{
				id: string;
				startedAt: string;
				trigger: string;
				status: "success" | "failed" | "skipped";
				reason: string | null;
			}>;
		};
	};
	chatContainer: { addChild: (component: unknown) => void };
	ui: { requestRender: () => void };
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
};

type InteractiveModePrototype = {
	handleMemoryCommand(this: MemoryCommandContext, action: string): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const USAGE = "Usage: /memory [on|off|engine …]";

describe("InteractiveMode /memory", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		["on", true, "Long-term memory enabled"],
		["off", false, "Long-term memory disabled"],
	] as const)("applies /memory %s immediately", async (action, enabled, message) => {
		const updateMemorySettings = vi.fn(async () => undefined);
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const context = {
			settingsManager: {
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
			},
			session: {
				updateMemorySettings,
				getAutoMemorySnapshot: vi.fn(),
				getMemoryExtractStatus: vi.fn(),
			},
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus,
			showWarning,
		};

		await prototype.handleMemoryCommand.call(context, action);

		expect(updateMemorySettings).toHaveBeenCalledWith({ autoMemoryEnabled: enabled });
		expect(showStatus).toHaveBeenCalledWith(message);
		expect(showWarning).not.toHaveBeenCalled();
	});

	it.each(["index", "extract"] as const)("applies /memory engine %s", async (engine) => {
		const updateMemorySettings = vi.fn(async () => undefined);
		const showStatus = vi.fn();
		const context = {
			settingsManager: {
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
			},
			session: {
				updateMemorySettings,
				getAutoMemorySnapshot: vi.fn(),
				getMemoryExtractStatus: vi.fn(),
			},
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus,
			showWarning: vi.fn(),
		};

		await prototype.handleMemoryCommand.call(context, `engine ${engine}`);

		expect(updateMemorySettings).toHaveBeenCalledWith({ memoryEngine: engine });
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(new RegExp(engine, "i")));
	});

	it("warns and does not switch when extract lacks an embedding model", async () => {
		const updateMemorySettings = vi.fn(async () => {
			throw new Error('Cannot enable memory engine "extract" without configured Embedding settings and credential.');
		});
		const showWarning = vi.fn();
		const context = {
			settingsManager: {
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
			},
			session: {
				updateMemorySettings,
				getAutoMemorySnapshot: vi.fn(),
				getMemoryExtractStatus: vi.fn(),
			},
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning,
		};

		await prototype.handleMemoryCommand.call(context, "engine extract");

		expect(updateMemorySettings).toHaveBeenCalledWith({ memoryEngine: "extract" });
		expect(showWarning).toHaveBeenCalledWith(expect.stringMatching(/Embedding settings|embedding model/i));
	});

	it("rejects unknown arguments without changing state", () => {
		const updateMemorySettings = vi.fn(async () => undefined);
		const showWarning = vi.fn();
		const context = {
			settingsManager: {
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
			},
			session: {
				updateMemorySettings,
				getAutoMemorySnapshot: vi.fn(),
				getMemoryExtractStatus: vi.fn(),
			},
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning,
		};

		prototype.handleMemoryCommand.call(context, "maybe");

		expect(showWarning).toHaveBeenCalledWith(USAGE);
		expect(updateMemorySettings).not.toHaveBeenCalled();
	});

	it("rejects incomplete engine arguments", () => {
		const updateMemorySettings = vi.fn(async () => undefined);
		const showWarning = vi.fn();
		const context = {
			settingsManager: {
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
			},
			session: {
				updateMemorySettings,
				getAutoMemorySnapshot: vi.fn(),
				getMemoryExtractStatus: vi.fn(),
			},
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning,
		};

		prototype.handleMemoryCommand.call(context, "engine");
		prototype.handleMemoryCommand.call(context, "engine foo");

		expect(showWarning).toHaveBeenCalledWith(USAGE);
		expect(updateMemorySettings).not.toHaveBeenCalled();
	});

	it("shows on/off, engine, catalog paths, extract status, and recent runs", () => {
		const addChild = vi.fn();
		const requestRender = vi.fn();
		const getMemoryExtractStatus = vi.fn(() => ({
			enabled: true,
			active: {
				id: "active",
				sessionId: "session",
				mode: "chat" as const,
				extractMode: "reconcile" as const,
				cwd: "/Users/ent/Metis",
				trigger: "manual",
				startedAt: "2026-07-15T06:00:00.000Z",
			},
			recent: Array.from({ length: 10 }, (_, index) => ({
				id: `run-${index}`,
				startedAt: "2026-07-15T05:00:00.000Z",
				trigger: "threshold",
				status: "success" as const,
				reason: null,
			})),
		}));
		const context = {
			settingsManager: {
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "extract" as const,
			},
			session: {
				updateMemorySettings: vi.fn(async () => undefined),
				getAutoMemorySnapshot: () => ({
					global: {
						indexPath: "/agent/memory/MEMORY.md",
						exists: true,
						truncated: false,
					},
					project: {
						indexPath: "/agent/memory/projects/--workspace--/chat/project.md",
						exists: true,
						truncated: false,
					},
				}),
				getMemoryExtractStatus,
			},
			chatContainer: { addChild },
			ui: { requestRender },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		};

		prototype.handleMemoryCommand.call(context, "");

		expect(getMemoryExtractStatus).toHaveBeenCalledWith(10);
		expect(addChild).toHaveBeenCalled();
		const rendered = addChild.mock.calls
			.map(([component]) => component as Component)
			.flatMap((component) => component.render(1000))
			.join("\n");
		expect(rendered).toMatch(/on/i);
		expect(rendered).toMatch(/extract/i);
		expect(rendered).toContain("/agent/memory/MEMORY.md");
		expect(rendered).toContain("/agent/memory/projects/--workspace--/chat/project.md");
		expect(rendered).toContain("running");
		expect(rendered).toContain("success");
		expect(rendered).toContain("/Users/ent/Metis");
		expect(requestRender).toHaveBeenCalled();
	});
});
