import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { compileSchema, type DomainEvent, DomainEventSchema } from "@metis/app-protocol";
import {
	type AgentSession,
	type AgentSessionEvent,
	importSessionAttachments,
	SessionManager,
} from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import { AgentLiveProjector } from "../src/agent-live-projector.ts";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";
import { projectLiveMessage, projectMessageEntry } from "../src/item-projection.ts";

const date = "2026-11-05T12:00:00.000Z";
const image = {
	fileId: "0123456789abcdef",
	name: "generated.png",
	byteLength: 120,
	deliveredAt: date,
	mediaType: "image/png",
	width: 1024,
	height: 1024,
	continuation: {
		api: "google-interactions",
		modelId: "test-model",
		baseUrl: "https://example.test",
		interactionId: "private-continuation",
	},
};
const details = {
	kind: "image_generation",
	status: "generating",
	requestedCount: 2,
	images: [image],
	aspectRatio: "1:1",
};
const message = {
	role: "toolResult" as const,
	toolCallId: "image-call",
	toolName: "image_generate",
	content: [{ type: "text" as const, text: "Generated one image" }],
	details,
	isError: false,
	timestamp: Date.parse(date),
};
const update = {
	type: "tool_execution_update" as const,
	toolCallId: message.toolCallId,
	toolName: message.toolName,
	args: { prompt: "a robot", count: 2 },
	partialResult: { content: message.content, details },
};

describe("image generation projection", () => {
	it("restores the same image metadata from history without exposing vendor continuation", () => {
		const completed = {
			...message,
			details: { ...details, status: "partial", message: "IMAGE_GENERATION_FAILED: The second image failed." },
		};
		const live = projectLiveMessage({
			itemId: "item",
			sessionId: "session",
			state: "completed",
			message: completed,
			fallbackTimestamp: date,
		});
		const restored = projectMessageEntry({
			entry: { id: "item", type: "message", timestamp: date, message: completed },
			sessionId: "session",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: date,
		});
		expect(restored?.content).toEqual(live?.content);
		expect(live?.content[0]).toMatchObject({
			type: "tool_result",
			imageGeneration: {
				status: "partial",
				requestedCount: 2,
				images: [{ fileId: image.fileId, mediaType: "image/png", width: 1024 }],
				message: "The second image failed.",
			},
		});
		expect(JSON.stringify(live)).not.toContain("continuation");
		expect(JSON.stringify(live)).not.toContain("example.test");
	});

	it.each([
		["IMAGE_MODEL_NOT_CONFIGURED: Configure an image model", "unconfigured", "Configure an image model"],
		["IMAGE_GENERATION_CANCELLED: Cancelled", "cancelled", "Cancelled"],
		["Provider refused the request", "failed", "Provider refused the request"],
	])("projects a real tool error: %s", (output, status, publicMessage) => {
		const item = projectLiveMessage({
			itemId: "item",
			sessionId: "session",
			state: "completed",
			fallbackTimestamp: date,
			message: { ...message, details: {}, isError: true, content: [{ type: "text", text: output }] },
		});
		expect(item?.role).toBe("tool");
		expect(item?.content[0]).toMatchObject({
			type: "tool_result",
			isError: true,
			output,
			imageGeneration: { status, images: [], message: publicMessage },
		});
	});

	it("replaces child progress in place and drops its transient state on completion", () => {
		const events: DomainEvent[] = [];
		const projector = new AgentLiveProjector("root", (event) => events.push(event), date);
		projector.apply("child", "turn", update);
		const progress = projector.currentItems("child")[0]!;
		expect(progress.content[0]).toMatchObject({
			imageGeneration: { status: "generating", images: [{ fileId: image.fileId }] },
		});
		projector.apply("child", "turn", {
			...update,
			partialResult: { ...update.partialResult, details: { ...details, images: [] } },
		});
		expect(projector.currentItems("child")).toHaveLength(1);
		projector.apply("child", "turn", {
			type: "message_end",
			message: { ...message, details: { ...details, status: "partial" } },
		});
		expect(events.at(-1)).toMatchObject({
			type: "agent/item/completed",
			item: { itemId: progress.itemId, content: [{ imageGeneration: { status: "partial" } }] },
		});
		expect(projector.currentItems("child")).toEqual([]);
		const schema = compileSchema(DomainEventSchema);
		for (const event of events) expect(schema.Check(event)).toBe(true);
	});

	it("keeps separate generations when a provider reuses a tool-call ID in a later turn", () => {
		const events: DomainEvent[] = [];
		const projector = new AgentLiveProjector("root", (event) => events.push(event), date);
		projector.apply("child", "first-turn", update);
		projector.apply("child", "second-turn", update);
		expect(new Set(projector.currentItems("child").map((item) => item.itemId)).size).toBe(2);
	});

	it("publishes main-session progress and final result with one stable item identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-image-projection-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const manager = SessionManager.create(cwd, join(agentDir, "sessions"), {
			permissionPreset: "full",
		});
		const sessionId = manager.getSessionId();
		const path = manager.getSessionFile()!;
		manager.close();
		const opened = await new AgentSessionRuntimeHost({ agentDir }).open({
			path,
			relativePath: basename(path),
			summary: {
				sessionId,
				cwdOrigin: "user-selected",
				cwd,
				createdAt: date,
				updatedAt: date,
				state: "idle",
				archived: false,
				unread: false,
				useMemory: true,
				contributeMemory: true,
			},
		});
		try {
			const events: DomainEvent[] = [];
			opened.subscribe((event) => events.push(event));
			const internal = opened as unknown as { session: AgentSession; onAgentEvent(event: AgentSessionEvent): void };
			const bytes = Buffer.alloc(image.byteLength, 1);
			const source = join(cwd, "fixture.png");
			writeFileSync(source, bytes);
			const [attachment] = importSessionAttachments({ agentDir, sessionId, cwd, attachments: [{ path: source }] });
			const directory = join(dirname(attachment!.path), "delivered");
			mkdirSync(directory);
			writeFileSync(join(directory, `${image.fileId}.png`), bytes);
			internal.session.deliveredArtifacts!.stageGeneratedImage(message.toolCallId, {
				...image,
				mediaType: "image/png",
				continuation: { ...image.continuation, api: "google-interactions" },
			});
			const automatic = {
				...update,
				partialResult: { ...update.partialResult, details: { ...details, aspectRatio: "auto" } },
			};
			internal.onAgentEvent(automatic);
			internal.onAgentEvent(automatic);
			const pendingFile = await opened.readDeliveredFile({ sessionId, fileId: image.fileId });
			expect(Buffer.from(pendingFile.data, "base64")).toEqual(bytes);
			const completed = { ...message, details: { ...details, status: "completed" } };
			internal.session.sessionManager.appendMessage(completed);
			internal.session.deliveredArtifacts!.finishGeneration(message.toolCallId);
			internal.onAgentEvent({
				type: "message_end",
				message: completed,
			});
			const items = events.flatMap((event) =>
				event.type === "item/started" || event.type === "item/completed" ? [event.item] : [],
			);
			expect(items).toHaveLength(3);
			expect(new Set(items.map((item) => item.itemId)).size).toBe(1);
			expect(items.at(-1)?.content[0]).toMatchObject({ imageGeneration: { status: "completed" } });
			expect(events.some((event) => event.type === "session/deliveredFilesChanged")).toBe(true);
			const changed = events.find((event) => event.type === "session/deliveredFilesChanged");
			expect(changed).toMatchObject({ deliveredFiles: [{ fileId: image.fileId, availability: "available" }] });
			expect(JSON.stringify(changed)).not.toContain("continuation");
			expect(JSON.stringify(changed)).not.toContain("mediaType");
			const schema = compileSchema(DomainEventSchema);
			for (const event of events) expect(schema.Check(event)).toBe(true);
		} finally {
			await opened.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
