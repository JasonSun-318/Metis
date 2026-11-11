import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION } from "@metis/app-protocol";
import {
	AgentStore,
	importSessionAttachments,
	SessionDeliveredArtifacts,
	SessionManager,
} from "@metis/coding-agent/host";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openAgentDeliveredFile, readAgentDeliveredFile, readAgentImage } from "../src/agent-assets.ts";
import { AppServer } from "../src/app-server.ts";
import type { OpenedSessionRuntime, SessionRef } from "../src/session-runtime-host.ts";

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "metis-agent-assets-"));
	const cwd = join(directory, "workspace"),
		agentDir = join(directory, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const root = SessionManager.create(cwd, join(directory, "sessions"), {
		id: "11111111-1111-4111-8111-111111111111",
	});
	const store = new AgentStore(root, agentDir);
	const config: Parameters<AgentStore["create"]>[0] = {
		agentId: "22222222-2222-4222-8222-222222222222",
		name: "File reviewer",
		agentType: "default",
		initialTask: "Review files",
		tools: ["read", "deliver_file"],
		writePolicy: "inherit",
		permissionPreset: "ask",
		model: { provider: "test", modelId: "test-model" },
		thinkingLevel: "off",
		cwd,
		forkTurns: 0,
		timeoutSeconds: 60,
		mayDelegate: false,
		parentSessionId: root.getSessionId(),
		rootSessionId: root.getSessionId(),
		agentPath: ["22222222-2222-4222-8222-222222222222"],
	};
	const record = store.create(config, [], "33333333-3333-4333-8333-333333333333");
	const child = SessionManager.open(record.path);
	onTestFinished(() => {
		child.close();
		root.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const timestamp = new Date().toISOString();
	const ref: SessionRef = {
		path: root.getSessionFile()!,
		relativePath: "root.jsonl",
		summary: {
			sessionId: root.getSessionId(),
			cwd,
			cwdOrigin: "user-selected",
			createdAt: timestamp,
			updatedAt: timestamp,
			state: "idle",
			archived: false,
			unread: false,
			useMemory: false,
			contributeMemory: false,
		},
	};
	return {
		directory,
		cwd,
		agentDir,
		root,
		child,
		ref,
		record,
		input: { rootSessionId: root.getSessionId(), sessionId: child.getSessionId() },
	};
}

describe("read-only child asset access", () => {
	it("reads pending and durable generated child images only after validating the root relationship", async () => {
		const value = setup();
		const artifacts = new SessionDeliveredArtifacts(value.agentDir, value.child);
		const bytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
			"base64",
		);
		const source = join(value.cwd, "fixture.png");
		writeFileSync(source, bytes);
		const [attachment] = importSessionAttachments({
			agentDir: value.agentDir,
			sessionId: value.child.getSessionId(),
			cwd: value.cwd,
			attachments: [{ path: source }],
		});
		const directory = join(dirname(attachment!.path), "delivered");
		mkdirSync(directory);
		writeFileSync(join(directory, "0123456789abcdef.png"), bytes);
		const image = {
			fileId: "0123456789abcdef",
			name: "generated.png",
			byteLength: bytes.length,
			deliveredAt: new Date().toISOString(),
			mediaType: "image/png" as const,
			continuation: {
				api: "google-interactions" as const,
				modelId: "image-model",
				baseUrl: "https://example.test",
				interactionId: "private-continuation",
			},
		};
		artifacts.stageGeneratedImage("generation", image);
		const input = { ...value.input, fileId: image.fileId };
		const resolveLive = vi.fn(() => artifacts.resolve(image.fileId));
		await expect(readAgentDeliveredFile(value.ref, value.agentDir, input)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		const pending = await readAgentDeliveredFile(value.ref, value.agentDir, input, resolveLive);
		expect(Buffer.from(pending.data, "base64")).toEqual(bytes);
		expect(JSON.stringify(pending)).not.toContain("private-continuation");
		const open = vi.fn(async () => {});
		await openAgentDeliveredFile(value.ref, value.agentDir, { ...input, action: "reveal" }, open, resolveLive);
		expect(open).toHaveBeenCalledOnce();
		resolveLive.mockClear();
		await expect(
			readAgentDeliveredFile(value.ref, value.agentDir, { ...input, rootSessionId: "wrong-root" }, resolveLive),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			readAgentDeliveredFile(value.ref, value.agentDir, { ...input, sessionId: "wrong-child" }, resolveLive),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(resolveLive).not.toHaveBeenCalled();
		value.root.close();
		const openRuntime = vi.fn(async (ref: SessionRef) => {
			// The model runtime is the external boundary for this dispatcher test.
			// Keep the actual artifact store and ownership checks, while the manager's
			// hot-child lookup is covered separately without reopening this live writer.
			return {
				sessionId: ref.summary.sessionId,
				isActive: () => false,
				hasPendingInteractions: () => false,
				close: async () => {},
				resolveAgentDeliveredFile: (agentId: string, fileId: string) =>
					agentId === value.child.getSessionId() ? artifacts.resolve(fileId) : undefined,
			} as OpenedSessionRuntime;
		});
		const server = await AppServer.create({
			agentDir: value.agentDir,
			sessionsRoot: dirname(value.ref.path),
			runtimeHost: { open: openRuntime },
			titleGenerator: { generate: async () => undefined },
		});
		try {
			const connection = server.connect();
			await connection.handle({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					client: { name: "image-test", version: "1" },
					capabilities: [],
				},
			});
			const cold = await connection.handle({
				jsonrpc: "2.0",
				id: "cold-image",
				method: "session/readDeliveredFile",
				params: input,
			});
			expect(cold).toHaveProperty("error");
			expect(openRuntime).not.toHaveBeenCalled();
			await server.registry.run(value.ref, async () => undefined);
			const live = await connection.handle({
				jsonrpc: "2.0",
				id: "live-image",
				method: "session/readDeliveredFile",
				params: input,
			});
			expect(live).toMatchObject({ result: { fileId: image.fileId, data: bytes.toString("base64") } });
			expect(openRuntime).toHaveBeenCalledOnce();
		} finally {
			server.beginShutdown();
			await server.waitForShutdown();
		}
		value.child.appendMessage({
			role: "toolResult",
			toolName: "image_generate",
			toolCallId: "generation",
			content: [{ type: "text", text: "Generated image" }],
			isError: false,
			timestamp: Date.now(),
			details: { kind: "image_generation", status: "completed", requestedCount: 1, images: [image] },
		});
		artifacts.finishGeneration("generation");
		const restored = await readAgentDeliveredFile(value.ref, value.agentDir, input);
		expect(Buffer.from(restored.data, "base64")).toEqual(bytes);
		expect(readFileSync(join(directory, "0123456789abcdef.png"))).toEqual(bytes);
	});

	it("reads child images while a writer is live and verifies hash, size and root ownership without touching the journals", async () => {
		const value = setup();
		const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
		const bytes = Buffer.from(data, "base64");
		value.child.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: Date.now(),
		});
		const image = {
			hash: createHash("sha256").update(bytes).digest("hex"),
			mediaType: "image/png" as const,
			byteLength: bytes.length,
		};
		const before = readFileSync(value.record.path, "utf8");
		await expect(readAgentImage(value.ref, value.agentDir, { ...value.input, image })).resolves.toEqual({
			data,
			mediaType: "image/png",
		});
		await expect(
			readAgentImage(value.ref, value.agentDir, { ...value.input, rootSessionId: "another-root", image }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			readAgentImage(value.ref, value.agentDir, { ...value.input, sessionId: "another-child", image }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			readAgentImage(value.ref, value.agentDir, {
				...value.input,
				image: { ...image, byteLength: bytes.length + 1 },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(readFileSync(value.record.path, "utf8")).toBe(before);
		const assetDirectory = join(
			dirname(value.record.path),
			"images",
			createHash("sha256").update(realpathSync(value.record.path)).digest("hex"),
		);
		writeFileSync(join(assetDirectory, `${image.hash}.png`), Buffer.alloc(bytes.length, 1));
		await expect(readAgentImage(value.ref, value.agentDir, { ...value.input, image })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(readFileSync(value.record.path, "utf8")).toBe(before);
	});

	it("reads and opens only a durable child delivery without constructing a mutating artifact store", async () => {
		const value = setup();
		const artifacts = new SessionDeliveredArtifacts(value.agentDir, value.child);
		const path = join(value.cwd, "result.txt");
		writeFileSync(path, "Child delivery bytes");
		const result = await artifacts
			.createToolDefinition()
			.execute("delivery", { path }, undefined, undefined, {} as never);
		const message = {
			role: "toolResult" as const,
			toolName: "deliver_file",
			toolCallId: "delivery",
			...result,
			isError: false,
			timestamp: Date.now(),
		};
		value.child.appendMessage(message);
		const resolved = artifacts.resolve(result.details.fileId)!;
		const orphan = join(dirname(resolved.path), "unreferenced-sentinel.txt");
		writeFileSync(orphan, "Do not clean up during a read");
		const before = readFileSync(value.record.path, "utf8");
		const input = { ...value.input, fileId: result.details.fileId };
		const response = await readAgentDeliveredFile(value.ref, value.agentDir, input);
		expect(Buffer.from(response.data, "base64").toString("utf8")).toBe("Child delivery bytes");
		expect(response.absolutePath).toBe(resolved.path);
		const open = vi.fn(async () => {});
		await expect(
			openAgentDeliveredFile(value.ref, value.agentDir, { ...input, action: "reveal" }, open),
		).resolves.toEqual({});
		expect(open).toHaveBeenCalledWith({ path: resolved.path, action: "reveal" });
		await expect(
			readAgentDeliveredFile(value.ref, value.agentDir, { ...input, rootSessionId: "other-root" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			openAgentDeliveredFile(
				value.ref,
				value.agentDir,
				{ ...input, sessionId: "other-child", action: "default" },
				open,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			readAgentDeliveredFile(value.ref, value.agentDir, { ...input, fileId: "0123456789abcdef" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(open).toHaveBeenCalledTimes(1);
		expect(readFileSync(orphan, "utf8")).toBe("Do not clean up during a read");
		expect(readFileSync(value.record.path, "utf8")).toBe(before);
		writeFileSync(resolved.path, "changed size");
		const updated = await readAgentDeliveredFile(value.ref, value.agentDir, input);
		expect(updated.byteLength).toBe(12);
		expect(Buffer.from(updated.data, "base64").toString("utf8")).toBe("changed size");
		await expect(
			readAgentDeliveredFile(value.ref, value.agentDir, { ...input, metadataOnly: true }),
		).resolves.toMatchObject({ absolutePath: realpathSync(path), byteLength: 12, data: "" });
		await expect(
			readAgentDeliveredFile(value.ref, value.agentDir, {
				...input,
				rootSessionId: "other-root",
				metadataOnly: true,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
