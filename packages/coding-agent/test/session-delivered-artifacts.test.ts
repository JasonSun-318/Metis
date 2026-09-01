import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolResultMessage } from "@metis/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliverFileDetails } from "../src/core/deliver-file.ts";
import { MAX_SESSION_DELIVERED_FILES } from "../src/core/session-attachments.ts";
import { SessionDeliveredArtifacts } from "../src/core/session-delivered-artifacts.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];
const managers: SessionManager[] = [];

function fixture(id = "session-delivered-artifacts") {
	const root = mkdtempSync(join(tmpdir(), "metis-delivered-artifacts-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, join(root, "sessions"), { id });
	managers.push(manager);
	return { root, agentDir, cwd, manager, artifacts: new SessionDeliveredArtifacts(agentDir, manager) };
}

function toolResult(toolCallId: string, details: DeliverFileDetails): ToolResultMessage<DeliverFileDetails> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "deliver_file",
		content: [{ type: "text", text: "delivered" }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

async function deliver(
	fixtureValue: ReturnType<typeof fixture>,
	options: { readonly name?: string; readonly signal?: AbortSignal } = {},
) {
	const source = join(fixtureValue.cwd, options.name ?? "report.txt");
	writeFileSync(source, "hello deliver");
	const toolCallId = `call-${Date.now()}-${Math.random()}`;
	const result = await fixtureValue.artifacts
		.createToolDefinition()
		.execute(toolCallId, { path: source, message: "Please review" }, options.signal, undefined, {} as never);
	const message = toolResult(toolCallId, result.details!);
	const entryId = fixtureValue.manager.appendMessage(message);
	fixtureValue.artifacts.commitToolResult(message);
	return { details: result.details!, entryId, message };
}

afterEach(() => {
	for (const manager of managers.splice(0, managers.length)) manager.close();
	for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
});

describe("SessionDeliveredArtifacts", () => {
	it("marks credential-shaped delivery sources as sensitive external effects", () => {
		const value = fixture("session-delivered-sensitive");
		const claim = value.artifacts
			.createToolDefinition()
			.permission.describe(
				{ path: ".env" },
				{ actionId: "deliver-sensitive", cwd: value.cwd, workspaceRoots: [value.cwd] },
			);
		expect(claim.effects).toEqual(["sensitive-read", "external-side-effect"]);
	});

	it("keeps staged files private until the successful tool result is journaled", async () => {
		const value = fixture();
		const source = join(value.cwd, "report.txt");
		writeFileSync(source, "hello deliver");
		const toolCallId = "call-private-stage";
		const result = await value.artifacts
			.createToolDefinition()
			.execute(toolCallId, { path: source }, undefined, undefined, {} as never);

		expect(value.artifacts.list()).toEqual([]);
		expect(value.artifacts.resolve(result.details!.fileId)).toBeUndefined();

		const message = toolResult(toolCallId, result.details!);
		value.manager.appendMessage(message);
		value.artifacts.commitToolResult(message);
		expect(value.artifacts.list()).toEqual([
			expect.objectContaining({
				fileId: result.details!.fileId,
				name: "report.txt",
				availability: "available",
			}),
		]);
		const resolved = value.artifacts.resolve(result.details!.fileId);
		expect(resolved?.artifact.name).toBe("report.txt");
		expect(readFileSync(resolved!.path, "utf8")).toBe("hello deliver");
	});

	it("retains journal history and marks a missing file unavailable", async () => {
		const value = fixture("session-missing-artifact");
		const delivered = await deliver(value);
		const resolved = value.artifacts.resolve(delivered.details.fileId);
		rmSync(resolved!.path);

		expect(value.artifacts.list()).toEqual([
			expect.objectContaining({ fileId: delivered.details.fileId, availability: "unavailable" }),
		]);
		expect(value.artifacts.resolve(delivered.details.fileId)).toBeUndefined();
	});

	it("keeps only the exact journal-derived storage name", async () => {
		const value = fixture("session-exact-artifact-name");
		const delivered = await deliver(value);
		const resolved = value.artifacts.resolve(delivered.details.fileId)!;
		const impostor = join(dirname(resolved.path), `${delivered.details.fileId}.evil`);
		writeFileSync(impostor, "not the delivered file");

		const reconciled = new SessionDeliveredArtifacts(value.agentDir, value.manager);
		expect(existsSync(resolved.path)).toBe(true);
		expect(existsSync(impostor)).toBe(false);
		expect(reconciled.resolve(delivered.details.fileId)?.path).toBe(resolved.path);
	});

	it("removes an unjournaled stage on cancellation", async () => {
		const value = fixture("session-cancelled-artifact");
		const source = join(value.cwd, "cancelled.txt");
		writeFileSync(source, "cancel me");
		let reads = 0;
		const signal = {
			get aborted() {
				reads += 1;
				return reads > 1;
			},
		} as AbortSignal;

		await expect(
			value.artifacts
				.createToolDefinition()
				.execute("call-cancelled", { path: source }, signal, undefined, {} as never),
		).rejects.toThrow(/aborted/iu);
		expect(value.artifacts.list()).toEqual([]);
		const deliveredDir = join(value.agentDir, "attachments", value.manager.getSessionId(), "delivered");
		expect(existsSync(deliveredDir) ? readFileNames(deliveredDir) : []).toEqual([]);
	});

	it("rejects source files outside the session workspace", async () => {
		const value = fixture("session-outside-artifact");
		const outside = join(value.root, "outside.txt");
		writeFileSync(outside, "outside");

		await expect(
			value.artifacts
				.createToolDefinition()
				.execute("call-outside", { path: outside }, undefined, undefined, {} as never),
		).rejects.toThrow(/outside the allowed workspace/iu);
	});

	it("reconciles true orphans without charging them to the journal quota", async () => {
		const value = fixture("session-orphan-artifact");
		const source = join(value.cwd, "orphan.txt");
		writeFileSync(source, "orphan");
		const result = await value.artifacts
			.createToolDefinition()
			.execute("call-orphan", { path: source }, undefined, undefined, {} as never);
		const deliveredDir = join(value.agentDir, "attachments", value.manager.getSessionId(), "delivered");
		expect(readFileNames(deliveredDir)).toHaveLength(1);

		const reconciled = new SessionDeliveredArtifacts(value.agentDir, value.manager);
		expect(readFileNames(deliveredDir)).toEqual([]);
		expect(reconciled.resolve(result.details!.fileId)).toBeUndefined();

		const next = await reconciled
			.createToolDefinition()
			.execute("call-after-orphan", { path: source }, undefined, undefined, {} as never);
		expect(next.details?.fileId).toMatch(/^[a-f0-9]{16}$/u);
		reconciled.rollback("call-after-orphan");
	});

	it("counts active journal history rather than physical files for quota", async () => {
		const value = fixture("session-artifact-quota");
		for (let index = 0; index < MAX_SESSION_DELIVERED_FILES; index += 1) {
			value.manager.appendMessage(
				toolResult(`call-${index}`, {
					fileId: index.toString(16).padStart(16, "0"),
					name: `${index}.txt`,
					byteLength: 1,
					deliveredAt: new Date(0).toISOString(),
				}),
			);
		}
		const source = join(value.cwd, "blocked.txt");
		writeFileSync(source, "blocked");

		await expect(
			value.artifacts
				.createToolDefinition()
				.execute("call-blocked", { path: source }, undefined, undefined, {} as never),
		).rejects.toThrow(/at most 32 files/iu);
	});

	it("preserves files referenced by an inactive history branch during reconciliation", async () => {
		const value = fixture("session-branched-artifact");
		const rootEntryId = value.manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "start" }],
			timestamp: Date.now(),
		});
		const delivered = await deliver(value);
		const path = value.artifacts.resolve(delivered.details.fileId)!.path;
		value.manager.branch(rootEntryId);
		value.manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "alternate" }],
			timestamp: Date.now(),
		});

		expect(value.artifacts.list()).toEqual([]);
		new SessionDeliveredArtifacts(value.agentDir, value.manager);
		expect(existsSync(path)).toBe(true);
	});

	it("copies the fork branch best-effort and leaves missing history unavailable", async () => {
		const value = fixture("session-fork-source");
		const delivered = await deliver(value);
		const branch = value.manager.createBranchedSessionManager(delivered.entryId);
		managers.push(branch);
		value.artifacts.copyTo(branch);
		const target = new SessionDeliveredArtifacts(value.agentDir, branch);
		expect(target.list()).toEqual([
			expect.objectContaining({ fileId: delivered.details.fileId, availability: "available" }),
		]);

		const missingBranch = value.manager.createBranchedSessionManager(delivered.entryId);
		managers.push(missingBranch);
		rmSync(value.artifacts.resolve(delivered.details.fileId)!.path);
		expect(() => value.artifacts.copyTo(missingBranch)).not.toThrow();
		const missingTarget = new SessionDeliveredArtifacts(value.agentDir, missingBranch);
		expect(missingTarget.list()).toEqual([
			expect.objectContaining({ fileId: delivered.details.fileId, availability: "unavailable" }),
		]);

		const blockedBranch = value.manager.createBranchedSessionManager(delivered.entryId);
		managers.push(blockedBranch);
		const blockedAttachmentDir = join(value.agentDir, "attachments", blockedBranch.getSessionId());
		mkdirSync(blockedAttachmentDir, { recursive: true });
		writeFileSync(join(blockedAttachmentDir, "delivered"), "not a directory");
		expect(() => value.artifacts.copyTo(blockedBranch)).not.toThrow();
	});
});

function readFileNames(directory: string): string[] {
	return readdirSync(directory).sort();
}
