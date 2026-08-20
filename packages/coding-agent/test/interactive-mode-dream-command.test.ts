import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RouteResult = "not-compacting" | "handled" | "dispatch";
type RouteContext = {
	session: { isCompacting: boolean };
	editor: { getText: () => string; setText: (text: string) => void };
	takeClipboardInput: (text: string) => { text: string; images?: unknown[] };
	queueCompactionMessage: (text: string, mode: "steer" | "followUp", images?: unknown[]) => void;
	isExtensionCommand: (text: string) => boolean;
	showWarning: (message: string) => void;
};

describe("InteractiveMode /dream", () => {
	it("tells the user Dream was removed", async () => {
		const showWarning = vi.fn();
		const editor = {
			setText: vi.fn(),
			getText: () => "/dream",
			onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		};
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor: editor,
			editor,
			runtimeHost: { session: { isCompacting: false } },
			showWarning,
			showStatus: vi.fn(),
			showError: vi.fn(),
			isExtensionCommand: () => false,
			takeClipboardInput: (text: string) => ({ text }),
			queueCompactionMessage: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		});

		(InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(): void }).setupEditorSubmitHandler.call(
			mode,
		);
		await editor.onSubmit?.("/dream");

		expect(showWarning).toHaveBeenCalledWith("Dream was removed. Use /memory.");
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	it("shows the removal message during compaction instead of queuing", () => {
		const context: RouteContext = {
			session: { isCompacting: true },
			editor: { getText: () => "", setText: vi.fn() },
			takeClipboardInput: (text) => ({ text }),
			queueCompactionMessage: vi.fn(),
			isExtensionCommand: () => false,
			showWarning: vi.fn(),
		};
		const route = Reflect.get(InteractiveMode.prototype, "routeCompactionInput") as (
			this: RouteContext,
			text: string,
			mode: "steer" | "followUp",
		) => RouteResult;

		expect(route.call(context, "/dream", "steer")).toBe("handled");
		expect(context.showWarning).toHaveBeenCalledWith("Dream was removed. Use /memory.");
		expect(context.queueCompactionMessage).not.toHaveBeenCalled();
	});
});
