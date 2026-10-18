import type { AssistantMessage, ImageContent } from "@metis/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContextActions } from "../src/core/extensions/types.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	waitForIdle: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	navigateTree: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ cancelled: false, selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("binds command context actions with the shared headless contract", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		let actions: ExtensionCommandContextActions | undefined;
		session.bindExtensions.mockImplementation(
			async (options: { commandContextActions?: ExtensionCommandContextActions }) => {
				actions = options.commandContextActions;
			},
		);

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], { mode: "text" });

		expect(actions).toBeDefined();

		await actions!.waitForIdle();
		expect(session.waitForIdle).toHaveBeenCalledWith();

		const newSessionOptions = { parentSession: "parent", withSession: async () => {} };
		await actions!.newSession(newSessionOptions);
		expect(runtimeHost.newSession).toHaveBeenCalledWith(newSessionOptions);

		runtimeHost.fork.mockResolvedValue({ cancelled: false, selectedText: "selected" });
		await expect(actions!.fork("entry-1", { position: "at" })).resolves.toEqual({ cancelled: false });
		expect(runtimeHost.fork).toHaveBeenCalledWith("entry-1", { position: "at" });

		const navigateOptions = {
			summarize: true,
			customInstructions: "custom",
			replaceInstructions: false,
			label: "label",
			unexpected: "dropped",
		};
		await expect(actions!.navigateTree("target-1", navigateOptions)).resolves.toEqual({ cancelled: false });
		expect(session.navigateTree).toHaveBeenCalledWith("target-1", {
			summarize: true,
			customInstructions: "custom",
			replaceInstructions: false,
			label: "label",
		});

		const switchOptions = { withSession: async () => {} };
		await actions!.switchSession("/tmp/next-session.jsonl", switchOptions);
		expect(runtimeHost.switchSession).toHaveBeenCalledWith("/tmp/next-session.jsonl", switchOptions);

		await actions!.reload();
		expect(session.reload).toHaveBeenCalledWith();
	});
});
