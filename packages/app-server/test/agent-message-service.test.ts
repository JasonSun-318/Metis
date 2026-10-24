import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ClientParams } from "@metis/app-protocol";
import { AgentStore, type FileEntry, SessionManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgentMessage } from "../src/agent-message-service.ts";
import { opaqueId } from "../src/item-projection.ts";
import { AppServerError } from "../src/session-runtime-host.ts";

const ROOT_ID = "00000000-0000-4000-8000-000000000010";
const CHILD_ID = "00000000-0000-4000-8000-000000000101";
const TASK_ID = "00000000-0000-4000-8000-000000000102";
const REQUEST_ID = "00000000-0000-4000-8000-000000000103";
const ROLLBACK_REQUEST_ID = "00000000-0000-4000-8000-000000000104";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type SendInput = ClientParams<"agent/send">["input"];
type AgentConfig = Parameters<AgentStore["create"]>[0];

interface Fixture {
	readonly projectDir: string;
	readonly agentDir: string;
	readonly childUserEntryId: string;
	readonly childAssistantEntryId: string;
	readonly rootUserEntryId: string;
	readonly journal: readonly FileEntry[];
	readonly context: { readonly agentDir: string; readonly cwd: string; readonly journal: readonly FileEntry[] };
}

function appendAssistant(manager: SessionManager, text: string): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "metis-agent-message-service-"));
	temporaryRoots.push(root);
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(projectDir);
	mkdirSync(agentDir);
	const sessionsRoot = join(agentDir, "sessions");
	const manager = SessionManager.create(projectDir, sessionsRoot, {
		id: ROOT_ID,
		mode: "code",
		permissionPreset: "full",
	});
	const store = new AgentStore(manager, agentDir);
	const config: AgentConfig = {
		agentId: CHILD_ID,
		name: "Worker",
		agentType: "worker",
		initialTask: "Handle the child conversation",
		tools: ["read"],
		writePolicy: "inherit",
		permissionPreset: "full",
		model: { provider: "fixture", modelId: "fixture-model" },
		thinkingLevel: "off",
		cwd: projectDir,
		forkTurns: 0,
		timeoutSeconds: 60,
		mayDelegate: false,
		parentSessionId: ROOT_ID,
		rootSessionId: ROOT_ID,
		agentPath: [CHILD_ID],
		mode: "code",
	};
	const child = store.create(config, [], TASK_ID);

	const childManager = SessionManager.open(child.path);
	let childUserEntryId: string;
	let childAssistantEntryId: string;
	try {
		childUserEntryId = childManager.appendMessage({
			role: "user",
			content: "child-owned-message",
			timestamp: Date.now(),
		});
		childAssistantEntryId = appendAssistant(childManager, "child-owned-answer");
	} finally {
		childManager.close();
	}
	const rootUserEntryId = manager.appendMessage({
		role: "user",
		content: "root-owned-message",
		timestamp: Date.now(),
	});
	const journal = store.readJournal(CHILD_ID);
	manager.close();
	return {
		projectDir,
		agentDir,
		childUserEntryId,
		childAssistantEntryId,
		rootUserEntryId,
		journal,
		context: { agentDir, cwd: projectDir, journal },
	};
}

function sendInput(
	overrides: { readonly requestId?: string; readonly input?: Partial<SendInput> } = {},
): ClientParams<"agent/send"> {
	return {
		sessionId: ROOT_ID,
		agentId: CHILD_ID,
		requestId: overrides.requestId ?? REQUEST_ID,
		input: {
			text: "Continue",
			...overrides.input,
		},
	};
}

async function expectAppError(promise: Promise<unknown>, code: "NOT_FOUND"): Promise<void> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(AppServerError);
	expect((caught as AppServerError).code).toBe(code);
}

describe("agent message preparation", () => {
	it("resolves quotes only against the selected child's own message journal", async () => {
		const fixture = createFixture();
		const validQuote = {
			sourceItemId: opaqueId(fixture.childUserEntryId, "item"),
			sourceRole: "user" as const,
			selectedText: "child selected context",
		};
		const prepared = await prepareAgentMessage(
			sendInput({ input: { text: "Explain this", conversationQuotes: [validQuote] } }),
			fixture.context,
		);
		expect(prepared.input.text.startsWith("Explain this")).toBe(true);
		expect(prepared.input.text).toContain("conversation_quotes");
		expect(prepared.input.text).toContain("child selected context");
		expect(prepared.input.images).toBeUndefined();

		const assistantQuote = {
			...validQuote,
			sourceItemId: opaqueId(fixture.childAssistantEntryId, "item"),
			sourceRole: "assistant" as const,
			selectedText: "child answer context",
		};
		const preparedAssistant = await prepareAgentMessage(
			sendInput({ input: { text: "Use the answer", conversationQuotes: [assistantQuote] } }),
			fixture.context,
		);
		expect(preparedAssistant.input.text).toContain("child answer context");

		await expectAppError(
			prepareAgentMessage(
				sendInput({
					input: {
						text: "Use root context",
						conversationQuotes: [{ ...validQuote, sourceItemId: opaqueId(fixture.rootUserEntryId, "item") }],
					},
				}),
				fixture.context,
			),
			"NOT_FOUND",
		);
		await expectAppError(
			prepareAgentMessage(
				sendInput({
					input: {
						text: "Use a mismatched role",
						conversationQuotes: [
							{
								...validQuote,
								sourceItemId: opaqueId(fixture.childAssistantEntryId, "item"),
								sourceRole: "user",
							},
						],
					},
				}),
				fixture.context,
			),
			"NOT_FOUND",
		);
	});

	it("keeps image hashes and sizes in DurablePromptInput form", async () => {
		const fixture = createFixture();
		const firstHash = "a".repeat(64);
		const secondHash = "b".repeat(64);
		const prepared = await prepareAgentMessage(
			sendInput({
				input: {
					text: "Inspect the images",
					images: [
						{ hash: firstHash, mediaType: "image/png", byteLength: 1234 },
						{ hash: secondHash, mediaType: "image/webp", byteLength: 5678 },
					],
				},
			}),
			fixture.context,
		);
		expect(prepared.input).toEqual({
			text: "Inspect the images",
			images: [
				{ type: "image_ref", hash: firstHash, mimeType: "image/png", size: 1234 },
				{ type: "image_ref", hash: secondHash, mimeType: "image/webp", size: 5678 },
			],
		});
	});

	it("rolls back only files imported by the failed request", async () => {
		const fixture = createFixture();
		const existingSource = join(fixture.projectDir, "existing.txt");
		const newSource = join(fixture.projectDir, "new.txt");
		const rollbackSource = join(fixture.projectDir, "rollback.txt");
		writeFileSync(existingSource, "existing");
		writeFileSync(newSource, "new");
		writeFileSync(rollbackSource, "rollback");

		const first = await prepareAgentMessage(
			sendInput({ input: { text: "Attach existing", attachments: [{ path: existingSource }] } }),
			fixture.context,
		);
		const existingBlock = /<attachments>\n([\s\S]*?)\n<\/attachments>/u.exec(first.input.text);
		expect(existingBlock).not.toBeNull();
		const existingAttachments = JSON.parse(existingBlock![1]!) as Array<{
			readonly name: string;
			readonly path: string;
			readonly size: number;
		}>;
		const existing = existingAttachments[0]!;
		expect(existing).toMatchObject({ name: "existing.txt", size: 8 });
		expect(existsSync(existing.path)).toBe(true);
		const attachmentDirectory = dirname(existing.path);

		await expect(
			prepareAgentMessage(
				sendInput({
					input: {
						text: "Fail after importing a new file",
						attachments: [
							{ path: existingSource },
							{ path: newSource },
							{ path: join(fixture.projectDir, "missing.txt") },
						],
					},
				}),
				fixture.context,
			),
		).rejects.toThrow();
		expect(existsSync(existing.path)).toBe(true);
		expect(readdirSync(attachmentDirectory).sort()).toEqual([basename(existing.path)]);

		const rollbackPrepared = await prepareAgentMessage(
			sendInput({
				requestId: ROLLBACK_REQUEST_ID,
				input: { text: "Rollback new file", attachments: [{ path: rollbackSource }] },
			}),
			fixture.context,
		);
		const rollbackBlock = /<attachments>\n([\s\S]*?)\n<\/attachments>/u.exec(rollbackPrepared.input.text);
		expect(rollbackBlock).not.toBeNull();
		const rollbackAttachments = JSON.parse(rollbackBlock![1]!) as Array<{ readonly path: string }>;
		const rollbackPath = rollbackAttachments[0]!.path;
		expect(existsSync(rollbackPath)).toBe(true);
		rollbackPrepared.rollback();
		expect(existsSync(rollbackPath)).toBe(false);
		expect(existsSync(existing.path)).toBe(true);
	});
});
