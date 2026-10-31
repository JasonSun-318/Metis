import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractionView, ServerRpcRequest } from "@metis/app-protocol";
import { SessionDeliveredArtifacts, SessionManager } from "@metis/coding-agent/host";
import { describe, expect, it, onTestFinished } from "vitest";
import { createAgentHostTools, DELEGATABLE_HOST_TOOL_NAMES } from "../src/agent-host-tools.ts";
import { InteractionBroker, type InteractionPeer } from "../src/interactions.ts";

const ROOT = "root-session";
const CHILD = "child-session";
const EPOCH = "11111111-1111-4111-8111-111111111111";
const question = {
	questions: [{ question: "Which source?", multiple: false, options: [{ label: "Local" }, { label: "Remote" }] }],
};

describe("actor-bound host tools", () => {
	it("reconstructs only allowed and available host tools without leaking actor fields into model parameters", () => {
		const interactions = new InteractionBroker({ serverEpoch: EPOCH });
		const options = { rootSessionId: ROOT, agentId: CHILD, taskId: () => "task-1", interactions };
		const first = createAgentHostTools({ ...options, allowedToolNames: ["ask_user", "browser_observe", "bash"] });
		const resumed = createAgentHostTools({ ...options, allowedToolNames: ["ask_user", "browser_observe"] });
		expect(first.tools.map((tool) => tool.name)).toEqual(["ask_user", "browser_observe"]);
		expect(resumed.delegatableToolNames).toEqual(first.delegatableToolNames);
		expect(first.automaticPermissionToolNames).toEqual(first.delegatableToolNames);
		for (const tool of first.tools) {
			expect(tool.parameters.properties).not.toHaveProperty("agentId");
			expect(tool.parameters.properties).not.toHaveProperty("rootSessionId");
		}
		expect(
			createAgentHostTools({ ...options, interactions: undefined, allowedToolNames: DELEGATABLE_HOST_TOOL_NAMES })
				.tools,
		).toEqual([]);
	});

	it("routes child questions to the root peer while preserving child and current task identity", async () => {
		const interactions = new InteractionBroker({ serverEpoch: EPOCH });
		const requests: InteractionView[] = [];
		interactions.assign(ROOT, {
			async request(request) {
				const interaction = (request as ServerRpcRequest<"interaction/request">).params.interaction;
				requests.push(interaction);
				return {
					interactionId: interaction.interactionId,
					kind: "ask_user",
					cancelled: false,
					answers: [{ questionId: "question:0", choiceIds: ["choice:1"] }],
				};
			},
		});
		let taskId: string | undefined = "task-1";
		const tools = createAgentHostTools({
			rootSessionId: ROOT,
			agentId: CHILD,
			taskId: () => taskId,
			allowedToolNames: ["ask_user"],
			interactions,
		});
		const tool = tools.tools[0]!;
		const first = await tool.execute("question-1", question, undefined, undefined, {} as never);
		expect(first.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Remote") })]),
		);
		expect(requests[0]).toMatchObject({
			sessionId: ROOT,
			rootSessionId: ROOT,
			actorSessionId: CHILD,
			agentId: CHILD,
			taskId: "task-1",
		});
		taskId = "task-2";
		await tool.execute("question-2", question, undefined, undefined, {} as never);
		expect(requests[1]).toMatchObject({ taskId: "task-2" });
		taskId = undefined;
		await expect(tool.execute("question-3", question, undefined, undefined, {} as never)).rejects.toThrow(
			"active task identity",
		);
		expect(requests).toHaveLength(2);
	});

	it("rejects a response to another child's question instead of consuming its answer", async () => {
		const interactions = new InteractionBroker({ serverEpoch: EPOCH });
		const otherInteractionId = "99999999-9999-4999-8999-999999999999";
		interactions.assign(ROOT, {
			async request() {
				return {
					interactionId: otherInteractionId,
					kind: "ask_user",
					cancelled: false,
					answers: [{ questionId: "question:0", choiceIds: ["choice:1"] }],
				};
			},
		});
		const result = await interactions.requestUserInput(
			ROOT,
			{ ...question, questions: question.questions.map((q) => ({ ...q, multiple: false })) },
			{ rootSessionId: ROOT, actorSessionId: CHILD, agentId: CHILD, taskId: "task-1" },
		);
		expect(result).toEqual({ cancelled: true, answers: [] });
	});

	it("keeps child browser execution and preflight identity bound to the same task", async () => {
		const interactions = new InteractionBroker({ serverEpoch: EPOCH });
		const requests: ServerRpcRequest<"browser/tool">[] = [];
		const peer: InteractionPeer = {
			async request(request) {
				const browser = request as ServerRpcRequest<"browser/tool">;
				requests.push(browser);
				return {
					toolCallId: browser.params.toolCallId,
					result: { tool: "browser_tabs", details: { profiles: [], tabs: [] } },
				};
			},
		};
		interactions.assign(ROOT, peer);
		const { tools } = createAgentHostTools({
			rootSessionId: ROOT,
			agentId: CHILD,
			taskId: () => "task-1",
			allowedToolNames: ["browser_tabs"],
			interactions,
		});
		await tools[0]!.execute("list", { action: "list" }, undefined, undefined, {} as never);
		expect(requests[0]?.params).toMatchObject({
			sessionId: ROOT,
			rootSessionId: ROOT,
			actorSessionId: CHILD,
			agentId: CHILD,
			taskId: "task-1",
			call: { tool: "browser_tabs", input: { action: "list" } },
		});
	});

	it("persists delivered files in the child session and annotates the durable receipt with its real actor", async () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-child-host-"));
		const cwd = join(directory, "workspace");
		const agentDir = join(directory, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const manager = SessionManager.create(cwd, join(directory, "sessions"), { id: CHILD });
		onTestFinished(() => {
			manager.close();
			rmSync(directory, { recursive: true, force: true });
		});
		const artifacts = new SessionDeliveredArtifacts(agentDir, manager);
		const source = join(cwd, "report.txt");
		writeFileSync(source, "Child evidence");
		const { tools, automaticPermissionToolNames } = createAgentHostTools({
			rootSessionId: ROOT,
			agentId: CHILD,
			taskId: () => "delivery-task",
			allowedToolNames: ["deliver_file"],
			deliveredArtifacts: artifacts,
		});
		expect(automaticPermissionToolNames).toEqual([]);
		const result = await tools[0]!.execute("delivery", { path: source }, undefined, undefined, {} as never);
		const message = {
			role: "toolResult" as const,
			toolCallId: "delivery",
			toolName: "deliver_file",
			...result,
			isError: false,
			timestamp: Date.now(),
		};
		manager.appendMessage(message);
		expect(result.details).toMatchObject({
			rootSessionId: ROOT,
			actorSessionId: CHILD,
			agentId: CHILD,
			taskId: "delivery-task",
		});
		const artifact = artifacts.resolve(result.details.fileId)!;
		expect(artifact.path).toBe(realpathSync(source));
		expect(readFileSync(artifact.path, "utf8")).toBe("Child evidence");
		expect(manager.getDurableJournalSnapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.objectContaining({ details: expect.objectContaining({ agentId: CHILD }) }),
				}),
			]),
		);
	});
});
