import { createServer } from "node:http";
import {
	closeServer,
	listen,
	messageText,
	readOpenAiChatRequest,
	respondWithText,
	respondWithToolCall,
} from "./packaged-app-harness.ts";
import { createSubagentEnvironment } from "./subagent-conversations.fixture.ts";

export const REPLAY_WORKER = "Persistent replay worker";
export const REPEAT_TASK = "REPLAY_TASK_REPEAT: Read-only fixture verification. Report the evidence briefly.";

export async function createReplayFixture() {
	let agentId = "";
	let release: (() => void) | undefined;
	let gate: Promise<void> | undefined;
	const calls: Array<{ child: boolean; prompt: string }> = [];
	const server = createServer(async (request, response) => {
		try {
			const { messages = [] } = await readOpenAiChatRequest(request);
			const system = messages
				.filter((entry) => entry.role === "system" || entry.role === "developer")
				.map((entry) => messageText(entry.content))
				.join("\n");
			if (system.includes("conversation title generator")) {
				respondWithText(response, "Replay acceptance");
				return;
			}
			const child = system.includes("<agent_contract>");
			if (child) {
				const prompt = messageText([...messages].reverse().find((entry) => entry.role === "user")?.content);
				calls.push({ child, prompt });
				if (gate) await gate;
				respondWithText(
					response,
					prompt.includes(REPEAT_TASK)
						? "Read-only fixture verification complete."
						: "The assigned fixture boundary is verified.",
				);
				return;
			}
			const marker = [...messages]
				.reverse()
				.find((entry) => entry.role === "user" && messageText(entry.content).startsWith("REPLAY_PARENT_"));
			const index = marker ? messages.indexOf(marker) : -1;
			const prompt = messageText(messages[index]?.content);
			calls.push({ child, prompt });
			if (index < 0 || messages.slice(index + 1).some((entry) => entry.role === "tool")) {
				respondWithText(response, "Parent observed the task result.");
				return;
			}
			// Each fixture request has a valid, unique provider call ID.
			respondWithToolCall(
				response,
				prompt.includes("CREATE")
					? {
							callId: `call-${prompt.toLowerCase()}`,
							name: "spawn_agent",
							arguments: {
								name: REPLAY_WORKER,
								agentType: "worker",
								task: `REPLAY_TASK_INITIAL: Check the fixture only.\n\n${Array.from({ length: 18 }, (_, index) => `Evidence condition ${index + 1}: inspect only the local fixture and preserve the original files.`).join("\n\n")}`,
							},
						}
					: {
							callId: `call-${prompt.toLowerCase()}`,
							name: "followup_task",
							arguments: {
								agentId,
								task: prompt.includes("DIFFERENT")
									? "REPLAY_TASK_DIFFERENT: Check a new boundary."
									: REPEAT_TASK,
							},
						},
			);
		} catch {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	});
	const port = await listen(server);
	try {
		const environment = await createSubagentEnvironment({
			providerId: "replay-fixture",
			modelId: "replay-model",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			apiKey: "local-fixture-key",
		});
		return {
			environment,
			calls,
			setAgentId: (id: string) => {
				agentId = id;
			},
			hold: () => {
				gate = new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			release: () => {
				release?.();
				release = undefined;
				gate = undefined;
			},
			close: async () => {
				release?.();
				await closeServer(server);
			},
		};
	} catch (error) {
		await closeServer(server);
		throw error;
	}
}
