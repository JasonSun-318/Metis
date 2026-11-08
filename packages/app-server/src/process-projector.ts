import type { SessionProcessView } from "@metis/app-protocol";
import type { AgentSessionEvent } from "@metis/coding-agent/host";
import { opaqueId } from "./item-projection.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;

export function processOutput(result: unknown): { output: string; truncated: boolean } {
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
	private readonly active = new Map<string, SessionProcessView>();
	private revision = 0;
	private readonly owners = new Map<string, string>();

	read(processId: string): SessionProcessView | undefined {
		return this.current?.processId === processId ? this.current : this.active.get(processId);
	}

	apply(event: AgentSessionEvent, agentId = "root", turnId?: string): SessionProcessView | undefined {
		if (event.type === "agent_end") {
			let changed = false;
			for (const [id, view] of this.active) {
				if (this.owners.get(id) !== agentId) continue;
				this.owners.delete(id);
				this.active.delete(id);
				if (this.current?.processId === id) this.current = { ...view, state: "interrupted" };
				changed = true;
			}
			if (changed && this.current) {
				this.current = { ...this.current, revision: ++this.revision };
				return this.current;
			}
			return;
		}
		if (event.type === "permission_review_started" || event.type === "permission_decision") {
			const processId = opaqueId(`${agentId}:${event.actionId}`, "process");
			const current = this.active.get(processId);
			if (!current) return;
			const next = {
				...current,
				state: event.type === "permission_review_started" ? ("awaiting_approval" as const) : ("running" as const),
			};
			this.active.set(processId, next);
			if (this.current?.processId !== processId) return;
			this.current = next;
			return this.current;
		}
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
				startedAt: new Date().toISOString(),
				...(turnId ? { turnId } : {}),
				revision: ++this.revision,
				command: processOutput({ content: [{ type: "text", text: command }] }).output,
				state: "running",
				output: "",
				truncated: false,
			};
			this.active.set(processId, this.current);
			this.owners.set(processId, agentId);
		} else {
			const current = this.active.get(processId);
			if (!current) return;
			const output = processOutput(event.type === "tool_execution_update" ? event.partialResult : event.result);
			const next: SessionProcessView = {
				...current,
				...output,
				truncated: current.truncated || output.truncated,
				state: event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : "running",
			};
			if (event.type === "tool_execution_end") {
				this.active.delete(processId);
				this.owners.delete(processId);
			} else this.active.set(processId, next);
			if (this.current?.processId === processId) this.current = next;
			else if (event.type === "tool_execution_update") return;
			if (event.type === "tool_execution_end" && this.current)
				this.current = { ...this.current, revision: ++this.revision };
		}
		return this.current;
	}
}
