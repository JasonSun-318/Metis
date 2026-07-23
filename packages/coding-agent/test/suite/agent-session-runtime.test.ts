import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@arcmind/ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	identifySubmitPromptRequest,
	MAX_DURABLE_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGE_BYTES,
	reduceRuntimeJournal,
} from "../../src/core/runtime-recovery.ts";
import { getSessionImageDir, SessionManager } from "../../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

function errorTreeIncludesMessage(error: unknown, message: string): boolean {
	if (error instanceof AggregateError) {
		return error.errors.some((nestedError) => errorTreeIncludesMessage(nestedError, message));
	}
	return error instanceof Error && error.message === message;
}

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			cwd?: string;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			sessionManager?: SessionManager;
			disposeOnCleanup?: boolean;
			promptTemplatePaths?: string[];
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `arcmind-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				additionalPromptTemplatePaths: options?.promptTemplatePaths,
				extensionFactories: [
					(arcmind: ExtensionAPI) => {
						arcmind.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(arcmind);
					},
				],
				noSkills: true,
				noPromptTemplates: options?.promptTemplatePaths === undefined,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const sessionManager = options?.sessionManager ?? SessionManager.create(tempDir);
		sessionManager.setPermissionSettings({ mode: "full" });
		const sessionCwd = sessionManager.getCwd();
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionCwd,
			agentDir: tempDir,
			sessionManager,
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			if (options?.disposeOnCleanup !== false) await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((arcmind: ExtensionAPI) => {
			arcmind.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("accepts one durable prompt and replays its request identity without replaying the provider", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([fauxAssistantMessage("done")]);

		const accepted = await runtime.submitPrompt({ requestId: "request-direct", text: "hello" });
		const existing = await runtime.submitPrompt({ requestId: "request-direct", text: "hello" });
		expect(existing).toEqual({ ...accepted, status: "existing" });
		await expect(runtime.submitPrompt({ requestId: "request-direct", text: "different" })).rejects.toMatchObject({
			code: "REQUEST_ID_REUSED",
		});

		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot());
			expect(reduced.operations.find((operation) => operation.operationId === accepted.operationId)?.state).toBe(
				"completed",
			);
		});
		expect(faux.state.callCount).toBe(1);
		const turnMessages = runtime.session.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
			);
		expect(turnMessages).toHaveLength(2);
		expect(turnMessages.every((entry) => entry.type === "message" && entry.turnId === accepted.turnId)).toBe(true);
	});

	it("reserves the session synchronously for an accepted durable prompt", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([fauxAssistantMessage("durable reply")]);

		const accepted = runtime.submitPrompt({ requestId: "request-reservation", text: "durable input" });
		await expect(runtime.session.prompt("legacy input")).rejects.toThrow(
			"A durable app-server prompt has already been admitted for this session",
		);
		await expect(runtime.session.steer("legacy steer")).rejects.toThrow(
			"A durable app-server prompt has already been admitted for this session",
		);
		await expect(runtime.session.followUp("legacy follow-up")).rejects.toThrow(
			"A durable app-server prompt has already been admitted for this session",
		);
		await expect(runtime.session.agent.prompt("raw low-level input")).rejects.toThrow(
			"A durable app-server prompt has already been admitted for this session",
		);
		const identity = await accepted;
		await vi.waitFor(() => {
			const operation = reduceRuntimeJournal(
				runtime.session.sessionManager.getDurableJournalSnapshot(),
			).operations.find((item) => item.operationId === identity.operationId);
			expect(operation?.state).toBe("completed");
		});
		expect(faux.state.callCount).toBe(1);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.map((entry) => {
					if (entry.type !== "message" || entry.message.role !== "user") return "";
					if (typeof entry.message.content === "string") return entry.message.content;
					return entry.message.content
						.filter((content) => content.type === "text")
						.map((content) => content.text)
						.join("");
				}),
		).toEqual(["durable input"]);
	});

	it("durably interrupts active work, recovers queued work as a draft, and remains usable", async () => {
		let releaseProvider!: () => void;
		let markProviderStarted!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([
			async (_context, options) => {
				markProviderStarted();
				await providerGate;
				return fauxAssistantMessage("", { stopReason: options?.signal?.aborted ? "aborted" : "stop" });
			},
			fauxAssistantMessage("new work completed"),
		]);

		await runtime.submitPrompt({ requestId: "request-interrupt-direct", text: "start" });
		await providerStarted;
		const queuedInput = { text: "recover me", streamingBehavior: "followUp" } as const;
		const queued = await runtime.submitPrompt({ requestId: "request-interrupt-queued", ...queuedInput });
		const interrupting = runtime.interrupt({ requestId: "request-interrupt" });
		await Promise.resolve();
		releaseProvider();
		const interrupted = await interrupting;

		expect(faux.state.callCount).toBe(1);
		expect(interrupted.status).toBe("accepted");
		expect(runtime.recoverableDrafts).toContainEqual({ queueItemId: queued.queueItemId, input: queuedInput });
		const reduced = reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot());
		expect(reduced.decisions).toEqual([]);
		expect(reduced.operations.find((operation) => operation.requestId === "request-interrupt")?.state).toBe(
			"completed",
		);
		expect(reduced.queues.find((queue) => queue.queueItemId === queued.queueItemId)?.state).toBe("cancelled");
		await expect(runtime.interrupt({ requestId: "request-interrupt" })).resolves.toEqual({
			...interrupted,
			status: "existing",
		});

		await runtime.submitPrompt({ requestId: "request-after-interrupt", text: "continue" });
		await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
	});

	it("keeps the writer lease when direct AgentSession disposal races accepted work", async () => {
		let releaseProvider!: () => void;
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([
			async () => {
				await providerGate;
				return fauxAssistantMessage("done");
			},
		]);

		const accepted = runtime.submitPrompt({ requestId: "request-dispose-race", text: "start" });
		const sessionFile = runtime.session.sessionFile!;
		expect(() => runtime.session.dispose()).toThrow(
			"Cannot directly dispose a runtime-owned durable session; dispose its AgentSessionRuntime instead",
		);
		expect(() => SessionManager.open(sessionFile)).toThrow();

		const disposing = runtime.dispose();
		releaseProvider();
		await accepted;
		await disposing;
		const reopened = SessionManager.open(sessionFile);
		reopened.close();
	});

	it("preserves completed terminal evidence when runtime disposal starts during agent_end", async () => {
		let releaseAgentEnd!: () => void;
		let markAgentEndStarted!: () => void;
		const agentEndStarted = new Promise<void>((resolve) => {
			markAgentEndStarted = resolve;
		});
		const agentEndGate = new Promise<void>((resolve) => {
			releaseAgentEnd = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.on("agent_end", async () => {
				markAgentEndStarted();
				await agentEndGate;
			});
		});
		faux.setResponses([fauxAssistantMessage("durably complete")]);

		const accepted = await runtime.submitPrompt({ requestId: "request-dispose-after-terminal", text: "start" });
		await agentEndStarted;
		expect(
			runtime.session.sessionManager
				.getDurableJournalSnapshot()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.turnId === accepted.turnId &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "stop",
				),
		).toBe(true);
		const sessionFile = runtime.session.sessionFile!;
		const disposing = runtime.dispose();
		releaseAgentEnd();
		await disposing;
		expect(faux.state.callCount).toBe(1);

		const reopened = SessionManager.open(sessionFile);
		const reduced = reduceRuntimeJournal(reopened.getDurableJournalSnapshot());
		expect(reduced.operations.find((operation) => operation.operationId === accepted.operationId)?.state).toBe(
			"completed",
		);
		expect(reduced.decisions).toEqual([]);
		reopened.close();
	});

	it("keeps the writer lease until async agent_settled handling finishes", async () => {
		let releaseAgentSettled!: () => void;
		let markAgentSettledStarted!: () => void;
		const agentSettledStarted = new Promise<void>((resolve) => {
			markAgentSettledStarted = resolve;
		});
		const agentSettledGate = new Promise<void>((resolve) => {
			releaseAgentSettled = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.on("agent_settled", async () => {
				markAgentSettledStarted();
				await agentSettledGate;
			});
		});
		faux.setResponses([fauxAssistantMessage("done")]);

		await runtime.submitPrompt({ requestId: "request-dispose-during-settlement", text: "start" });
		await agentSettledStarted;
		const sessionFile = runtime.session.sessionFile!;
		expect(() => runtime.session.dispose()).toThrow(
			"Cannot dispose an active agent session; await abortAndDrainAgentEventPersistence() before disposing",
		);
		expect(() => SessionManager.open(sessionFile)).toThrow();

		const disposing = runtime.dispose();
		releaseAgentSettled();
		await disposing;
		const reopened = SessionManager.open(sessionFile);
		reopened.close();
	});

	it("keeps queued image prompts as refs and hydrates one bounded batch only at consumption", async () => {
		let releaseProvider!: () => void;
		let markProviderStarted!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		let secondProviderPayload = "";
		const { runtime, faux } = await createRuntimeForTest(() => {});
		const manager = runtime.session.sessionManager;
		const imageBytes = Buffer.from("durable queued image");
		const hash = createHash("sha256").update(imageBytes).digest("hex");
		const imageDir = getSessionImageDir(manager.getSessionFile()!);
		mkdirSync(imageDir, { recursive: true });
		writeFileSync(join(imageDir, `${hash}.png`), imageBytes);
		const image = { type: "image_ref" as const, hash, mimeType: "image/png", size: imageBytes.length };
		const resolveImages = vi.spyOn(manager, "resolveDurableImageRefs");
		faux.setResponses([
			async () => {
				markProviderStarted();
				await providerGate;
				return fauxAssistantMessage("first");
			},
			async (context) => {
				secondProviderPayload = JSON.stringify(context);
				return fauxAssistantMessage("images consumed");
			},
		]);
		runtime.session.agent.followUpMode = "all";

		await runtime.submitPrompt({ requestId: "request-image-direct", text: "start" });
		await providerStarted;
		const queued = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				runtime.submitPrompt({
					requestId: `request-image-queued-${index}`,
					text: `image ${index}`,
					images: [image],
					streamingBehavior: "followUp",
				}),
			),
		);
		expect(resolveImages).not.toHaveBeenCalled();
		expect(JSON.stringify(manager.getDurableJournalSnapshot())).not.toContain('"data"');

		releaseProvider();
		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(manager.getDurableJournalSnapshot());
			expect(reduced.operations.find((item) => item.operationId === queued.at(-1)!.operationId)?.state).toBe(
				"completed",
			);
		});
		expect(resolveImages).toHaveBeenCalledTimes(12);
		expect(secondProviderPayload.match(/"type":"image"/g)).toHaveLength(12);
		expect(secondProviderPayload).toContain(imageBytes.toString("base64"));
	});

	it("fails closed and recovers a queued image whose blob disappears before consumption", async () => {
		let releaseProvider!: () => void;
		let markProviderStarted!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const tempDir = join(
			tmpdir(),
			`arcmind-runtime-missing-image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const { runtime, faux } = await createRuntimeForTest(() => {}, { cwd: tempDir });
		const manager = runtime.session.sessionManager;
		const bytes = Buffer.from("disappearing durable image");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const imageDir = getSessionImageDir(manager.getSessionFile()!);
		mkdirSync(imageDir, { recursive: true });
		const imagePath = join(imageDir, `${hash}.png`);
		writeFileSync(imagePath, bytes);
		const image = { type: "image_ref" as const, hash, mimeType: "image/png", size: bytes.length };
		faux.setResponses([
			async () => {
				markProviderStarted();
				await providerGate;
				return fauxAssistantMessage("first");
			},
		]);

		const direct = await runtime.submitPrompt({ requestId: "request-missing-image-direct", text: "start" });
		await providerStarted;
		const queuedInput = { text: "use image", images: [image], streamingBehavior: "followUp" as const };
		const queued = await runtime.submitPrompt({ requestId: "request-missing-image-queued", ...queuedInput });
		unlinkSync(imagePath);
		releaseProvider();
		await vi.waitFor(() => {
			expect(
				reduceRuntimeJournal(manager.getDurableJournalSnapshot()).operations.find(
					(operation) => operation.operationId === direct.operationId,
				)?.state,
			).toBe("interrupted");
		});
		expect(faux.state.callCount).toBe(1);
		await expect(runtime.session.agent.continue()).rejects.toThrow(
			"The durable prompt queue must be recovered before running more work",
		);

		const sessionFile = manager.getSessionFile()!;
		await runtime.dispose();
		const reopened = await createRuntimeForTest(() => {}, {
			cwd: tempDir,
			sessionManager: SessionManager.open(sessionFile),
		});
		expect(reopened.runtime.recoverableDrafts).toContainEqual({
			queueItemId: queued.queueItemId,
			input: queuedInput,
		});
		await expect(
			reopened.runtime.submitPrompt({ requestId: "request-missing-image-queued", ...queuedInput }),
		).resolves.toMatchObject({ operationId: queued.operationId, status: "existing" });
		expect(reopened.faux.state.callCount).toBe(0);
		expect(
			reduceRuntimeJournal(reopened.runtime.session.sessionManager.getDurableJournalSnapshot()).decisions,
		).toEqual([]);
	});

	it("does not retain hydrated queue images when the durable turn claim fails", async () => {
		let releaseProvider!: () => void;
		let markProviderStarted!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest(() => {});
		const manager = runtime.session.sessionManager;
		const bytes = Buffer.from("claim failure image");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const imageDir = getSessionImageDir(manager.getSessionFile()!);
		mkdirSync(imageDir, { recursive: true });
		writeFileSync(join(imageDir, `${hash}.png`), bytes);
		const image = { type: "image_ref" as const, hash, mimeType: "image/png", size: bytes.length };
		faux.setResponses([
			async () => {
				markProviderStarted();
				await providerGate;
				return fauxAssistantMessage("first");
			},
		]);

		await runtime.submitPrompt({ requestId: "request-claim-image-direct", text: "start" });
		await providerStarted;
		const queued = await runtime.submitPrompt({
			requestId: "request-claim-image-queued",
			text: "queued image",
			images: [image],
			streamingBehavior: "followUp",
		});
		const appendControl = manager.appendRuntimeControl.bind(manager);
		vi.spyOn(manager, "appendRuntimeControl").mockImplementation((payload) => {
			if (
				payload.type === "runtime_turn" &&
				payload.state === "started" &&
				payload.operationIds.includes(queued.operationId)
			) {
				throw new Error("queue claim sync failed");
			}
			return appendControl(payload);
		});
		releaseProvider();
		await runtime.session.waitForIdle();
		const pending = (
			runtime.session.agent as unknown as {
				followUpQueue: { items: Array<{ message: unknown }> };
			}
		).followUpQueue.items;
		expect(pending).toHaveLength(1);
		expect(JSON.stringify(pending[0]!.message)).not.toContain('"type":"image"');
		expect(JSON.stringify(pending[0]!.message)).not.toContain(bytes.toString("base64"));
		expect(faux.state.callCount).toBe(1);
	});

	it("bounds amplified durable templates before direct or queued provider work", async () => {
		const tempDir = join(
			tmpdir(),
			`arcmind-runtime-template-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const promptDir = join(tempDir, "prompts");
		mkdirSync(promptDir, { recursive: true });
		writeFileSync(join(promptDir, "amplify.md"), "$@ $@ $@");
		let releaseProvider!: () => void;
		let markProviderStarted!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest(() => {}, {
			cwd: tempDir,
			promptTemplatePaths: [promptDir],
		});
		const amplifiedCommand = `/amplify ${"x".repeat(1024 * 1024)}`;
		faux.setResponses([
			async () => {
				markProviderStarted();
				await providerGate;
				return fauxAssistantMessage("direct done");
			},
		]);

		const oversizedDirect = await runtime.submitPrompt({
			requestId: "request-template-direct-overflow",
			text: amplifiedCommand,
		});
		await vi.waitFor(() => {
			const operation = reduceRuntimeJournal(
				runtime.session.sessionManager.getDurableJournalSnapshot(),
			).operations.find((item) => item.operationId === oversizedDirect.operationId);
			expect(operation?.state).toBe("interrupted");
		});
		expect(faux.state.callCount).toBe(0);

		await runtime.submitPrompt({ requestId: "request-template-normal", text: "start" });
		await providerStarted;
		await expect(
			runtime.submitPrompt({
				requestId: "request-template-queued-overflow",
				text: amplifiedCommand,
				streamingBehavior: "followUp",
			}),
		).rejects.toThrow("Expanded prompt cannot exceed 2097152 UTF-8 bytes");
		expect(runtime.session.pendingMessageCount).toBe(0);
		expect(
			reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot()).operations.find(
				(operation) => operation.requestId === "request-template-queued-overflow",
			)?.state,
		).toBe("interrupted");
		releaseProvider();
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	});

	it("recovers a same-tick durable follow-up when direct provider-ready expansion fails", async () => {
		const tempDir = join(
			tmpdir(),
			`arcmind-runtime-expanded-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const { runtime, faux } = await createRuntimeForTest(
			(arcmind) => {
				arcmind.on("input", (event) =>
					event.text === "expand beyond cap"
						? { action: "transform", text: "x".repeat(2 * 1024 * 1024 + 1) }
						: { action: "continue" },
				);
			},
			{ cwd: tempDir },
		);
		faux.setResponses([fauxAssistantMessage("must not run")]);

		const directPromise = runtime.submitPrompt({
			requestId: "request-expanded-failure-direct",
			text: "expand beyond cap",
		});
		const queuedInput = { text: "recover me", streamingBehavior: "followUp" as const };
		const queued = await runtime.submitPrompt({ requestId: "request-expanded-failure-queued", ...queuedInput });
		const direct = await directPromise;
		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot());
			expect(reduced.operations.find((operation) => operation.operationId === direct.operationId)?.state).toBe(
				"interrupted",
			);
		});
		expect(faux.state.callCount).toBe(0);
		expect(runtime.session.pendingMessageCount).toBe(1);
		await expect(runtime.session.agent.prompt("raw bypass")).rejects.toThrow(
			"The durable prompt queue must be recovered before running more work",
		);

		const sessionFile = runtime.session.sessionFile!;
		await runtime.dispose();
		const reopened = await createRuntimeForTest(() => {}, {
			cwd: tempDir,
			sessionManager: SessionManager.open(sessionFile),
		});
		expect(reopened.runtime.recoverableDrafts).toContainEqual({
			queueItemId: queued.queueItemId,
			input: queuedInput,
		});
		expect(reopened.faux.state.callCount).toBe(0);
	});

	it("does not invent a turn identity when direct admission fails before turn start", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		const manager = runtime.session.sessionManager;
		const append = manager.appendRuntimeControl.bind(manager);
		let failTurnStart = true;
		vi.spyOn(manager, "appendRuntimeControl").mockImplementation((payload) => {
			if (payload.type === "runtime_turn" && payload.state === "started" && failTurnStart) {
				failTurnStart = false;
				throw new Error("turn start persistence failed");
			}
			return append(payload);
		});

		await expect(runtime.submitPrompt({ requestId: "request-admission-failure", text: "hello" })).rejects.toThrow(
			"turn start persistence failed",
		);
		const replay = await runtime.submitPrompt({ requestId: "request-admission-failure", text: "hello" });
		expect(replay.status).toBe("existing");
		expect(replay.turnId).toBeUndefined();
		expect(replay.queueItemId).toBeUndefined();
		expect(faux.state.callCount).toBe(0);
	});

	it("does not invent a turn identity when reopening an accepted-only direct crash prefix", async () => {
		const tempDir = join(
			tmpdir(),
			`arcmind-runtime-accepted-prefix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		const manager = SessionManager.create(tempDir);
		const input = { text: "hello" } as const;
		const identity = identifySubmitPromptRequest("request-accepted-prefix", input);
		manager.appendRuntimeControl({
			type: "runtime_operation",
			operationId: identity.operationId,
			requestId: identity.requestId,
			requestHash: identity.requestHash,
			kind: "turn",
			state: "accepted",
			input,
		});
		const sessionFile = manager.getSessionFile()!;
		manager.close();

		const { runtime, faux } = await createRuntimeForTest(() => {}, {
			cwd: tempDir,
			sessionManager: SessionManager.open(sessionFile),
		});
		const replay = await runtime.submitPrompt({ requestId: identity.requestId, text: input.text });
		expect(replay).toEqual({ operationId: identity.operationId, status: "existing" });
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects extension slash commands before durable admission or execution", async () => {
		let commandRuns = 0;
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.registerCommand("danger", {
				description: "Must not run through durable prompt submission",
				handler: async () => {
					commandRuns += 1;
				},
			});
		});

		await expect(runtime.submitPrompt({ requestId: "request-extension-command", text: "/danger" })).rejects.toThrow(
			'Extension command "/danger" cannot be queued',
		);
		expect(commandRuns).toBe(0);
		expect(faux.state.callCount).toBe(0);
		expect(
			reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot()).operations.some(
				(operation) => operation.requestId === "request-extension-command",
			),
		).toBe(false);
	});

	it("closes prompt admission synchronously while lifecycle work is queued", async () => {
		let releaseSwitch!: () => void;
		const switchGate = new Promise<void>((resolve) => {
			releaseSwitch = resolve;
		});
		const { runtime } = await createRuntimeForTest((arcmind) => {
			arcmind.on("session_before_switch", async () => {
				await switchGate;
			});
		});

		const replacement = runtime.newSession();
		await expect(runtime.submitPrompt({ requestId: "request-during-switch", text: "hello" })).rejects.toThrow(
			"Agent session runtime is disposing or disposed",
		);
		releaseSwitch();
		await expect(replacement).resolves.toEqual({ cancelled: false });
		await expect(runtime.submitPrompt({ requestId: "request-after-switch", text: "hello" })).resolves.toMatchObject({
			status: "accepted",
		});
	});

	it("starts a prompt submitted from agent_settled as a new direct turn", async () => {
		let runtimeRef!: AgentSessionRuntime;
		let submittedFromSettled: ReturnType<AgentSessionRuntime["submitPrompt"]> | undefined;
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.on("agent_settled", () => {
				if (submittedFromSettled) return;
				submittedFromSettled = runtimeRef.submitPrompt({
					requestId: "request-from-settled",
					text: "second",
				});
				void submittedFromSettled.catch(() => {});
			});
		});
		runtimeRef = runtime;
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await runtime.submitPrompt({ requestId: "request-before-settled", text: "first" });
		await vi.waitFor(() => expect(submittedFromSettled).toBeDefined());
		const accepted = await submittedFromSettled!;
		expect(accepted.queueItemId).toBeUndefined();
		expect(accepted.turnId).toBeDefined();
		await vi.waitFor(() => {
			const operation = reduceRuntimeJournal(
				runtime.session.sessionManager.getDurableJournalSnapshot(),
			).operations.find((item) => item.operationId === accepted.operationId);
			expect(operation?.kind).toBe("turn");
			expect(operation?.state).toBe("completed");
		});
		expect(faux.state.callCount).toBe(2);
	});

	it.each(["newSession", "dispose"] as const)(
		"rejects reentrant %s from an accepted prompt task without deadlocking",
		async (method) => {
			let runtimeRef!: AgentSessionRuntime;
			let attempted = false;
			let lifecycleError: unknown;
			const { runtime, faux } = await createRuntimeForTest((arcmind) => {
				arcmind.on("agent_settled", async () => {
					if (attempted) return;
					attempted = true;
					try {
						if (method === "newSession") await runtimeRef.newSession();
						else await runtimeRef.dispose();
					} catch (error) {
						lifecycleError = error;
					}
				});
			});
			runtimeRef = runtime;
			faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("still usable")]);

			await runtime.submitPrompt({ requestId: `request-reentrant-${method}`, text: "first" });
			await vi.waitFor(() => {
				expect(lifecycleError).toMatchObject({
					message: "Session lifecycle changes cannot run from within an accepted prompt task",
				});
			});
			await expect(
				runtime.submitPrompt({ requestId: `request-after-reentrant-${method}`, text: "second" }),
			).resolves.toMatchObject({ status: "accepted" });
		},
	);

	it("fails prompt admission closed after durable turn finalization fails until recovery", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("recovered")]);
		const manager = runtime.session.sessionManager;
		const append = manager.appendRuntimeControl.bind(manager);
		const appendSpy = vi.spyOn(manager, "appendRuntimeControl").mockImplementation((payload) => {
			if (payload.type === "runtime_turn" && payload.state !== "started") {
				throw new Error("terminal turn fsync failed");
			}
			return append(payload);
		});

		await runtime.submitPrompt({ requestId: "request-terminal-failure", text: "first" });
		await vi.waitFor(() => {
			expect(runtime.diagnostics).toContainEqual({
				type: "error",
				message: "Durable prompt finalization failed; new submissions are disabled until session recovery.",
			});
		});
		await expect(
			runtime.submitPrompt({ requestId: "request-blocked-after-terminal-failure", text: "second" }),
		).rejects.toThrow("Agent session runtime is disposing or disposed");

		appendSpy.mockRestore();
		await runtime.newSession();
		await expect(
			runtime.submitPrompt({ requestId: "request-after-terminal-recovery", text: "second" }),
		).resolves.toMatchObject({
			status: "accepted",
		});
	});

	it("keeps repeated queued text distinct and incrementally exposes the consumed turn identity", async () => {
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([
			async () => {
				markFirstStarted();
				await firstGate;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);

		const direct = await runtime.submitPrompt({ requestId: "request-batch-direct", text: "start" });
		await firstStarted;
		const first = await runtime.submitPrompt({
			requestId: "request-batch-1",
			text: "same",
			streamingBehavior: "steer",
		});
		const second = await runtime.submitPrompt({
			requestId: "request-batch-2",
			text: "same",
			streamingBehavior: "steer",
		});
		expect(first.queueItemId).toBeDefined();
		expect(second.queueItemId).toBeDefined();
		expect(first.queueItemId).not.toBe(second.queueItemId);
		expect(first.turnId).toBeUndefined();
		expect(
			await runtime.submitPrompt({
				requestId: "request-batch-1",
				text: "same",
				streamingBehavior: "steer",
			}),
		).toMatchObject({ queueItemId: first.queueItemId, status: "existing" });

		releaseFirst();
		await vi.waitFor(() => expect(faux.state.callCount).toBe(3));
		await vi.waitFor(async () => {
			const replay = await runtime.submitPrompt({
				requestId: "request-batch-1",
				text: "same",
				streamingBehavior: "steer",
			});
			expect(replay.turnId).toBe(direct.turnId);
		});
	});

	it("refuses every queue clear path while a durable queued prompt is pending", async () => {
		let releaseProvider!: () => void;
		let markProviderStarted!: () => void;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([
			async () => {
				markProviderStarted();
				await providerGate;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("queued complete"),
		]);

		await runtime.submitPrompt({ requestId: "request-clear-direct", text: "start" });
		await providerStarted;
		const queued = await runtime.submitPrompt({
			requestId: "request-clear-queued",
			text: "must survive clear",
			streamingBehavior: "followUp",
		});
		const messagesBeforeRejectedReset = runtime.session.agent.state.messages.slice();
		expect(() => runtime.session.clearQueue()).toThrow(
			"Durable queued prompts cannot be cleared before they are consumed or recovered",
		);
		expect(() => runtime.session.agent.clearAllQueues()).toThrow(
			"Durable queued prompts cannot be cleared before they are consumed or recovered",
		);
		expect(() => runtime.session.agent.reset()).toThrow(
			"Durable queued prompts cannot be cleared before they are consumed or recovered",
		);
		expect(runtime.session.agent.state.messages).toEqual(messagesBeforeRejectedReset);
		expect(runtime.session.pendingMessageCount).toBe(1);
		releaseProvider();
		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot());
			expect(reduced.decisions).toEqual([]);
			expect(reduced.operations.find((operation) => operation.operationId === queued.operationId)?.state).toBe(
				"completed",
			);
		});
		expect(
			reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot()).turns.some((turn) =>
				turn.consumedQueueItemIds.includes(queued.queueItemId!),
			),
		).toBe(true);
		await expect(
			runtime.submitPrompt({
				requestId: "request-clear-queued",
				text: "must survive clear",
				streamingBehavior: "followUp",
			}),
		).resolves.toMatchObject({ operationId: queued.operationId, status: "existing" });
	});

	it.each(["abort", "dispose"] as const)(
		"does not consume a durable follow-up after runtime %s stops the active run",
		async (stopKind) => {
			let releaseProvider!: () => void;
			let markProviderStarted!: () => void;
			const providerStarted = new Promise<void>((resolve) => {
				markProviderStarted = resolve;
			});
			const providerGate = new Promise<void>((resolve) => {
				releaseProvider = resolve;
			});
			const tempDir = join(
				tmpdir(),
				`arcmind-runtime-stop-${stopKind}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			const { runtime, faux } = await createRuntimeForTest(() => {}, {
				cwd: tempDir,
				disposeOnCleanup: stopKind !== "dispose",
			});
			faux.setResponses([
				async (_context, options) => {
					markProviderStarted();
					await providerGate;
					return fauxAssistantMessage("", { stopReason: options?.signal?.aborted ? "aborted" : "stop" });
				},
			]);

			await runtime.submitPrompt({ requestId: `request-stop-direct-${stopKind}`, text: "start" });
			await providerStarted;
			const queuedInput = { text: "keep as draft", streamingBehavior: "followUp" } as const;
			const queued = await runtime.submitPrompt({ requestId: `request-stop-queued-${stopKind}`, ...queuedInput });
			const sessionFile = runtime.session.sessionFile!;
			const stopping = stopKind === "abort" ? runtime.session.abort() : runtime.dispose();
			await Promise.resolve();
			releaseProvider();
			await stopping;
			expect(faux.state.callCount).toBe(1);

			let recoveredRuntime: AgentSessionRuntime;
			let replayProviderCalls: () => number;
			if (stopKind === "abort") {
				await expect(runtime.session.prompt("legacy bypass")).rejects.toThrow(
					"The durable prompt queue must be recovered before running more work",
				);
				await expect(runtime.session.agent.prompt("raw bypass")).rejects.toThrow(
					"The durable prompt queue must be recovered before running more work",
				);
				await expect(runtime.session.agent.continue()).rejects.toThrow(
					"The durable prompt queue must be recovered before running more work",
				);
				expect(faux.state.callCount).toBe(1);
				expect(runtime.session.pendingMessageCount).toBe(1);
				await expect(
					runtime.submitPrompt({ requestId: "request-before-required-recovery", text: "blocked" }),
				).rejects.toThrow("The durable prompt queue must be recovered before accepting more work");
				expect(
					reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot()).operations.some(
						(operation) => operation.requestId === "request-before-required-recovery",
					),
				).toBe(false);
				await runtime.switchSession(sessionFile);
				recoveredRuntime = runtime;
				replayProviderCalls = () => faux.state.callCount;
			} else {
				const reopened = await createRuntimeForTest(() => {}, {
					cwd: tempDir,
					sessionManager: SessionManager.open(sessionFile),
				});
				recoveredRuntime = reopened.runtime;
				replayProviderCalls = () => reopened.faux.state.callCount;
			}
			expect(recoveredRuntime.recoverableDrafts).toContainEqual({
				queueItemId: queued.queueItemId,
				input: queuedInput,
			});
			const callsBeforeReplay = replayProviderCalls();
			await expect(
				recoveredRuntime.submitPrompt({ requestId: `request-stop-queued-${stopKind}`, ...queuedInput }),
			).resolves.toMatchObject({ operationId: queued.operationId, status: "existing" });
			expect(replayProviderCalls()).toBe(callsBeforeReplay);
			expect(
				reduceRuntimeJournal(recoveredRuntime.session.sessionManager.getDurableJournalSnapshot()).decisions,
			).toEqual([]);
		},
	);

	it("rejects a 257th durable operation before acceptance", async () => {
		let releaseProvider!: () => void;
		const providerGate = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest(() => {});
		runtime.session.agent.steeringMode = "all";
		faux.setResponses([
			async () => {
				await providerGate;
				return fauxAssistantMessage("done");
			},
			fauxAssistantMessage("queued batch done"),
		]);

		await runtime.submitPrompt({ requestId: "request-cap-direct", text: "start" });
		for (let index = 1; index < 256; index += 1) {
			await runtime.submitPrompt({
				requestId: `request-cap-${index}`,
				text: `queued ${index}`,
				streamingBehavior: "steer",
			});
		}
		await expect(
			runtime.submitPrompt({ requestId: "request-cap-rejected", text: "overflow", streamingBehavior: "steer" }),
		).rejects.toThrow("A durable runtime turn cannot contain more than 256 operations");
		expect(
			reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot()).operations.some(
				(operation) => operation.requestId === "request-cap-rejected",
			),
		).toBe(false);

		releaseProvider();
		await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
	}, 60_000);

	it("rejects an aggregate resident payload overflow before image IO or acceptance", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		const manager = runtime.session.sessionManager;
		const validateImages = vi.spyOn(manager, "validateDurableImageRefs").mockImplementation(() => {});
		vi.spyOn(manager, "resolveDurableImageRefs").mockImplementation((refs) =>
			refs.map((ref) => ({ type: "image", data: "", mimeType: ref.mimeType })),
		);
		faux.setResponses([fauxAssistantMessage("done")]);
		const fullImages = Array.from(
			{ length: Math.ceil(MAX_DURABLE_PROMPT_IMAGE_BYTES / MAX_DURABLE_IMAGE_BYTES) },
			(_, index) => ({
				type: "image_ref" as const,
				hash: index.toString(16).padStart(64, "0"),
				mimeType: "image/png",
				size: Math.min(MAX_DURABLE_IMAGE_BYTES, MAX_DURABLE_PROMPT_IMAGE_BYTES - index * MAX_DURABLE_IMAGE_BYTES),
			}),
		);

		const accepted = runtime.submitPrompt({
			requestId: "request-resident-full",
			text: "x".repeat(100),
			images: fullImages,
		});
		await expect(
			runtime.submitPrompt({
				requestId: "request-resident-overflow",
				text: "y".repeat(2 * 1024 * 1024),
				streamingBehavior: "followUp",
			}),
		).rejects.toThrow("resident bytes");
		expect(validateImages).toHaveBeenCalledTimes(1);
		expect(
			reduceRuntimeJournal(manager.getDurableJournalSnapshot()).operations.some(
				(operation) => operation.requestId === "request-resident-overflow",
			),
		).toBe(false);
		await accepted;
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
	});

	it("persists tool start and completion around one side effect", async () => {
		let toolRuns = 0;
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.registerTool({
				name: "side_effect",
				label: "Side effect",
				description: "Count one side effect",
				parameters: Type.Object({}),
				execute: async () => {
					toolRuns += 1;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			});
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("side_effect", {}, { id: "call-side-effect" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		const accepted = await runtime.submitPrompt({ requestId: "request-tool", text: "run" });
		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot());
			expect(reduced.operations.find((operation) => operation.operationId === accepted.operationId)?.state).toBe(
				"completed",
			);
		});
		expect(toolRuns).toBe(1);
		await runtime.submitPrompt({ requestId: "request-tool", text: "run" });
		expect(toolRuns).toBe(1);

		const entries = runtime.session.sessionManager.getDurableJournalSnapshot();
		const started = entries.findIndex(
			(entry) =>
				entry.type === "runtime_tool" && entry.toolCallId === "call-side-effect" && entry.state === "started",
		);
		const result = entries.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "call-side-effect",
		);
		const completed = entries.findIndex(
			(entry) =>
				entry.type === "runtime_tool" && entry.toolCallId === "call-side-effect" && entry.state === "completed",
		);
		expect(started).toBeGreaterThan(-1);
		expect(result).toBeGreaterThan(started);
		expect(completed).toBeGreaterThan(result);
	});

	it("rejects a tool call ID reused by a later agent continuation before persistence or execution", async () => {
		let queuedFollowUp = false;
		let toolRuns = 0;
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.registerTool({
				name: "continued_side_effect",
				label: "Continued side effect",
				description: "Count one side effect",
				parameters: Type.Object({}),
				execute: async () => {
					toolRuns += 1;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			});
			arcmind.on("agent_end", () => {
				if (queuedFollowUp) return;
				queuedFollowUp = true;
				arcmind.sendUserMessage("continue", { deliverAs: "followUp" });
			});
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("continued_side_effect", {}, { id: "call-reused" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("first run complete"),
			fauxAssistantMessage(fauxToolCall("continued_side_effect", {}, { id: "call-reused" }), {
				stopReason: "toolUse",
			}),
		]);

		const accepted = await runtime.submitPrompt({ requestId: "request-reused-tool-call", text: "run" });
		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot());
			expect(reduced.operations.find((operation) => operation.operationId === accepted.operationId)?.state).toBe(
				"interrupted",
			);
		});
		expect(faux.state.callCount).toBe(3);
		expect(toolRuns).toBe(1);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((content) => content.type === "toolCall" && content.id === "call-reused"),
				),
		).toHaveLength(1);
	});

	it.each(["user", "custom"] as const)(
		"keeps a durable turn active when an agent_end extension starts a second provider epoch with a %s follow-up",
		async (followUpKind) => {
			const tempDir = join(
				tmpdir(),
				`arcmind-runtime-epoch-${followUpKind}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			let queued = false;
			const extension: ExtensionFactory = (arcmind) => {
				arcmind.on("agent_end", () => {
					if (queued) return;
					queued = true;
					if (followUpKind === "user") {
						arcmind.sendUserMessage("continue", { deliverAs: "followUp" });
					} else {
						arcmind.sendMessage(
							{ customType: "continue", content: [{ type: "text", text: "continue" }], display: false },
							{ deliverAs: "followUp" },
						);
					}
				});
			};
			const { runtime: crashedRuntime, faux: crashedFaux } = await createRuntimeForTest(extension, {
				cwd: tempDir,
				disposeOnCleanup: false,
			});
			const crashError = new Error("simulated crash after continuation provider start");
			let crashed = false;
			crashedFaux.setResponses([
				fauxAssistantMessage("first complete"),
				async () => {
					crashed = true;
					throw crashError;
				},
			]);
			const manager = crashedRuntime.session.sessionManager;
			const appendControl = manager.appendRuntimeControl.bind(manager);
			const appendMessage = manager.appendMessage.bind(manager);
			const controlSpy = vi.spyOn(manager, "appendRuntimeControl").mockImplementation((payload) => {
				if (crashed) throw crashError;
				return appendControl(payload);
			});
			const messageSpy = vi.spyOn(manager, "appendMessage").mockImplementation((message, toolOutput, turnId) => {
				if (crashed) throw crashError;
				return appendMessage(message, toolOutput, turnId);
			});

			const request = { requestId: `request-epoch-${followUpKind}`, text: "start" };
			const accepted = await crashedRuntime.submitPrompt(request);
			await vi.waitFor(() => {
				expect(crashed).toBe(true);
				expect(crashedRuntime.diagnostics.some((diagnostic) => diagnostic.type === "error")).toBe(true);
			});
			const beforeRecovery = reduceRuntimeJournal(manager.getDurableJournalSnapshot());
			expect(
				beforeRecovery.operations.find((operation) => operation.operationId === accepted.operationId)?.state,
			).toBe("active");
			expect(beforeRecovery.decisions).toContainEqual({
				type: "interrupt_turn",
				turnId: accepted.turnId,
				reason: "server_restarted",
			});

			const providerRuns = crashedFaux.state.callCount;
			const sessionFile = manager.getSessionFile()!;
			controlSpy.mockRestore();
			messageSpy.mockRestore();
			crashedRuntime.session.disposeFromRuntime();
			const { runtime, faux } = await createRuntimeForTest(() => {}, {
				cwd: tempDir,
				sessionManager: SessionManager.open(sessionFile),
			});
			await expect(runtime.submitPrompt(request)).resolves.toMatchObject({
				operationId: accepted.operationId,
				status: "existing",
			});
			expect(crashedFaux.state.callCount).toBe(providerRuns);
			expect(faux.state.callCount).toBe(0);
			expect(reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot()).decisions).toEqual([]);
		},
	);

	it.each([
		{ label: "orphan ID", replacement: { toolCallId: "orphan-call" } },
		{ label: "changed name", replacement: { toolName: "renamed_side_effect" } },
		{ label: "malformed content", replacement: { content: [{ type: "unknown" }] } },
		{ label: "malformed addedToolNames", replacement: { addedToolNames: { length: 1 } } },
		{ label: "unknown top-level field", replacement: { unexpected: true } },
	])("rejects a post-extension tool result with $label before persistence", async ({ label, replacement }) => {
		let toolRuns = 0;
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.registerTool({
				name: "replaceable_side_effect",
				label: "Replaceable side effect",
				description: "Count one side effect",
				parameters: Type.Object({}),
				execute: async () => {
					toolRuns += 1;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			});
			arcmind.on("message_end", (event) => {
				if (event.message.role !== "toolResult") return;
				return { message: { ...event.message, ...replacement } as typeof event.message };
			});
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("replaceable_side_effect", {}, { id: "call-replaced-result" }), {
				stopReason: "toolUse",
			}),
		]);

		const accepted = await runtime.submitPrompt({ requestId: `request-result-${label}`, text: "run" });
		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot());
			expect(reduced.operations.find((operation) => operation.operationId === accepted.operationId)?.state).toBe(
				"interrupted",
			);
		});
		expect(toolRuns).toBe(1);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
				.every(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "call-replaced-result" &&
						entry.message.toolName === "replaceable_side_effect",
				),
		).toBe(true);
		if (label === "malformed addedToolNames") {
			const sessionFile = runtime.session.sessionFile!;
			await runtime.dispose();
			const reopened = await createRuntimeForTest(() => {}, {
				sessionManager: SessionManager.open(sessionFile),
			});
			expect(
				reduceRuntimeJournal(reopened.runtime.session.sessionManager.getDurableJournalSnapshot()).decisions,
			).toEqual([]);
		}
	});

	it.each([
		{ label: "an unknown content block", content: [{ type: "unknown" }] },
		{
			label: "duplicate tool call IDs",
			content: [
				fauxToolCall("unused", {}, { id: "call-extension-duplicate" }),
				fauxToolCall("unused", {}, { id: "call-extension-duplicate" }),
			],
		},
	])("rejects $label injected into assistant evidence after low-level validation", async ({ content }) => {
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				return {
					message: {
						...event.message,
						content,
					} as typeof event.message,
				};
			});
		});
		faux.setResponses([fauxAssistantMessage("valid before extension")]);

		const accepted = await runtime.submitPrompt({ requestId: "request-malformed-assistant", text: "run" });
		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot());
			expect(reduced.operations.find((operation) => operation.operationId === accepted.operationId)?.state).toBe(
				"interrupted",
			);
		});
		expect(
			runtime.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toBe(false);
	});

	it("blocks a tool side effect and repairs its result when the start marker fails", async () => {
		let toolRuns = 0;
		const { runtime, faux } = await createRuntimeForTest((arcmind) => {
			arcmind.registerTool({
				name: "blocked_side_effect",
				label: "Blocked side effect",
				description: "Must not run without a durable marker",
				parameters: Type.Object({}),
				execute: async () => {
					toolRuns += 1;
					return { content: [{ type: "text", text: "unexpected" }], details: {} };
				},
			});
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("blocked_side_effect", {}, { id: "call-marker-failure" }), {
				stopReason: "toolUse",
			}),
		]);
		const manager = runtime.session.sessionManager;
		const append = manager.appendRuntimeControl.bind(manager);
		let failToolStart = true;
		vi.spyOn(manager, "appendRuntimeControl").mockImplementation((payload) => {
			if (payload.type === "runtime_tool" && payload.state === "started" && failToolStart) {
				failToolStart = false;
				throw new Error("tool marker persistence failed");
			}
			return append(payload);
		});

		const accepted = await runtime.submitPrompt({ requestId: "request-marker-failure", text: "run" });
		await vi.waitFor(() => {
			const reduced = reduceRuntimeJournal(manager.getDurableJournalSnapshot());
			expect(reduced.operations.find((operation) => operation.operationId === accepted.operationId)?.state).toBe(
				"interrupted",
			);
		});
		expect(toolRuns).toBe(0);
		expect(
			manager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "call-marker-failure" &&
						entry.message.isError,
				),
		).toBe(true);
	});

	it("repairs an unfinished tool before session creation without replaying provider or tool", async () => {
		const tempDir = join(tmpdir(), `arcmind-runtime-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const manager = SessionManager.create(tempDir);
		const input = { text: "recover" } as const;
		const identity = identifySubmitPromptRequest("request-recovery-tool", input);
		manager.appendRuntimeControl({
			type: "runtime_operation",
			operationId: identity.operationId,
			requestId: identity.requestId,
			requestHash: identity.requestHash,
			kind: "turn",
			state: "accepted",
			turnId: identity.turnId,
			input,
		});
		manager.appendRuntimeControl({
			type: "runtime_turn",
			turnId: identity.turnId,
			operationIds: [identity.operationId],
			state: "started",
			consumedQueueItemIds: [],
		});
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("side_effect", {}, { id: "call-recovery" }), {
				stopReason: "toolUse",
			}),
			undefined,
			identity.turnId,
		);
		manager.appendRuntimeControl({
			type: "runtime_tool",
			turnId: identity.turnId,
			toolCallId: "call-recovery",
			toolName: "side_effect",
			state: "started",
		});
		const sessionFile = manager.getSessionFile()!;
		manager.close();

		let toolRuns = 0;
		const { runtime, faux } = await createRuntimeForTest(
			(arcmind) => {
				arcmind.registerTool({
					name: "side_effect",
					label: "Side effect",
					description: "Must not run during recovery",
					parameters: Type.Object({}),
					execute: async () => {
						toolRuns += 1;
						return { content: [{ type: "text", text: "unexpected" }], details: {} };
					},
				});
			},
			{ cwd: tempDir, sessionManager: SessionManager.open(sessionFile) },
		);

		expect(faux.state.callCount).toBe(0);
		expect(toolRuns).toBe(0);
		expect(reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot()).decisions).toEqual([]);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "call-recovery" &&
						entry.message.isError,
				),
		).toBe(true);
	});

	it.each([
		"accepted_only",
		"provider_start",
		"assistant_append",
		"tool_start",
		"tool_side_effect",
		"tool_result",
		"operation_finish",
	] as const)("reopens a fault injected at %s without replaying provider or tool work", async (crashPoint) => {
		const tempDir = join(
			tmpdir(),
			`arcmind-runtime-crash-${crashPoint}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		let crashed = false;
		let toolRuns = 0;
		const crashError = new Error(`simulated process crash at ${crashPoint}`);
		const registerCrashTool: ExtensionFactory = (arcmind) => {
			arcmind.registerTool({
				name: "crash_side_effect",
				label: "Crash side effect",
				description: "Must not replay after reopen",
				parameters: Type.Object({}),
				execute: async () => {
					toolRuns += 1;
					if (crashPoint === "tool_side_effect") crashed = true;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			});
		};
		const { runtime: crashedRuntime, faux: crashedFaux } = await createRuntimeForTest(registerCrashTool, {
			cwd: tempDir,
			disposeOnCleanup: false,
		});
		crashedFaux.setResponses([
			async () => {
				if (crashPoint === "provider_start") {
					crashed = true;
					throw crashError;
				}
				return fauxAssistantMessage(fauxToolCall("crash_side_effect", {}, { id: "call-crash-matrix" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);

		const manager = crashedRuntime.session.sessionManager;
		const appendControl = manager.appendRuntimeControl.bind(manager);
		const appendMessage = manager.appendMessage.bind(manager);
		const controlSpy = vi.spyOn(manager, "appendRuntimeControl").mockImplementation((payload) => {
			if (crashed) throw crashError;
			if (crashPoint === "accepted_only" && payload.type === "runtime_turn" && payload.state === "started") {
				crashed = true;
				throw crashError;
			}
			if (crashPoint === "tool_start" && payload.type === "runtime_tool" && payload.state === "started") {
				appendControl(payload);
				crashed = true;
				throw crashError;
			}
			if (
				crashPoint === "operation_finish" &&
				payload.type === "runtime_operation" &&
				payload.state === "completed"
			) {
				appendControl(payload);
				crashed = true;
				throw crashError;
			}
			return appendControl(payload);
		});
		const messageSpy = vi.spyOn(manager, "appendMessage").mockImplementation((message, toolOutput, turnId) => {
			if (crashed) throw crashError;
			if (crashPoint === "assistant_append" && message.role === "assistant") {
				appendMessage(message, toolOutput, turnId);
				crashed = true;
				throw crashError;
			}
			if (crashPoint === "tool_result" && message.role === "toolResult") {
				appendMessage(message, toolOutput, turnId);
				crashed = true;
				throw crashError;
			}
			return appendMessage(message, toolOutput, turnId);
		});

		const request = { requestId: `request-crash-${crashPoint}`, text: "run after crash" };
		const identity = identifySubmitPromptRequest(request.requestId, { text: request.text });
		const firstSubmission = crashedRuntime.submitPrompt(request);
		if (crashPoint === "accepted_only") await expect(firstSubmission).rejects.toThrow();
		else
			await expect(firstSubmission).resolves.toMatchObject({
				operationId: identity.operationId,
				status: "accepted",
			});
		await vi.waitFor(() => {
			expect(crashed).toBe(true);
			expect(crashedRuntime.diagnostics.some((diagnostic) => diagnostic.type === "error")).toBe(true);
		});

		const firstProviderRuns = crashedFaux.state.callCount;
		const firstToolRuns = toolRuns;
		const sessionFile = manager.getSessionFile()!;
		controlSpy.mockRestore();
		messageSpy.mockRestore();
		crashedRuntime.session.disposeFromRuntime();

		const { runtime, faux } = await createRuntimeForTest(
			(arcmind) => {
				registerCrashTool(arcmind);
			},
			{ cwd: tempDir, sessionManager: SessionManager.open(sessionFile) },
		);

		await expect(runtime.submitPrompt(request)).resolves.toMatchObject({
			operationId: identity.operationId,
			status: "existing",
		});
		expect(crashedFaux.state.callCount).toBe(firstProviderRuns);
		expect(faux.state.callCount).toBe(0);
		expect(toolRuns).toBe(firstToolRuns);
		expect(reduceRuntimeJournal(runtime.session.sessionManager.getDurableJournalSnapshot()).decisions).toEqual([]);
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((arcmind: ExtensionAPI) => {
			arcmind.on("session_before_switch", (event) => {
				events.push(event);
			});
			arcmind.on("session_shutdown", (event) => {
				events.push(event);
			});
			arcmind.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
		]);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((arcmind: ExtensionAPI) => {
			arcmind.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			arcmind.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `arcmind-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((arcmind: ExtensionAPI) => {
			arcmind.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			arcmind.on("session_shutdown", (event) => {
				events.push(event);
			});
			arcmind.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const filesBeforeFork = new Set(readdirSync(sessionDir));

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.sessionId}`)).toBe(true);
		expect(
			readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl") && !filesBeforeFork.has(file)),
		).toHaveLength(1);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const previousSessionManager = runtime.session.sessionManager;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(runtime.session.sessionManager).not.toBe(previousSessionManager);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(
			tmpdir(),
			`arcmind-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(arcmind: ExtensionAPI) => {
						arcmind.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		const previousSessionManager = runtime.session.sessionManager;
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(runtime.session.sessionManager).not.toBe(previousSessionManager);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("reopens the current session without competing with its own writer lease", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const previousSession = runtime.session;
		const sessionFile = previousSession.sessionFile!;

		await expect(runtime.switchSession(sessionFile)).resolves.toEqual({ cancelled: false });

		expect(runtime.session).not.toBe(previousSession);
		expect(runtime.session.sessionFile).toBe(sessionFile);
		expect(runtime.session.messages.some((message) => message.role === "user")).toBe(true);
	});

	it("restores the current session when reopening it fails", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const previousSession = runtime.session;
		const sessionFile = previousSession.sessionFile!;
		const createRuntime = vi
			.spyOn(runtime as unknown as { createRuntime: CreateAgentSessionRuntimeFactory }, "createRuntime")
			.mockRejectedValueOnce(new Error("factory failed"));

		try {
			await expect(runtime.switchSession(sessionFile)).rejects.toThrow("factory failed");

			expect(runtime.session).not.toBe(previousSession);
			expect(runtime.session.sessionFile).toBe(sessionFile);
			expect(runtime.session.messages.some((message) => message.role === "user")).toBe(true);
			await expect(runtime.session.prompt("after rollback")).resolves.toBeUndefined();
			await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
		} finally {
			createRuntime.mockRestore();
		}
	});

	it("enters a terminal state when reopening and rollback both fail", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const sessionFile = runtime.session.sessionFile!;
		const createRuntime = vi
			.spyOn(runtime as unknown as { createRuntime: CreateAgentSessionRuntimeFactory }, "createRuntime")
			.mockRejectedValueOnce(new Error("replacement failed"))
			.mockRejectedValueOnce(new Error("rollback failed"));

		try {
			const replacement = runtime.switchSession(sessionFile);
			const queuedReplacement = runtime.newSession();
			await expect(replacement).rejects.toThrow(
				"Agent session runtime is unusable after replacement and rollback failed",
			);
			await expect(queuedReplacement).rejects.toThrow(
				"Agent session runtime is unusable after replacement and rollback failed",
			);
			expect(() => runtime.session).toThrow(
				"Agent session runtime is unusable after replacement and rollback failed",
			);
			await expect(runtime.newSession()).rejects.toThrow(
				"Agent session runtime is unusable after replacement and rollback failed",
			);
		} finally {
			createRuntime.mockRestore();
		}
	});

	it("imports the current session in place without truncating it", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const sessionFile = runtime.session.sessionFile!;
		const beforeImport = readFileSync(sessionFile, "utf8");

		await expect(runtime.importFromJsonl(sessionFile)).resolves.toEqual({ cancelled: false });

		expect(readFileSync(sessionFile, "utf8")).toBe(beforeImport);
		expect(runtime.session.messages.some((message) => message.role === "user")).toBe(true);
	});

	it("keeps the prepared candidate usable when replacement invalidation fails", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const previousSession = runtime.session;
		const previousSessionFile = previousSession.sessionFile!;
		runtime.setBeforeSessionInvalidate(() => {
			throw new Error("invalidation failed: sensitive-value");
		});

		await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
		runtime.setBeforeSessionInvalidate(undefined);

		expect(runtime.session).not.toBe(previousSession);
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(runtime.diagnostics).toContainEqual({
			type: "warning",
			message: "The previous session did not shut down cleanly; the replacement session is active.",
		});
		expect(JSON.stringify(runtime.diagnostics)).not.toContain("sensitive-value");
		const reopened = SessionManager.open(previousSessionFile);
		reopened.close();
		await expect(runtime.session.prompt("after invalidation failure")).resolves.toBeUndefined();
		await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
	});

	it("keeps the current runtime usable when replacement creation fails", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const previousSession = runtime.session;
		const close = vi.spyOn(SessionManager.prototype, "close");
		const createRuntime = vi
			.spyOn(runtime as unknown as { createRuntime: CreateAgentSessionRuntimeFactory }, "createRuntime")
			.mockRejectedValueOnce(new Error("factory failed"));

		try {
			await expect(runtime.newSession()).rejects.toThrow("factory failed");

			expect(runtime.session).toBe(previousSession);
			expect(close).toHaveBeenCalledOnce();
			await expect(runtime.session.prompt("after factory failure")).resolves.toBeUndefined();
			await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
		} finally {
			createRuntime.mockRestore();
			close.mockRestore();
		}
	});

	it("rejects a post-commit setup failure after rebinding the new session", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const previousSession = runtime.session;
		let reboundSession = previousSession;
		runtime.setRebindSession(async (session) => {
			reboundSession = session;
			await session.bindExtensions({});
		});

		await expect(
			runtime.newSession({
				setup: async () => {
					throw new Error("setup failed");
				},
			}),
		).rejects.toThrow("setup failed");

		expect(runtime.session).not.toBe(previousSession);
		expect(reboundSession).toBe(runtime.session);
		expect(runtime.diagnostics).not.toContainEqual({
			type: "warning",
			message: "The previous session did not shut down cleanly; the replacement session is active.",
		});
		await expect(runtime.session.prompt("after setup failure")).resolves.toBeUndefined();
	});

	it("rejects a post-commit withSession failure while keeping the new session usable", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const previousSession = runtime.session;
		let rebound = false;
		let withSessionSawRebind = false;
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({});
			rebound = true;
		});

		await expect(
			runtime.newSession({
				withSession: async () => {
					withSessionSawRebind = rebound;
					throw new Error("withSession failed");
				},
			}),
		).rejects.toThrow("withSession failed");

		expect(withSessionSawRebind).toBe(true);
		expect(runtime.session).not.toBe(previousSession);
		await expect(runtime.session.prompt("after withSession failure")).resolves.toBeUndefined();
	});

	it("retries initial session cleanup when runtime creation fails", async () => {
		const tempDir = join(tmpdir(), `arcmind-runtime-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const sessionFile = sessionManager.getSessionFile()!;
		const originalClose = sessionManager.close.bind(sessionManager);
		const close = vi
			.spyOn(sessionManager, "close")
			.mockImplementationOnce(() => {
				throw new Error("transient close failure");
			})
			.mockImplementation(originalClose);

		await expect(
			createAgentSessionRuntime(
				async () => {
					throw new Error("factory failed");
				},
				{ cwd: tempDir, agentDir: tempDir, sessionManager },
			),
		).rejects.toThrow("factory failed");
		expect(close).toHaveBeenCalledTimes(2);
		close.mockRestore();
		const reopened = SessionManager.open(sessionFile);
		reopened.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("closes an initial session manager when cwd validation fails", async () => {
		const tempDir = join(
			tmpdir(),
			`arcmind-runtime-cwd-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		const missingCwd = join(tempDir, "missing");
		const sessionManager = SessionManager.create(missingCwd, join(tempDir, "sessions"));
		const close = vi.spyOn(sessionManager, "close");

		await expect(
			createAgentSessionRuntime(
				async () => {
					throw new Error("factory should not run");
				},
				{ cwd: tempDir, agentDir: tempDir, sessionManager },
			),
		).rejects.toThrow("Stored session working directory does not exist");
		expect(close).toHaveBeenCalledOnce();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("releases the current writer lease when final invalidation fails", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
		cleanups.pop();
		const sessionFile = runtime.session.sessionFile!;
		runtime.setBeforeSessionInvalidate(() => {
			throw new Error("invalidation failed");
		});

		await expect(runtime.dispose()).rejects.toThrow("invalidation failed");
		runtime.setBeforeSessionInvalidate(undefined);

		const reopened = SessionManager.open(sessionFile);
		reopened.close();
		faux.unregister();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("disposes the runtime only once", async () => {
		let shutdownCount = 0;
		const { runtime } = await createRuntimeForTest((arcmind) => {
			arcmind.on("session_shutdown", () => {
				shutdownCount++;
			});
		});

		await Promise.all([runtime.dispose(), runtime.dispose()]);
		await runtime.dispose();

		expect(shutdownCount).toBe(1);
	});

	it("fails closed public runtime access once disposal is requested", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const sessionFile = runtime.session.sessionFile!;
		const disposal = runtime.dispose();

		expect(() => runtime.session).toThrow("Agent session runtime is disposing or disposed");
		expect(() => runtime.services).toThrow("Agent session runtime is disposing or disposed");
		expect(() => runtime.cwd).toThrow("Agent session runtime is disposing or disposed");
		expect(() => runtime.session.prompt("after dispose")).toThrow("Agent session runtime is disposing or disposed");
		await expect(disposal).resolves.toBeUndefined();
		expect(() => runtime.session).toThrow("Agent session runtime is disposing or disposed");

		const reopened = SessionManager.open(sessionFile);
		reopened.close();
	});

	it("serializes concurrent session replacements without leaking writer leases", async () => {
		let shutdownCount = 0;
		const { runtime } = await createRuntimeForTest((arcmind) => {
			arcmind.on("session_shutdown", () => {
				shutdownCount++;
			});
		});
		const sessionDir = runtime.session.sessionManager.getSessionDir();

		await Promise.all([runtime.newSession(), runtime.newSession()]);

		expect(shutdownCount).toBe(2);
		const sessionFiles = readdirSync(sessionDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(sessionDir, file));
		expect(sessionFiles).toHaveLength(3);

		await runtime.dispose();
		for (const sessionFile of sessionFiles) {
			const reopened = SessionManager.open(sessionFile);
			reopened.close();
		}
	});

	it("waits for an accepted replacement before disposing and rejects later replacements", async () => {
		let shutdownCount = 0;
		const { runtime } = await createRuntimeForTest((arcmind) => {
			arcmind.on("session_shutdown", () => {
				shutdownCount++;
			});
		});

		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const replacement = runtime.newSession();
		const disposal = runtime.dispose();
		await expect(replacement).resolves.toEqual({ cancelled: false });
		await expect(disposal).resolves.toBeUndefined();

		expect(shutdownCount).toBe(2);
		await expect(runtime.newSession()).rejects.toThrow("Agent session runtime is disposing or disposed");
		for (const file of readdirSync(sessionDir).filter((entry) => entry.endsWith(".jsonl"))) {
			const reopened = SessionManager.open(join(sessionDir, file));
			reopened.close();
		}
	});

	it.each(["new", "switch", "quit"] as const)(
		"persists an active awaited message_end before %s releases the writer lease",
		async (action) => {
			let releaseMessageEnd!: () => void;
			let markMessageEndStarted!: () => void;
			const messageEndStarted = new Promise<void>((resolve) => {
				markMessageEndStarted = resolve;
			});
			const messageEndGate = new Promise<void>((resolve) => {
				releaseMessageEnd = resolve;
			});
			let blocked = false;
			const { runtime, tempDir } = await createRuntimeForTest((arcmind) => {
				arcmind.on("message_end", async (event) => {
					if (blocked || event.message.role !== "assistant") return;
					blocked = true;
					markMessageEndStarted();
					await messageEndGate;
				});
			});
			const previousManager = runtime.session.sessionManager;
			const previousSessionFile = runtime.session.sessionFile!;
			let markManagerClosed!: () => void;
			const managerClosed = new Promise<void>((resolve) => {
				markManagerClosed = resolve;
			});
			const originalClose = previousManager.close.bind(previousManager);
			const close = vi.spyOn(previousManager, "close").mockImplementation(() => {
				markManagerClosed();
				originalClose();
			});

			let switchTarget: SessionManager | undefined;
			if (action === "switch") {
				switchTarget = SessionManager.create(tempDir, join(tempDir, "switch-target"));
				switchTarget.close();
			}

			const prompt = runtime.session.prompt("hello");
			await messageEndStarted;
			const lifecycle: Promise<unknown> =
				action === "new"
					? runtime.newSession()
					: action === "switch"
						? runtime.switchSession(switchTarget!.getSessionFile()!)
						: runtime.dispose();
			const closedBeforeDrain = await Promise.race([
				managerClosed.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
			]);
			releaseMessageEnd();
			const [promptResult, lifecycleResult] = await Promise.allSettled([prompt, lifecycle]);

			expect(closedBeforeDrain).toBe(false);
			expect(promptResult.status).toBe("fulfilled");
			expect(lifecycleResult.status).toBe("fulfilled");
			close.mockRestore();
			const reopened = SessionManager.open(previousSessionFile);
			expect(
				reopened
					.getEntries()
					.filter((entry) => entry.type === "message")
					.some((entry) => entry.message.role === "assistant"),
			).toBe(true);
			reopened.close();
		},
	);

	it("keeps the prepared candidate usable when persistence fails during new", async () => {
		let releaseMessageEnd!: () => void;
		let markMessageEndStarted!: () => void;
		const messageEndStarted = new Promise<void>((resolve) => {
			markMessageEndStarted = resolve;
		});
		const messageEndGate = new Promise<void>((resolve) => {
			releaseMessageEnd = resolve;
		});
		let blocked = false;
		let shutdownCount = 0;
		const { runtime } = await createRuntimeForTest((arcmind) => {
			arcmind.on("message_end", async (event) => {
				if (blocked || event.message.role !== "assistant") return;
				blocked = true;
				markMessageEndStarted();
				await messageEndGate;
			});
			arcmind.on("session_shutdown", () => {
				shutdownCount++;
			});
		});
		const previousManager = runtime.session.sessionManager;
		const previousSessionFile = runtime.session.sessionFile!;
		const sessionDir = previousManager.getSessionDir();
		const filesBefore = new Set(readdirSync(sessionDir));
		const originalAppendMessage = previousManager.appendMessage.bind(previousManager);
		const appendMessage = vi.spyOn(previousManager, "appendMessage").mockImplementation((message, toolOutput) => {
			if (message.role === "assistant") throw new Error("persistence failed");
			return originalAppendMessage(message, toolOutput);
		});

		const prompt = runtime.session.prompt("hello");
		await messageEndStarted;
		const replacement = runtime.newSession();
		releaseMessageEnd();
		const [promptResult, replacementResult] = await Promise.allSettled([prompt, replacement]);

		expect(promptResult.status).toBe("rejected");
		if (promptResult.status === "fulfilled") throw new Error("prompt unexpectedly succeeded");
		expect(errorTreeIncludesMessage(promptResult.reason, "persistence failed")).toBe(true);
		expect(replacementResult).toEqual({ status: "fulfilled", value: { cancelled: false } });
		appendMessage.mockRestore();
		const candidateFile = readdirSync(sessionDir).find((file) => file.endsWith(".jsonl") && !filesBefore.has(file))!;
		expect(runtime.session.sessionFile).toBe(join(sessionDir, candidateFile));
		expect(runtime.diagnostics).toContainEqual({
			type: "warning",
			message: "The previous session did not shut down cleanly; the replacement session is active.",
		});
		const reopened = SessionManager.open(previousSessionFile);
		reopened.close();
		await expect(runtime.session.prompt("after persistence failure")).resolves.toBeUndefined();
		expect(shutdownCount).toBe(1);
		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(shutdownCount).toBe(2);
	});

	it("releases the current lease after a quit persistence failure without repeating shutdown", async () => {
		let releaseMessageEnd!: () => void;
		let markMessageEndStarted!: () => void;
		const messageEndStarted = new Promise<void>((resolve) => {
			markMessageEndStarted = resolve;
		});
		const messageEndGate = new Promise<void>((resolve) => {
			releaseMessageEnd = resolve;
		});
		let blocked = false;
		let shutdownCount = 0;
		const { runtime } = await createRuntimeForTest((arcmind) => {
			arcmind.on("message_end", async (event) => {
				if (blocked || event.message.role !== "assistant") return;
				blocked = true;
				markMessageEndStarted();
				await messageEndGate;
			});
			arcmind.on("session_shutdown", () => {
				shutdownCount++;
			});
		});
		const sessionManager = runtime.session.sessionManager;
		const sessionFile = runtime.session.sessionFile!;
		const originalAppendMessage = sessionManager.appendMessage.bind(sessionManager);
		const appendMessage = vi.spyOn(sessionManager, "appendMessage").mockImplementation((message, toolOutput) => {
			if (message.role === "assistant") throw new Error("persistence failed");
			return originalAppendMessage(message, toolOutput);
		});

		const prompt = runtime.session.prompt("hello");
		await messageEndStarted;
		const disposal = runtime.dispose();
		releaseMessageEnd();
		const [, disposalResult] = await Promise.allSettled([prompt, disposal]);

		expect(disposalResult.status).toBe("rejected");
		if (disposalResult.status === "fulfilled") throw new Error("disposal unexpectedly succeeded");
		expect(errorTreeIncludesMessage(disposalResult.reason, "persistence failed")).toBe(true);
		appendMessage.mockRestore();
		const reopened = SessionManager.open(sessionFile);
		reopened.close();
		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(shutdownCount).toBe(1);
	});

	it("rejects a reentrant lifecycle wait from message_end without deadlocking persistence", async () => {
		let runtime!: AgentSessionRuntime;
		let attempted = false;
		const fixture = await createRuntimeForTest((arcmind) => {
			arcmind.on("message_end", async (event) => {
				if (attempted || event.message.role !== "assistant") return;
				attempted = true;
				await runtime.newSession();
			});
		});
		runtime = fixture.runtime;
		const previousSessionFile = runtime.session.sessionFile!;
		const extensionErrors: string[] = [];
		const unsubscribeError = runtime.session.extensionRunner.onError((error) => extensionErrors.push(error.error));
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			await Promise.race([
				runtime.session.prompt("hello"),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error("reentrant lifecycle wait deadlocked")), 500);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
			unsubscribeError();
		}

		expect(runtime.session.sessionFile).toBe(previousSessionFile);
		expect(extensionErrors).toContain(
			"Session lifecycle changes cannot be awaited from an agent event handler before message persistence completes",
		);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.some((entry) => entry.message.role === "assistant"),
		).toBe(true);
	});

	it("rejects a reentrant lifecycle wait from session_before_switch without deadlocking", async () => {
		let runtime!: AgentSessionRuntime;
		let attempted = false;
		const fixture = await createRuntimeForTest((arcmind) => {
			arcmind.on("session_before_switch", async () => {
				if (attempted) return;
				attempted = true;
				await runtime.newSession();
			});
		});
		runtime = fixture.runtime;
		const extensionErrors: string[] = [];
		const unsubscribeError = runtime.session.extensionRunner.onError((error) => extensionErrors.push(error.error));
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			await Promise.race([
				runtime.newSession(),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error("reentrant lifecycle wait deadlocked")), 500);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
			unsubscribeError();
		}

		expect(extensionErrors).toContain(
			"Session lifecycle changes cannot be awaited from within another lifecycle operation",
		);
	});

	it("rejects a reentrant dispose from session_shutdown without deadlocking", async () => {
		let runtime!: AgentSessionRuntime;
		let attempted = false;
		const fixture = await createRuntimeForTest((arcmind) => {
			arcmind.on("session_shutdown", async () => {
				if (attempted) return;
				attempted = true;
				await runtime.dispose();
			});
		});
		runtime = fixture.runtime;
		const extensionErrors: string[] = [];
		const unsubscribeError = runtime.session.extensionRunner.onError((error) => extensionErrors.push(error.error));
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			await Promise.race([
				runtime.dispose(),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error("reentrant dispose deadlocked")), 500);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
			unsubscribeError();
		}

		expect(extensionErrors).toContain(
			"Session lifecycle changes cannot be awaited from within another lifecycle operation",
		);
	});

	it("rejects a reentrant lifecycle wait from withSession without deadlocking", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			await expect(
				Promise.race([
					runtime.newSession({
						withSession: async () => {
							await runtime.newSession();
						},
					}),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error("reentrant lifecycle wait deadlocked")), 500);
					}),
				]),
			).rejects.toThrow("Session lifecycle changes cannot be awaited from within another lifecycle operation");
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	});

	it("retries a failed manager close without repeating shutdown hooks", async () => {
		let shutdownCount = 0;
		const { runtime } = await createRuntimeForTest((arcmind) => {
			arcmind.on("session_shutdown", () => {
				shutdownCount++;
			});
		});
		const sessionFile = runtime.session.sessionFile!;
		const sessionManager = runtime.session.sessionManager;
		const close = vi.spyOn(sessionManager, "close").mockImplementationOnce(() => {
			throw new Error("transient close failure");
		});

		await expect(runtime.dispose()).rejects.toThrow("transient close failure");
		await expect(runtime.dispose()).resolves.toBeUndefined();

		expect(shutdownCount).toBe(1);
		expect(close).toHaveBeenCalledTimes(2);
		close.mockRestore();
		const reopened = SessionManager.open(sessionFile);
		reopened.close();
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `arcmind-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `arcmind-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(arcmind: ExtensionAPI) => {
						arcmind.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir),
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await expect(runtime.switchSession(otherSessionFile)).rejects.toMatchObject({ code: "SESSION_IN_USE" });
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(firstDir));

		await otherRuntime.dispose();

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(arcmind: ExtensionAPI) => {
						arcmind.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir),
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;
		await otherRuntime.dispose();

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
