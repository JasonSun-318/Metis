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

function createContext(extension = false): RouteContext {
	return {
		session: { isCompacting: true },
		editor: { getText: () => "", setText: vi.fn() },
		takeClipboardInput: (text) => ({ text }),
		queueCompactionMessage: vi.fn(),
		isExtensionCommand: () => extension,
		showWarning: vi.fn(),
	};
}

const route = Reflect.get(InteractiveMode.prototype, "routeCompactionInput") as (
	this: RouteContext,
	text: string,
	mode: "steer" | "followUp",
) => RouteResult;

const COMPACTION_WARNING =
	"Compaction is running. Wait for it to finish, then run the command again. Press Esc to cancel.";

describe("Compaction input routing", () => {
	it.each(["/copy", "/session", "/hotkeys", "/memory", "/quit", "/debug"])(
		"dispatches safe command %s immediately",
		(text) => {
			const context = createContext();
			expect(route.call(context, text, "steer")).toBe("dispatch");
			expect(context.queueCompactionMessage).not.toHaveBeenCalled();
		},
	);

	it.each([
		"!rm memory.md",
		"!!touch project.md",
		"/settings",
		"/model",
		"/scoped-models",
		"/export",
		"/import session.jsonl",
		"/name changed",
		"/fork",
		"/clone",
		"/tree",
		"/trust",
		"/login",
		"/logout",
		"/new",
		"/compact",
		"/resume",
		"/memory on",
		"/memory off",
		"/memory undo",
		"/reload",
		"/extension-command",
	])("blocks unsafe command %s without clearing the editor", (text) => {
		const context = createContext(text === "/extension-command");
		expect(route.call(context, text, "steer")).toBe("handled");
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith(COMPACTION_WARNING);
	});

	it.each(["ordinary message", "xdream", "/skill:notes summarize", "/prompt-template input"])(
		"queues ordinary or model-expanded input %s",
		(text) => {
			const context = createContext();
			expect(route.call(context, text, "followUp")).toBe("handled");
			expect(context.queueCompactionMessage).toHaveBeenCalledWith(text, "followUp", undefined);
		},
	);
});
