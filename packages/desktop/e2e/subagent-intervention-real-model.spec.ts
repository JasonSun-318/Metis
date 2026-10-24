import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { messageText } from "./packaged-app-harness.ts";
import {
	type AgentItemRecord,
	type AgentRecord,
	closeSubagentApp,
	createRealModelProxy,
	createSubagentEnvironment,
	createSubagentSession,
	launchSubagentApp,
	listSubagents,
	loadRealModelConfig,
	openAgentConversation,
	readSessionItems,
	readSubagentItems,
	removeSubagentEnvironment,
	saveSubagentEvidence,
	sendParentPrompt,
	sessionModel,
	type SubagentEnvironment,
	waitForModelRequest,
} from "./subagent-conversations.fixture.ts";

const START = "INTERVENTION_REAL_START";
const FINAL = "INTERVENTION_PARENT_FINAL";
const CORRECTION = "不用看了。停止后只回复「明白，就到这里」，不要重复报告；不要再调用工具或继续任务。";

function itemText(item: AgentItemRecord): string {
	return item.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

interface DurableAgentInput {
	readonly type: "agent_input";
	readonly agentId: string;
	readonly taskId: string;
	readonly messageId: string;
	readonly delivery: "steer" | "start" | "queue";
	readonly state: string;
	readonly instructionRevision: number;
	readonly origin: { readonly kind: string };
	readonly input: { readonly text: string };
}

/** Read only this test's isolated child journal, never the user's profile. */
async function readHumanInput(
	environment: SubagentEnvironment,
	parentId: string,
	agentId: string,
): Promise<DurableAgentInput | undefined> {
	const directory = path.join(environment.agentDir, "agents", parentId);
	const filename = (await readdir(directory)).find((name) => name.endsWith(`_${agentId}.jsonl`));
	if (!filename) return undefined;
	const journal = await readFile(path.join(directory, filename), "utf8");
	let latest: DurableAgentInput | undefined;
	for (const line of journal.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as Partial<DurableAgentInput>;
		if (entry.type === "agent_input" && entry.origin?.kind === "user" && entry.input?.text === CORRECTION)
			latest = entry as DurableAgentInput;
	}
	return latest;
}

test("code: deepseek-v4.1-flash reconciles an earlier report after a same-task human stop message", async ({}, testInfo) => {
	test.skip(process.env.METIS_SUBAGENT_REAL_MODEL_TEST !== "1", "Explicit opt-in for real-model quota");
	test.setTimeout(480_000);
	const deadline = Date.now() + 450_000;
	const remaining = (maximum = 180_000) => Math.max(1, Math.min(maximum, deadline - Date.now()));
	const configDir = process.env.METIS_SUBAGENT_MODEL_CONFIG_DIR;
	expect(configDir, "METIS_SUBAGENT_MODEL_CONFIG_DIR is required").toBeTruthy();
	expect(path.isAbsolute(configDir ?? ""), "The supplied model config directory must be absolute").toBe(true);
	const real = await loadRealModelConfig(configDir!);
	expect(real.modelId).toBe("deepseek-v4.1-flash");
	const proxy = await createRealModelProxy(real.provider.baseUrl);
	const environment = await createSubagentEnvironment({
		providerId: real.providerId,
		modelId: real.modelId,
		baseUrl: proxy.url,
		...(real.provider.apiKey === undefined ? {} : { apiKey: real.provider.apiKey }),
		providerConfig: real.providerConfig,
		modelConfig: real.modelConfig,
		credential: real.credential,
	});
	const reportMarker = `PRIOR-REPORT-${randomUUID()}`;
	const parentMarker = `PARENT-CHECK-${randomUUID()}`;
	const parentFixturePath = path.join(environment.projectDir, "parent-check.txt");
	await writeFile(parentFixturePath, `independent_parent_marker: ${parentMarker}\n`, "utf8");
	const fixturePath = path.join(environment.projectDir, "intervention-evidence.txt");
	await writeFile(fixturePath, `report_marker: ${reportMarker}\nfirst_value: 17\nsecond_value: 25\n`, "utf8");
	let app: Awaited<ReturnType<typeof launchSubagentApp>> | undefined;
	let child: AgentRecord | undefined;
	let receipt: DurableAgentInput | undefined;
	let reportWasVisibleWhileRunning = false;
	let inspectedPriorReport = false;
	let parentAcknowledgedExistingOutput = false;
	let childRequestCountAfterTerminal: number | undefined;
	let completed = false;
	let independentParentWorkCompleted = false;
	let parentKeptObserverRole = false;
	let toolResultsPaired = false;
	try {
		app = await launchSubagentApp(environment);
		const page = app.page;
		const parentId = await createSubagentSession(page, environment, "code", "Real model intervention reconciliation");
		expect(await sessionModel(page, parentId)).toMatchObject({ provider: real.providerId, modelId: real.modelId });
		await sendParentPrompt(page, `${START}
You are the parent in a local, read-only collaboration acceptance task. Work only in ${environment.projectDir}.
Create exactly one persistent child with the worker role and read and bash tools. Give it this self-contained assignment:
1. Read ${fixturePath} using the read tool. Report the exact report_marker and the sum of first_value plus second_value in one short, visible Chinese sentence.
2. That report must be visible assistant text in the SAME response that calls bash with the command "sleep 15". Do not finish the task between the report and this single read-only waiting step. Do not run any other commands or change files.
3. After that waiting step, finish concisely. A human may send an instruction directly to the child while it is running; honor that instruction before continuing. Do not delegate.
After spawning, end your current reply with "已委派，等待子代理结果". Do not call wait_agents, read the evidence file yourself, or keep polling the child. Background notifications should continue the conversation.
You also have your own separate assignment: after receiving a human-intervention notification, read ${parentFixturePath} yourself and include its independent_parent_marker in your final answer. Do not delegate this separate assignment or send that file path to the child.
When human intervention or a terminal result arrives, reconcile it with the task's existing work. Verify any claim about whether a report was produced using existing task evidence; respect the latest human instruction and do not restart, send follow-up work to, or otherwise continue the child's task. If the child is still running, wait for its terminal notification without polling.
Once the terminal result is reconciled, answer briefly in Chinese with ${FINAL}, the observed report marker and sum if supported by existing evidence, your independent_parent_marker, and what the user's intervention changed. Do not invent results. No external network tools or user files.`);

		await expect.poll(async () => {
			const agents = await listSubagents(page, parentId);
			expect(agents.length, "The parent must create exactly one child").toBeLessThanOrEqual(1);
			child = agents[0];
			return child !== undefined;
		}, { timeout: remaining() }).toBe(true);
		const selectedChild = (await listSubagents(page, parentId))[0];
		if (!selectedChild) throw new Error("The parent did not create a child");
		child = selectedChild;
		expect(selectedChild.parentSessionId).toBe(parentId);
		expect(selectedChild.model).toMatchObject({ provider: real.providerId, modelId: real.modelId });
		expect(selectedChild.tools).toEqual(expect.arrayContaining(["read", "bash"]));
		const taskId = selectedChild.currentTask?.taskId ?? selectedChild.latestTask?.taskId ?? selectedChild.tasks[0]?.taskId;
		expect(taskId).toBeTruthy();
		if (!taskId) throw new Error("The child has no initial task");
		await expect.poll(async () => (await readSessionItems(page, parentId)).some((item) =>
			item.role === "assistant" && item.state === "completed" && itemText(item).includes("已委派，等待子代理结果")),
		{ timeout: remaining() }).toBe(true);

		await expect.poll(async () => {
			const current = (await listSubagents(page, parentId)).find((agent) => agent.agentId === selectedChild.agentId);
			const items = await readSubagentItems(page, parentId, selectedChild.agentId, taskId);
			const report = items.find((item) => item.role === "assistant" && itemText(item).includes(reportMarker));
			if (current?.status === "done" || current?.status === "failed" || current?.status === "stopped")
				throw new Error("The child ended before a report and human steering could overlap in the same task");
			reportWasVisibleWhileRunning = current?.status === "running" && report !== undefined;
			return reportWasVisibleWhileRunning;
		}, { timeout: remaining(), intervals: [200, 300, 500] }).toBe(true);

		await openAgentConversation(page, selectedChild.name);
		const conversation = page.locator(`[data-agent-id="${selectedChild.agentId}"]`);
		const composer = page.locator(`#agent-composer-${selectedChild.agentId}`);
		await expect(composer).toHaveAttribute("contenteditable", "true");
		await expect(conversation.getByRole("button", { name: "Message timing", exact: true })).toContainText("During current task");
		const parentItemsBeforeCorrection = new Set((await readSessionItems(page, parentId)).map((item) => item.itemId));
		await composer.fill(CORRECTION);
		await conversation.getByRole("button", { name: "Queue message", exact: true }).click();
		await expect.poll(async () => {
			receipt = await readHumanInput(environment, parentId, selectedChild.agentId);
			return receipt !== undefined;
		}, { timeout: remaining(15_000) }).toBe(true);
		const accepted = await readHumanInput(environment, parentId, selectedChild.agentId);
		if (!accepted) throw new Error("The UI message has no durable input receipt");
		receipt = accepted;
		expect(accepted).toMatchObject({ agentId: selectedChild.agentId, taskId, delivery: "steer", origin: { kind: "user" } });
		expect(accepted.instructionRevision).toBeGreaterThanOrEqual(2);

		const correctionRequest = await waitForModelRequest(proxy, (request) =>
			request.isChild && request.agentId === selectedChild.agentId && request.userTexts.some((text) => text.includes(CORRECTION)), remaining());
		const readResultReachedChild = proxy.requests.some((request) => request.isChild && request.agentId === selectedChild.agentId && request.spawnNames.includes("read") &&
			request.messages.some((message) => message.role === "tool" && messageText(message.content).includes(reportMarker)));
		expect(readResultReachedChild, "The child must really read the unpredictable fixture marker").toBe(true);
		expect(correctionRequest.model).toBe("deepseek-v4.1-flash");

		let finishedChild: AgentRecord | undefined;
		await expect.poll(async () => {
			const agents = await listSubagents(page, parentId);
			expect(agents).toHaveLength(1);
			finishedChild = agents.find((agent) => agent.agentId === selectedChild.agentId);
			return finishedChild?.status;
		}, { timeout: remaining() }).toBe("done");
		const completedChild = (await listSubagents(page, parentId)).find((agent) => agent.agentId === selectedChild.agentId);
		expect(completedChild?.status).toBe("done");
		const completedTask = completedChild?.tasks.find((task) => task.taskId === taskId);
		const completedResult = [completedChild?.currentTask, completedChild?.latestTask].find((task) => task?.taskId === taskId);
		expect(completedChild?.tasks).toHaveLength(1);
		expect(completedTask?.consumedInstructionRevision).toBeGreaterThanOrEqual(accepted.instructionRevision);
		expect(completedResult?.finalMessage?.trim()).toMatch(/^明白[，,]\s*就到这里[。.!！]?$/u);
		expect(completedResult?.finalMessage).not.toContain(reportMarker);
		const afterCorrectionMessages = correctionRequest.messages;
		expect(afterCorrectionMessages.some((message) => message.role === "assistant" && messageText(message.content).includes(reportMarker))).toBe(true);
		const childModelRequestsAtTerminal = proxy.requests.filter((request) => request.isChild && request.agentId === selectedChild.agentId).length;

		const terminalRequest = await waitForModelRequest(proxy, (request) => !request.isChild &&
			request.mailboxEvents.some((event) => event.type === "terminal" && event.agentId === selectedChild.agentId && event.taskId === taskId), remaining());
		const reconciledRequest = await waitForModelRequest(proxy, (request) => !request.isChild && request.index >= terminalRequest.index &&
			request.spawnNames.includes("inspect_agents") &&
			request.messages.some((message) => message.role === "tool" && messageText(message.content).includes(`Task ${taskId}`) &&
				messageText(message.content).includes("[LLM]") && messageText(message.content).includes(reportMarker)), remaining());
		inspectedPriorReport = reconciledRequest !== undefined;
		expect(proxy.requests.filter((request) => !request.isChild).flatMap((request) => request.mailboxEvents)).toEqual(expect.arrayContaining([expect.objectContaining({
			type: "intervention", agentId: selectedChild.agentId, taskId, messageId: accepted.messageId,
			delivery: "steer", instructionRevision: accepted.instructionRevision,
		})]));
		let finalParentText = "";
		await expect.poll(async () => {
			const items = await readSessionItems(page, parentId);
			const final = items.filter((item) => item.role === "assistant" && item.state === "completed")
				.reverse().find((item) => itemText(item).includes(FINAL));
			finalParentText = final ? itemText(final) : "";
			return final !== undefined;
		}, { timeout: remaining() }).toBe(true);
		// The unpredictable marker is known only through the inspected earlier
		// report. Check evidence and claims, rather than one Chinese phrasing.
		expect(finalParentText).toContain(reportMarker);
		expect(finalParentText).toMatch(/\b42\b/u);
		expect(finalParentText).not.toMatch(/(?:没有|尚未|未曾|并未).{0,6}(?:产出|生成|完成|给出).{0,6}报告/u);
		parentAcknowledgedExistingOutput = true;

		const firstInterventionIndex = proxy.requests.find((request) => !request.isChild && request.mailboxEvents.some((event) => event.type === "intervention"))?.index;
		const firstParentEvidenceIndex = proxy.requests.find((request) => !request.isChild && request.messages.some((message) => message.role === "tool" && messageText(message.content).includes(parentMarker)))?.index;
		expect(firstInterventionIndex).toBeDefined();
		expect(firstParentEvidenceIndex, "A child-scoped stop must not cancel the parent's independent assignment").toBeGreaterThan(firstInterventionIndex!);
		independentParentWorkCompleted = true;
		const parentItems = await readSessionItems(page, parentId);
		const publicParentReplies = parentItems.filter((item) => !parentItemsBeforeCorrection.has(item.itemId) &&
			item.role === "assistant" && item.state === "completed" && !item.content.some((block) => block.type === "tool_call"))
			.map(itemText).filter(Boolean);
		expect(publicParentReplies.length).toBeGreaterThan(0);
		for (const text of publicParentReplies) {
			expect(text.trim(), "The parent must not answer as the instructed child").not.toMatch(/^明白[，,]\s*就到这里/u);
			expect(text).not.toMatch(/instructionRevision|deliveryState|agent_mailbox|已停止后续动作/u);
		}
		expect(publicParentReplies.join("\n")).toContain(parentMarker);
		parentKeptObserverRole = true;
		const calls = parentItems.flatMap((item) => item.content.filter((block) => block.type === "tool_call")
			.map((block) => ({ item, toolCallId: block.toolCallId })));
		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls) {
			const result = parentItems.find((item) => item.content.some((block) => block.type === "tool_result" && block.toolCallId === call.toolCallId));
			expect(call.item.turnId, "All real root tool calls, including automatic continuations, need a durable turn").toBeTruthy();
			expect(result?.turnId, "A result must share its call's turn rather than rendering as an orphan card").toBe(call.item.turnId);
		}
		toolResultsPaired = true;

		await page.waitForTimeout(1_500);
		const finalAgents = await listSubagents(page, parentId);
		expect(finalAgents).toHaveLength(1);
		expect(finalAgents[0]?.tasks).toHaveLength(1);
		expect(finalAgents[0]?.tasks[0]?.taskId).toBe(taskId);
		childRequestCountAfterTerminal = proxy.requests.filter((request) => request.isChild && request.agentId === selectedChild.agentId).length - childModelRequestsAtTerminal;
		expect(childRequestCountAfterTerminal, "Reconciliation must not resume the child's work").toBe(0);
		const finalChildItems = await readSubagentItems(page, parentId, selectedChild.agentId, taskId);
		expect(finalChildItems.some((item) => item.role === "assistant" && itemText(item).includes(reportMarker))).toBe(true);
		const humanItemIndex = finalChildItems.findIndex((item) => item.agentMessageId === accepted.messageId && item.role === "user");
		expect(humanItemIndex).toBeGreaterThanOrEqual(0);
		expect(finalChildItems.slice(humanItemIndex + 1).some((item) =>
			item.role === "tool" || item.content.some((block) => block.type === "tool_call")),
		"After consuming the stop message, the child must not call more tools").toBe(false);
		expect((await readHumanInput(environment, parentId, selectedChild.agentId))?.state).toBe("delivered");
		for (const request of proxy.requests.filter((request) => request.isChild || request.userTexts.some((text) => text.includes(START)) || request.mailboxEvents.length > 0))
			expect(request.model).toBe("deepseek-v4.1-flash");
		await page.screenshot({ path: testInfo.outputPath("subagent-intervention-child.png") });
		await conversation.getByRole("button", { name: "Open parent conversation", exact: true }).first().click();
		await expect(page.locator("#composer-input")).toBeVisible();
		await expect(page.locator(".transcript-code:visible .code-execution").first()).toBeVisible();
		const parentScroll = page.locator(".transcript-code:visible .transcript-scroll");
		await expect.poll(async () => parentScroll.evaluate((node) => {
			node.scrollTop = node.scrollHeight;
			return node.scrollHeight - node.scrollTop - node.clientHeight;
		})).toBeLessThan(2);
		// Returning to a tab remounts the virtual rows and replays the existing
		// tool-title animation. Capture the finished card, not its entering label.
		await page.evaluate(async () => {
			await Promise.all(document.getAnimations().filter((animation) =>
				Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))
				.map((animation) => animation.finished.catch(() => undefined)));
		});
		await expect.poll(async () => parentScroll.evaluate((node) => {
			const rows = Array.from(node.querySelectorAll<HTMLElement>(".code-transcript-turn"))
				.map((row) => row.getBoundingClientRect()).sort((left, right) => left.top - right.top);
			return rows.every((row, index) => index === 0 || row.top >= rows[index - 1]!.bottom - 1);
		})).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("subagent-intervention-parent.png") });
		completed = true;
	} finally {
		await saveSubagentEvidence(testInfo, "subagent-intervention-real-evidence.json", {
			completed,
			model: real.modelId,
			requestCount: proxy.requests.length,
			parentRequests: proxy.requests.filter((request) => !request.isChild).length,
			childRequests: proxy.requests.filter((request) => request.isChild).length,
			agentId: child?.agentId,
			receipt: receipt && { taskId: receipt.taskId, delivery: receipt.delivery, instructionRevision: receipt.instructionRevision },
			reportWasVisibleWhileRunning,
			inspectedPriorReport,
			parentAcknowledgedExistingOutput,
			childRequestCountAfterTerminal,
			independentParentWorkCompleted,
			parentKeptObserverRole,
			toolResultsPaired,
			requestChecks: proxy.requests.map((request) => ({
				index: request.index,
				isChild: request.isChild,
				hasHumanCorrection: request.userTexts.some((text) => text.includes(CORRECTION)),
				hasTerminal: request.mailboxEvents.some((event) => event.type === "terminal"),
				inspected: request.spawnNames.includes("inspect_agents"),
				sawReportInToolOutput: request.messages.some((message) => message.role === "tool" && messageText(message.content).includes(reportMarker)),
			})),
		});
		if (app) await closeSubagentApp(app).catch(() => undefined);
		await proxy.close();
		await removeSubagentEnvironment(environment);
	}
});
