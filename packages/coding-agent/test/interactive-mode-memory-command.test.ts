import type { Component } from "@metis/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type MemoryCommandContext = {
	settingsManager: {
		setAutoMemoryEnabled: (enabled: boolean) => void;
		getAutoMemoryEnabled: () => boolean;
		getMemoryEngine: () => "index" | "extract";
		setMemoryEngine: (engine: "index" | "extract") => void;
	};
	session: {
		refreshSystemPrompt: () => void;
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
	handleMemoryCommand(this: MemoryCommandContext, action: string): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const USAGE = "Usage: /memory [on|off|engine …]";

describe("InteractiveMode /memory", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		["on", true, "Long-term memory enabled"],
		["off", false, "Long-term memory disabled"],
	] as const)("applies /memory %s immediately", (action, enabled, message) => {
		const setAutoMemoryEnabled = vi.fn();
		const refreshSystemPrompt = vi.fn();
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const context = {
			settingsManager: {
				setAutoMemoryEnabled,
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
				setMemoryEngine: vi.fn(),
			},
			session: {
				refreshSystemPrompt,
				getAutoMemorySnapshot: vi.fn(),
				getMemoryExtractStatus: vi.fn(),
			},
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus,
			showWarning,
		};

		prototype.handleMemoryCommand.call(context, action);

		expect(setAutoMemoryEnabled).toHaveBeenCalledWith(enabled);
		expect(refreshSystemPrompt).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith(message);
		expect(showWarning).not.toHaveBeenCalled();
	});

	it.each(["index", "extract"] as const)("applies /memory engine %s", (engine) => {
		const setMemoryEngine = vi.fn();
		const refreshSystemPrompt = vi.fn();
		const showStatus = vi.fn();
		const context = {
			settingsManager: {
				setAutoMemoryEnabled: vi.fn(),
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
				setMemoryEngine,
			},
			session: {
				refreshSystemPrompt,
				getAutoMemorySnapshot: vi.fn(),
				getMemoryExtractStatus: vi.fn(),
			},
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus,
			showWarning: vi.fn(),
		};

		prototype.handleMemoryCommand.call(context, `engine ${engine}`);

		expect(setMemoryEngine).toHaveBeenCalledWith(engine);
		expect(refreshSystemPrompt).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(new RegExp(engine, "i")));
	});

	it("warns and does not switch when extract lacks an embedding model", () => {
		const setMemoryEngine = vi.fn(() => {
			throw new Error(
				'Cannot enable memory engine "extract" without memoryEmbeddingModel. Configure an embedding model first (provider/model).',
			);
		});
		const refreshSystemPrompt = vi.fn();
		const showWarning = vi.fn();
		const context = {
			settingsManager: {
				setAutoMemoryEnabled: vi.fn(),
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
				setMemoryEngine,
			},
			session: {
				refreshSystemPrompt,
				getAutoMemorySnapshot: vi.fn(),
				getMemoryExtractStatus: vi.fn(),
			},
			chatContainer: { addChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning,
		};

		prototype.handleMemoryCommand.call(context, "engine extract");

		expect(setMemoryEngine).toHaveBeenCalledWith("extract");
		expect(refreshSystemPrompt).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(expect.stringMatching(/memoryEmbeddingModel|embedding model/i));
	});

	it("rejects unknown arguments without changing state", () => {
		const setAutoMemoryEnabled = vi.fn();
		const setMemoryEngine = vi.fn();
		const refreshSystemPrompt = vi.fn();
		const showWarning = vi.fn();
		const context = {
			settingsManager: {
				setAutoMemoryEnabled,
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
				setMemoryEngine,
			},
			session: {
				refreshSystemPrompt,
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
		expect(setAutoMemoryEnabled).not.toHaveBeenCalled();
		expect(setMemoryEngine).not.toHaveBeenCalled();
		expect(refreshSystemPrompt).not.toHaveBeenCalled();
	});

	it("rejects incomplete engine arguments", () => {
		const setMemoryEngine = vi.fn();
		const showWarning = vi.fn();
		const context = {
			settingsManager: {
				setAutoMemoryEnabled: vi.fn(),
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "index" as const,
				setMemoryEngine,
			},
			session: {
				refreshSystemPrompt: vi.fn(),
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
		expect(setMemoryEngine).not.toHaveBeenCalled();
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
				setAutoMemoryEnabled: vi.fn(),
				getAutoMemoryEnabled: () => true,
				getMemoryEngine: () => "extract" as const,
				setMemoryEngine: vi.fn(),
			},
			session: {
				refreshSystemPrompt: vi.fn(),
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
