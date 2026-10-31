import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@metis/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliverFileDetails } from "../src/core/deliver-file.ts";
import { createSessionWorkDir, MAX_SESSION_DELIVERED_FILES } from "../src/core/session-attachments.ts";
import { SessionDeliveredArtifacts } from "../src/core/session-delivered-artifacts.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];
const managers: SessionManager[] = [];
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "metis-live-delivery-")));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const manager = SessionManager.create(cwd, join(root, "sessions"));
	managers.push(manager);
	return { root, agentDir, cwd, manager, artifacts: new SessionDeliveredArtifacts(agentDir, manager) };
}
function message(details: DeliverFileDetails): ToolResultMessage<DeliverFileDetails> {
	return {
		role: "toolResult",
		toolCallId: `deliver-${details.fileId}`,
		toolName: "deliver_file",
		content: [{ type: "text", text: "delivered" }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}
async function deliver(value: ReturnType<typeof fixture>, path: string) {
	const result = await value.artifacts
		.createToolDefinition()
		.execute("deliver", { path }, undefined, undefined, {} as never);
	const entryId = value.manager.appendMessage(message(result.details!));
	return { details: result.details!, entryId };
}
afterEach(() => {
	for (const manager of managers.splice(0)) manager.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionDeliveredArtifacts", () => {
	it("keeps the existing read and sensitive-file permission descriptors", () => {
		const value = fixture();
		const tool = value.artifacts.createToolDefinition();
		const context = { actionId: "delivery", cwd: value.cwd, workspaceRoots: [value.cwd] };
		expect(tool.permission.describe({ path: "report.md" }, context)).toMatchObject({
			readPaths: ["report.md"],
			effects: [],
		});
		expect(tool.permission.describe({ path: ".env" }, context).effects).toEqual(["sensitive-read"]);
	});
	it("publishes a live reference only after journaling, without copying the file", async () => {
		const value = fixture();
		const path = join(value.cwd, "report.txt");
		writeFileSync(path, "first");
		const result = await value.artifacts
			.createToolDefinition()
			.execute("one", { path }, undefined, undefined, {} as never);
		expect(value.artifacts.resolve(result.details!.fileId)).toBeUndefined();
		value.manager.appendMessage(message(result.details!));
		expect(value.artifacts.resolve(result.details!.fileId)?.path).toBe(path);
		expect(result.details?.sourcePath).toBe(path);
		expect(existsSync(join(value.agentDir, "attachments"))).toBe(false);
	});
	it("reuses identity across repeated deliveries and opens the newest original bytes", async () => {
		const value = fixture();
		const path = join(value.cwd, "report.txt");
		writeFileSync(path, "first");
		const first = await deliver(value, path);
		for (let i = 0; i < MAX_SESSION_DELIVERED_FILES + 1; i++) {
			writeFileSync(path, `updated version ${i}`);
			expect((await deliver(value, path)).details.fileId).toBe(first.details.fileId);
		}
		expect(value.artifacts.list()).toHaveLength(1);
		const resolved = value.artifacts.resolve(first.details.fileId)!;
		expect(readFileSync(resolved.path, "utf8")).toBe(`updated version ${MAX_SESSION_DELIVERED_FILES}`);
		expect(resolved.artifact.byteLength).toBe(readFileSync(path).length);
		const reopened = SessionManager.openReadOnly(value.manager.getSessionFile()!);
		const restored = new SessionDeliveredArtifacts(value.agentDir, reopened);
		expect(restored.resolve(first.details.fileId)?.path).toBe(path);
	});
	it("keeps deleted or redirected history unavailable", async () => {
		const value = fixture();
		const path = join(value.cwd, "report.txt");
		writeFileSync(path, "one");
		const file = await deliver(value, path);
		rmSync(path);
		expect(value.artifacts.list()[0]?.availability).toBe("unavailable");
		const other = join(value.root, "other.txt");
		writeFileSync(other, "other");
		symlinkSync(other, path);
		expect(value.artifacts.resolve(file.details.fileId)).toBeUndefined();
	});
	it("does not remove unrelated files in the original folder", async () => {
		const value = fixture();
		const path = join(value.cwd, "report.txt");
		writeFileSync(path, "report");
		await deliver(value, path);
		const unrelated = join(value.cwd, "notes.txt");
		writeFileSync(unrelated, "notes");
		new SessionDeliveredArtifacts(value.agentDir, value.manager);
		expect(readFileSync(unrelated, "utf8")).toBe("notes");
	});
	it("preserves the original on cancellation", async () => {
		const value = fixture();
		const path = join(value.cwd, "report.txt");
		writeFileSync(path, "report");
		let reads = 0;
		const signal = {
			get aborted() {
				return ++reads > 1;
			},
		} as AbortSignal;
		await expect(
			value.artifacts.createToolDefinition().execute("one", { path }, signal, undefined, {} as never),
		).rejects.toThrow(/aborted/);
		expect(readFileSync(path, "utf8")).toBe("report");
		expect(value.artifacts.list()).toEqual([]);
	});
	it("accepts an authorized external path without forcing relocation", async () => {
		const value = fixture();
		const path = join(value.root, "outside.txt");
		writeFileSync(path, "outside");
		const file = await deliver(value, path);
		expect(value.artifacts.resolve(file.details.fileId)?.path).toBe(path);
	});
	it("rejects run-temporary files before cleanup can invalidate their cards", async () => {
		const value = fixture();
		const work = createSessionWorkDir(value.agentDir, value.manager.getSessionId());
		const path = join(work, "report.txt");
		writeFileSync(path, "temporary");
		await expect(deliver(value, path)).rejects.toThrow(/METIS_WORK_DIR is temporary/);
		expect(existsSync(path)).toBe(true);
	});
	it("enforces the distinct-file quota", async () => {
		const value = fixture();
		for (let i = 0; i < MAX_SESSION_DELIVERED_FILES; i++) {
			const path = join(value.cwd, `${i}.txt`);
			writeFileSync(path, "file");
			await deliver(value, path);
		}
		const next = join(value.cwd, "next.txt");
		writeFileSync(next, "file");
		await expect(deliver(value, next)).rejects.toThrow(/32 distinct files/);
	});
	it("carries live references into forks without copying and limits access to branch history", async () => {
		const value = fixture();
		const root = value.manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const path = join(value.cwd, "report.txt");
		writeFileSync(path, "first");
		const file = await deliver(value, path);
		const fork = value.manager.createBranchedSessionManager(file.entryId);
		managers.push(fork);
		value.artifacts.copyTo(fork);
		writeFileSync(path, "updated");
		expect(new SessionDeliveredArtifacts(value.agentDir, fork).resolve(file.details.fileId)?.path).toBe(path);
		value.manager.branch(root);
		expect(value.artifacts.resolve(file.details.fileId)).toBeUndefined();
		expect(existsSync(path)).toBe(true);
	});
	it("retains and forks legacy copied deliveries without migrating history", () => {
		const value = fixture();
		const details = {
			fileId: "aaaaaaaaaaaaaaaa",
			name: "old.txt",
			byteLength: 3,
			deliveredAt: new Date().toISOString(),
		};
		const dir = join(value.agentDir, "attachments", value.manager.getSessionId(), "delivered");
		mkdirSync(dir, { recursive: true });
		const old = join(dir, "aaaaaaaaaaaaaaaa.txt");
		writeFileSync(old, "old");
		writeFileSync(join(dir, "orphan.txt"), "orphan");
		const entry = value.manager.appendMessage(message(details));
		const artifacts = new SessionDeliveredArtifacts(value.agentDir, value.manager);
		expect(artifacts.resolve(details.fileId)?.path).toBe(old);
		expect(existsSync(join(dir, "orphan.txt"))).toBe(false);
		const fork = value.manager.createBranchedSessionManager(entry);
		managers.push(fork);
		artifacts.copyTo(fork);
		const resolved = new SessionDeliveredArtifacts(value.agentDir, fork).resolve(details.fileId)!;
		expect(resolved.path).not.toBe(old);
		expect(readFileSync(resolved.path, "utf8")).toBe("old");
	});
});
