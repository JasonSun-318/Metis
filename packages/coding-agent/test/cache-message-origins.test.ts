import type { AgentMessage } from "@metis/agent-core";
import { expect, it } from "vitest";
import { convertToLlm, convertToLlmWithOrigins } from "../src/core/messages.ts";

it("preserves duplicate messages while tracking their distinct durable origins", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "same", timestamp: 1 },
		{ role: "custom", customType: "metis_plan_context", content: "same", display: false, timestamp: 2 },
	];
	const origins = [
		{ id: "entry:a", kind: "stable" as const },
		{ id: "request:plan", kind: "volatile" as const },
	];
	const result = convertToLlmWithOrigins(messages, origins);
	expect(result.messages).toEqual(convertToLlm(messages));
	expect(result.origins).toEqual(origins);
	expect(() => convertToLlmWithOrigins(messages, [])).toThrow("origin count");
});

it("drops excluded shell messages and their origins together", () => {
	const messages: AgentMessage[] = [
		{
			role: "bashExecution",
			command: "echo secret",
			output: "secret",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 1,
		},
		{ role: "user", content: "visible", timestamp: 2 },
	];
	const result = convertToLlmWithOrigins(messages, [
		{ id: "entry:shell", kind: "stable" },
		{ id: "entry:user", kind: "stable" },
	]);
	expect(result.messages).toEqual([{ role: "user", content: "visible", timestamp: 2 }]);
	expect(result.origins).toEqual([{ id: "entry:user", kind: "stable" }]);
});
