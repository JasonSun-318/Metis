import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionControlEntry } from "../src/core/session-control.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "metis-subagent-format-"));
	roots.push(root);
	return root;
}

describe("v13 agent control records", () => {
	it("parses mailbox delivery and two-phase mailbox controls", () => {
		const base = { id: "record-1", parentId: null, timestamp: new Date(0).toISOString() };
		const event = {
			eventId: "agent:agent-child-1:task-1:terminal",
			taskId: "task-1",
			agentId: "agent-child-1",
			parentSessionId: "parent-session-1",
			name: "researcher",
			type: "terminal" as const,
			status: "done" as const,
			finalMessage: "verified",
			completedAt: new Date(0).toISOString(),
		};

		const eventEntry = parseSessionControlEntry({ ...base, type: "agent_mailbox_event", event });
		expect(eventEntry).toMatchObject({ type: "agent_mailbox_event", event });

		for (const state of ["started", "completed"] as const) {
			const delivery = parseSessionControlEntry({
				...base,
				type: "agent_mailbox_delivery",
				deliveryId: "delivery-1",
				eventIds: [event.eventId],
				state,
			});
			expect(delivery).toMatchObject({
				type: "agent_mailbox_delivery",
				state,
				eventIds: [event.eventId],
			});
		}
	});

	it("rejects malformed mailbox controls", () => {
		const base = { id: "record-1", parentId: null, timestamp: new Date(0).toISOString() };
		expect(() =>
			parseSessionControlEntry({
				...base,
				type: "agent_mailbox_delivery",
				deliveryId: "delivery-1",
				eventIds: [],
				state: "started",
			}),
		).toThrow("eventIds must contain at least one event ID");
		expect(() =>
			parseSessionControlEntry({
				...base,
				type: "agent_mailbox_delivery",
				deliveryId: "delivery-1",
				eventIds: ["event-1", "event-1"],
				state: "completed",
			}),
		).toThrow("eventIds must not contain duplicates");
	});

	it("round-trips optional terminal tool-call usage on agent_task and rejects fractions", () => {
		const base = {
			id: "record-usage",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			type: "agent_task",
			agentId: "agent-child-1",
			taskId: "task-1",
			text: "Research the session format",
			taskSummary: "Research the session format",
			status: "done",
			reason: "completed",
		};
		const usage = {
			model: { provider: "openai", modelId: "gpt-test" },
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			elapsedMs: 5,
			toolCalls: 6,
		};
		expect(parseSessionControlEntry({ ...base, usage })).toMatchObject({ usage });
		expect(() => parseSessionControlEntry({ ...base, usage: { ...usage, toolCalls: 1.5 } })).toThrow(
			"toolCalls must be a non-negative integer",
		);
	});

	it("rejects removed legacy mailbox controls and migrates an ordinary v12 journal", () => {
		const root = tempRoot();
		const ordinaryPath = join(root, "ordinary-v12.jsonl");
		const header = {
			type: "session",
			version: 12,
			id: "parent-v10",
			timestamp: new Date(0).toISOString(),
			cwd: root,
			mode: "code",
		};
		writeFileSync(ordinaryPath, `${JSON.stringify(header)}\n`);
		const migrated = SessionManager.open(ordinaryPath);
		expect(migrated.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
		migrated.close();
		expect(() =>
			parseSessionControlEntry({
				id: "record-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				type: ["subagent", "mailbox", "delivery"].join("_"),
			}),
		).toThrow("Unknown session control entry type");
	});

	it("persists agent_task controls on a child session", () => {
		const root = tempRoot();
		mkdirSync(join(root, "project"));
		const manager = SessionManager.create(join(root, "project"), join(root, "sessions"), {
			id: "agent-child-1",
			mode: "code",
			agent: {
				agentId: "agent-child-1",
				name: "researcher",
				agentType: "worker",
				parentSessionId: "parent-session-1",
				rootSessionId: "parent-session-1",
				agentPath: ["agent-child-1"],
				cwd: join(root, "project"),
				tools: ["read"],
				writePolicy: "inherit",
				permissionPreset: "ask",
				model: { provider: "openai", modelId: "gpt-test" },
				thinkingLevel: "high",
				initialTask: "Research the session format",
				forkTurns: 0,
				timeoutSeconds: 60,
				mayDelegate: false,
			},
		});
		manager.appendAgentControl({
			type: "agent_task",
			agentId: "agent-child-1",
			taskId: "task-1",
			text: "Research the session format",
			taskSummary: "Research the session format",
			status: "queued",
		});

		expect(manager.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
		expect(manager.getHeader()?.agent?.name).toBe("researcher");
		expect(manager.getMode()).toBe("code");
		expect(manager.getDurableJournalSnapshot().map((entry) => entry.type)).toContain("agent_task");
		manager.close();
	});

	it("rejects unknown subagent controls", () => {
		expect(() =>
			parseSessionControlEntry({
				type: "subagent_unknown",
				id: "record-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
			}),
		).toThrow("Unknown session control entry type");
	});

	it("rejects invalid agent_task transitions", () => {
		const base = {
			id: "record-1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			agentId: "agent-child-1",
			taskId: "task-1",
			text: "Research",
			taskSummary: "Research",
		};
		expect(() =>
			parseSessionControlEntry({
				...base,
				type: "agent_task",
				status: "done",
				reason: "timeout",
			}),
		).toThrow("timeout requires failed status");
		expect(() =>
			parseSessionControlEntry({
				...base,
				type: "agent_task",
				status: "running",
				reason: "recovered",
			}),
		).toThrow("recovered requires queued status");
	});

	it("rejects legacy subagent_created records", () => {
		expect(() =>
			parseSessionControlEntry({
				type: "subagent_created",
				id: "record-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				config: {},
			}),
		).toThrow("Unknown session control entry type");
	});

	it("requires v8 for workspace-directory controls and migrates ordinary v7 journals", () => {
		const root = tempRoot();
		const header = {
			type: "session",
			version: 7,
			id: "code-session-1",
			timestamp: new Date(0).toISOString(),
			cwd: root,
			mode: "code",
			cwdOrigin: "user-selected",
			permissionPreset: "ask",
		};
		const control = {
			type: "session_directory_added",
			id: "directory-1",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			path: "/tmp/external",
		};
		const badPath = join(root, "bad-v7-directory.jsonl");
		writeFileSync(badPath, `${JSON.stringify(header)}\n${JSON.stringify(control)}\n`);
		expect(() => SessionManager.open(badPath)).toThrow("Directory control entries require a v8 session header");

		const chatPath = join(root, "bad-chat-directory.jsonl");
		writeFileSync(
			chatPath,
			`${JSON.stringify({ ...header, version: 8, mode: "chat" })}\n${JSON.stringify(control)}\n`,
		);
		expect(() => SessionManager.open(chatPath)).toThrow("Directory controls are only valid for Code sessions");

		const unknownPath = join(root, "bad-unknown-directory.jsonl");
		writeFileSync(
			unknownPath,
			`${JSON.stringify({ ...header, version: 8 })}\n${JSON.stringify({ ...control, type: "session_directory_changed" })}\n`,
		);
		expect(() => SessionManager.open(unknownPath)).toThrow("Unknown session control entry type");

		const relativePath = join(root, "bad-relative-directory.jsonl");
		writeFileSync(
			relativePath,
			`${JSON.stringify({ ...header, version: 8 })}\n${JSON.stringify({ ...control, path: "relative" })}\n`,
		);
		expect(() => SessionManager.open(relativePath)).toThrow("Invalid session control entry");

		const goodPath = join(root, "good-v7-directory.jsonl");
		writeFileSync(goodPath, `${JSON.stringify(header)}\n`);
		const manager = SessionManager.open(goodPath);
		expect(manager.getHeader()?.version).toBeGreaterThanOrEqual(12);
		manager.close();
		expect(JSON.parse(readFileSync(goodPath, "utf8").trim()).version).toBeGreaterThanOrEqual(12);
	});
});

describe("v15 agent conversations", () => {
	it("strictly parses origin, rich input, receipts and pause controls", () => {
		const base = { id: "input-entry", parentId: null, timestamp: new Date(0).toISOString() };
		const input = {
			...base,
			type: "agent_input",
			agentId: "child",
			taskId: "task",
			messageId: "message",
			requestId: "request",
			requestHash: "a".repeat(64),
			delivery: "steer",
			state: "accepted",
			instructionRevision: 1,
			origin: { kind: "user" },
			input: {
				text: "Correction",
				images: [{ type: "image_ref", hash: "b".repeat(64), mimeType: "image/png", size: 1 }],
			},
		};
		expect(parseSessionControlEntry(input)).toEqual(input);
		expect(() => parseSessionControlEntry({ ...input, origin: { kind: "user", sessionId: "forged" } })).toThrow(
			"unknown field",
		);
		expect(() => parseSessionControlEntry({ ...input, input: { text: "Correction", path: "/private" } })).toThrow();
		expect(() => parseSessionControlEntry({ ...input, instructionRevision: 0 })).toThrow();
		expect(
			parseSessionControlEntry({
				...base,
				type: "agent_run_control",
				agentId: "child",
				requestId: "stop",
				action: "stop",
				state: "user_paused",
				scope: "subtree",
				origin: { kind: "user" },
			}),
		).toMatchObject({ state: "user_paused" });
	});

	it("keeps v14 reads byte-identical and rejects v15 records in old headers", () => {
		const root = tempRoot();
		const path = join(root, "legacy.jsonl");
		const header = {
			type: "session",
			id: "root",
			version: 14,
			timestamp: new Date(0).toISOString(),
			cwd: root,
			mode: "chat",
			permissionPreset: "ask",
		};
		const bytes = JSON.stringify(header) + "\n";
		writeFileSync(path, bytes);
		expect(SessionManager.openReadOnly(path).getHeader()?.mode).toBe("chat");
		expect(readFileSync(path, "utf8")).toBe(bytes);
		const control = {
			type: "agent_run_control",
			id: "control",
			parentId: null,
			timestamp: header.timestamp,
			agentId: "root",
			requestId: "stop",
			action: "stop",
			state: "user_paused",
			scope: "subtree",
			origin: { kind: "user" },
		};
		writeFileSync(path, bytes + JSON.stringify(control) + "\n");
		expect(() => SessionManager.openReadOnly(path)).toThrow("v15");
		writeFileSync(
			path,
			bytes +
				JSON.stringify({
					type: "agent_permission_ceiling",
					id: "ceiling",
					parentId: null,
					timestamp: header.timestamp,
					agentId: "child",
					permissionPreset: "ask",
				}) +
				"\n",
		);
		expect(() => SessionManager.openReadOnly(path)).toThrow("v15");
	});
});
