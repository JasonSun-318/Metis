import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentStore, SessionDeliveredArtifacts, SessionManager } from "@metis/coding-agent/host";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openAgentDeliveredFile, readAgentDeliveredFile, readAgentImage } from "../src/agent-assets.ts";
import type { SessionRef } from "../src/session-runtime-host.ts";

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "metis-agent-assets-"));
	const cwd = join(directory, "workspace"),
		agentDir = join(directory, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const root = SessionManager.create(cwd, join(directory, "sessions"), { id: "asset-root", mode: "chat" });
	const store = new AgentStore(root, agentDir);
	const config: Parameters<AgentStore["create"]>[0] = {
		agentId: "asset-child",
		name: "File reviewer",
		agentType: "default",
		initialTask: "Review files",
		mode: "chat",
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
		agentPath: ["asset-child"],
	};
	const record = store.create(config, [], "asset-task");
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
			mode: "chat",
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
