import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@metis/ai"; // boundary-allow: Offline fixtures exercise the production compaction lifecycle.
import type { DomainEvent } from "@metis/app-protocol";
import { type AgentSessionRuntime, type FileEntry, SessionManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";

const ROOT = "00000000-0000-4000-8000-000000000201";
const REQUEST = "00000000-0000-4000-8000-000000000301";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "metis-agent-controls-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const manager = SessionManager.create(cwd, join(agentDir, "sessions"), {
		id: ROOT,
		mode: "code",
		permissionPreset: "full",
	});
	const path = manager.getSessionFile()!;
	manager.close();
	const opened = await new AgentSessionRuntimeHost({ agentDir }).open({
		path,
		relativePath: basename(path),
		summary: {
			sessionId: ROOT,
			mode: "code",
			cwdOrigin: "user-selected",
			cwd,
			createdAt: "2026-10-23T00:00:00.000Z",
			updatedAt: "2026-10-23T00:00:00.000Z",
			state: "idle",
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		},
	});
	const internal = opened as unknown as {
		runtime: AgentSessionRuntime;
		refreshAgentReceipts(agentId: string): Promise<void>;
		agentInputReceipts: Map<string, { agentId: string; state: string }>;
	};
	cleanups.push(async () => {
		await opened.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { opened, ...internal, internal, runtime: internal.runtime };
}

describe("root and child runtime controls", () => {
	it.each(["success", "failure", "cancel"] as const)(
		"settles manual compaction after %s without leaving the session running",
		async (outcome) => {
			const { opened, runtime } = await fixture();
			const session = runtime.session;
			session.agent.state.model = fauxProvider().getModel();
			session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
			session.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			session.sessionManager.appendMessage(fauxAssistantMessage("response to compact"));
			session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
			let finishSummary!: () => void;
			session.agent.streamFn = (_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				finishSummary = () => {
					if (outcome === "failure") {
						stream.push({
							type: "error",
							reason: "error",
							error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "Summary failed" }),
						});
					} else {
						stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Summary") });
					}
				};
				options?.signal?.addEventListener("abort", finishSummary, { once: true });
				return stream;
			};
			const events: DomainEvent[] = [];
			opened.subscribe((event) => events.push(event));
			const compacting = opened.compact({ sessionId: ROOT, requestId: REQUEST });
			const result =
				outcome === "failure"
					? expect(compacting).rejects.toMatchObject({ code: "OPERATION_FAILED" })
					: expect(compacting).resolves.toMatchObject(
							outcome === "cancel" ? { message: "Compaction cancelled" } : { tokensBefore: expect.any(Number) },
						);
			await vi.waitFor(() => expect(finishSummary).toBeTypeOf("function"));
			expect(opened.isActive()).toBe(true);
			expect(opened.getSummary().state).toBe("running");
			if (outcome === "cancel") session.abortCompaction();
			else finishSummary();
			await result;
			expect(session.isCompacting).toBe(false);
			expect(opened.isActive()).toBe(false);
			expect(opened.getSummary().state).toBe("idle");
			expect(events.filter((event) => event.type === "session/updated").at(-1)).toMatchObject({
				session: { state: "idle" },
			});
			const snapshot = await opened.snapshot("11111111-1111-4111-8111-111111111111", () => 0);
			expect(snapshot.session.state).toBe("idle");
			expect(snapshot.activeTurnId).toBeNull();
			expect(
				snapshot.recentItems.filter((item) => item.content.some((block) => block.type === "compaction")),
			).toHaveLength(outcome === "success" ? 1 : 0);
		},
	);

	it("publishes user goal text immediately and restores the same item from the journal", async () => {
		const { opened, runtime } = await fixture();
		const events: DomainEvent[] = [];
		opened.subscribe((event) => events.push(event));
		await opened.setGoal({ sessionId: ROOT, requestId: REQUEST, objective: "测试 goal 模式", status: "paused" });
		const visible = events.filter((event) => event.type === "item/completed");
		expect(visible).toHaveLength(1);
		expect(visible[0]).toMatchObject({
			item: { role: "user", content: [{ type: "text", text: "/goal 测试 goal 模式" }] },
		});
		const snapshot = await opened.snapshot("11111111-1111-4111-8111-111111111111", () => 0);
		expect(snapshot.recentItems).toContainEqual(visible[0]!.item);
		await opened.setGoal({ sessionId: ROOT, requestId: REQUEST, status: "paused" });
		expect(events.filter((event) => event.type === "item/completed")).toHaveLength(1);
		const manager = runtime.session.sessionManager;
		const sessionPath = manager.getSessionFile()!;
		await opened.close();
		const reopened = SessionManager.open(sessionPath);
		try {
			expect(
				reopened
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "goal_user_request"),
			).toHaveLength(1);
		} finally {
			reopened.close();
		}
	});

	it.each(["turn", "agent"] as const)(
		"%s stop interrupts the root before child cleanup finishes",
		async (endpoint) => {
			const { opened, runtime } = await fixture();
			let release!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			vi.spyOn(runtime.subagentManager!, "control").mockImplementation(async () => {
				await pending;
				return { agentId: ROOT, state: "user_paused", scope: "subtree", requestId: REQUEST };
			});
			const abort = vi.spyOn(runtime.session, "abortAndDrainAgentEventPersistence").mockResolvedValue();
			const interrupt = vi
				.spyOn(runtime, "interrupt")
				.mockResolvedValue({ operationId: REQUEST, status: "accepted" });
			const stopped =
				endpoint === "turn"
					? opened.interrupt({ sessionId: ROOT, requestId: REQUEST })
					: opened.controlAgent({
							sessionId: ROOT,
							agentId: ROOT,
							requestId: REQUEST,
							action: "stop",
							scope: "subtree",
						});
			try {
				await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
				expect(interrupt).not.toHaveBeenCalled();
			} finally {
				release();
			}
			await stopped;
		},
	);

	it("a child cleanup failure cannot prevent interrupting the root", async () => {
		const { opened, runtime } = await fixture();
		vi.spyOn(runtime.subagentManager!, "control").mockRejectedValue(new Error("child cleanup failed"));
		const interrupt = vi.spyOn(runtime, "interrupt").mockResolvedValue({ operationId: REQUEST, status: "accepted" });
		await expect(opened.interrupt({ sessionId: ROOT, requestId: REQUEST })).rejects.toThrow("child cleanup failed");
		expect(interrupt).toHaveBeenCalledOnce();
	});

	it("rejects root IDs on the child-summary interrupt endpoint before changing state", async () => {
		const { opened, runtime } = await fixture();
		const control = vi.spyOn(runtime.subagentManager!, "control");
		await expect(opened.interruptAgent({ sessionId: ROOT, agentId: ROOT, requestId: REQUEST })).rejects.toMatchObject(
			{ code: "INVALID_PARAMS" },
		);
		expect(control).not.toHaveBeenCalled();
	});
	it("does not accept a root-only stop that would unload the whole tree", async () => {
		const { opened, runtime } = await fixture();
		const control = vi.spyOn(runtime.subagentManager!, "control");
		await expect(
			opened.controlAgent({ sessionId: ROOT, agentId: ROOT, requestId: REQUEST, action: "stop", scope: "self" }),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		expect(control).not.toHaveBeenCalled();
	});

	it("coalesces receipt reads and only republishes changed delivery states without retaining input text", async () => {
		const { opened, runtime, internal } = await fixture();
		const child = "00000000-0000-4000-8000-000000000401";
		const time = new Date().toISOString();
		const receipt: Extract<FileEntry, { type: "agent_input" }> = {
			type: "agent_input",
			id: "input",
			parentId: null,
			timestamp: time,
			agentId: child,
			taskId: "task",
			messageId: "message",
			requestId: "request",
			delivery: "steer",
			state: "delivered",
			instructionRevision: 2,
			origin: { kind: "user" },
			requestHash: "a".repeat(64),
			input: { text: "x".repeat(64 * 1024) },
		};
		runtime.session.sessionManager.appendAgentControl({
			type: "agent_mailbox_event",
			event: {
				type: "intervention",
				eventId: "intervention",
				agentId: child,
				parentSessionId: ROOT,
				taskId: "task",
				name: "Worker",
				completedAt: time,
				messageId: "message",
				instructionRevision: 2,
				delivery: "steer",
				state: "accepted",
				text: "Correction",
			},
		});
		const read = vi.spyOn(runtime.subagentManager!, "readJournal").mockResolvedValue([receipt]);
		const events: DomainEvent[] = [];
		opened.subscribe((event) => events.push(event));
		await Promise.all(Array.from({ length: 10 }, () => internal.refreshAgentReceipts(child)));
		expect(read).toHaveBeenCalledOnce();
		expect(events.filter((event) => event.type === "item/completed")).toHaveLength(1);
		expect(internal.agentInputReceipts.get("message")).toEqual({ agentId: child, state: "delivered" });
		events.length = 0;
		await internal.refreshAgentReceipts(child);
		expect(events).toHaveLength(0);
	});
});
