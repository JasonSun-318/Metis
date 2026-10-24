import { createHash } from "node:crypto";
import { parseDurablePromptSubmission } from "../runtime-recovery.ts";
import {
	type AgentDeliveryMode,
	AgentError,
	type AgentMessageActor,
	type AgentSubmitMessageInput,
	MAX_AGENT_INPUT_UTF8_BYTES,
} from "./types.ts";

/** Admission is decided under the target agent's serialization queue. */
export function decideAgentDelivery(running: boolean, mode: AgentDeliveryMode): "steer" | "start" | "queue" | "reject" {
	if (mode === "steer") return running ? "steer" : "reject";
	return running ? (mode === "queue" ? "queue" : "steer") : "start";
}

export function validateAgentSubmission(
	actor: AgentMessageActor,
	submission: AgentSubmitMessageInput,
): { input: AgentSubmitMessageInput["input"]; requestHash: string } {
	if (actor.kind !== "user" && actor.kind !== "agent")
		throw new AgentError("INVALID_INPUT", "Invalid trusted message actor");
	if (submission.delivery !== undefined && !["auto", "steer", "queue"].includes(submission.delivery))
		throw new AgentError("INVALID_INPUT", "Invalid delivery mode");
	const { input } = parseDurablePromptSubmission({ requestId: submission.requestId, ...submission.input });
	if (Buffer.byteLength(input.text, "utf8") > MAX_AGENT_INPUT_UTF8_BYTES)
		throw new AgentError("INVALID_INPUT", "Agent input exceeds 64 KiB");
	if (!input.text.trim() && !input.images?.length)
		throw new AgentError("INVALID_INPUT", "Agent input must contain text or images");
	if (input.planExecution || input.streamingBehavior)
		throw new AgentError("INVALID_INPUT", "Agent input delivery is selected by the server");
	const requestHash = createHash("sha256")
		.update(JSON.stringify({ actor, agentId: submission.agentId, delivery: submission.delivery ?? "auto", input }))
		.digest("hex");
	return { input, requestHash };
}
