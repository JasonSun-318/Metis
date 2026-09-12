import type { SessionProcessView } from "@metis/app-protocol";
import type { AgentSessionEvent } from "@metis/coding-agent";
import { opaqueId } from "./item-projection.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;

function outputView(result: unknown): { output: string; truncated: boolean } {
	const value = result as
		| { content?: { type?: string; text?: string }[]; details?: { truncation?: { truncated?: boolean } } }
		| undefined;
	const text = (value?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	const bytes = Buffer.from(text);
	let start = Math.max(0, bytes.length - MAX_OUTPUT_BYTES);
	// Keep the bounded tail on a UTF-8 character boundary.
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return {
		output: bytes.subarray(start).toString("utf8"),
		truncated: start > 0 || value?.details?.truncation?.truncated === true,
	};
}

/** One current command per session; older concurrent commands cannot overwrite it. */
export class ProcessProjector {
	private current?: SessionProcessView;

	apply(event: AgentSessionEvent, agentId = "root"): SessionProcessView | undefined {
		if (
			event.type !== "tool_execution_start" &&
			event.type !== "tool_execution_update" &&
			event.type !== "tool_execution_end"
		)
			return;
		if (event.toolName !== "bash") return;
		const processId = opaqueId(`${agentId}:${event.toolCallId}`, "process");
		if (event.type === "tool_execution_start") {
			const command = (event.args as { command?: unknown })?.command;
			if (typeof command !== "string") return;
			this.current = {
				processId,
				command: outputView({ content: [{ type: "text", text: command }] }).output,
				state: "running",
				output: "",
				truncated: false,
			};
		} else {
			if (this.current?.processId !== processId || this.current.state !== "running") return;
			const output = outputView(event.type === "tool_execution_update" ? event.partialResult : event.result);
			this.current = {
				...this.current,
				...output,
				truncated: this.current.truncated || output.truncated,
				state: event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : "running",
			};
		}
		return this.current;
	}
}
