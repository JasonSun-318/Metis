import type { ClientParams, ClientResult, SessionProcessView } from "@metis/app-protocol";
import type { FileEntry } from "@metis/coding-agent/host";
import { opaqueId } from "./item-projection.ts";
import { processOutput } from "./process-projector.ts";
import { AppServerError } from "./session-runtime-host.ts";

interface CommandRecord {
	readonly processId: string;
	readonly toolCallId: string;
	readonly turnId?: string;
	readonly agentId?: string;
	readonly call?: number;
	readonly startedAt?: string;
	result?: number;
	interrupted?: boolean;
}

/** Incremental identities only. Output stays in the existing disk-backed journal. */
export class ProcessHistory {
	private scanned = 0;
	private readonly commands: CommandRecord[] = [];
	private readonly byId = new Map<string, CommandRecord>();
	private latestAssistant?: number;
	retainedBytes = 0;

	private append(record: CommandRecord) {
		if (this.byId.has(record.processId)) return;
		this.byId.set(record.processId, record);
		this.commands.push(record);
		this.retainedBytes += Buffer.byteLength(JSON.stringify(record)) + 128;
	}

	index(journal: readonly FileEntry[], sessionId: string) {
		for (; this.scanned < journal.length; this.scanned++) {
			const entry = journal[this.scanned]!;
			if (entry.type === "custom" && entry.customType === "metis.process") {
				const data = entry.data as { agentId?: unknown; toolCallId?: unknown; turnId?: unknown } | null;
				if (
					!data ||
					typeof data.agentId !== "string" ||
					typeof data.toolCallId !== "string" ||
					(data.turnId !== undefined && typeof data.turnId !== "string")
				)
					throw new AppServerError("SESSION_CORRUPT", { sessionId });
				this.append({
					startedAt: entry.timestamp,
					agentId: data.agentId,
					toolCallId: data.toolCallId,
					...(data.turnId ? { turnId: data.turnId } : {}),
					processId: opaqueId(`${data.agentId}:${data.toolCallId}`, "process"),
				});
			} else if (entry.type === "runtime_tool" && entry.toolName === "bash") {
				const processId = opaqueId(`root:${entry.toolCallId}`, "process");
				if (entry.state === "started") {
					this.append({
						processId,
						startedAt: entry.timestamp,
						toolCallId: entry.toolCallId,
						turnId: opaqueId(entry.turnId, "turn"),
						call: this.latestAssistant,
					});
				} else if (entry.state === "interrupted") {
					const record = this.byId.get(processId);
					if (record) record.interrupted = true;
				}
			} else if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "assistant") {
					// Tool execution follows its durable assistant message. Keep that position
					// without reading tool arguments until a command is selected.
					this.latestAssistant = this.scanned;
				} else if (message.role === "toolResult" && message.toolName === "bash") {
					const processId = opaqueId(`root:${message.toolCallId}`, "process");
					// Legacy journals may predate runtime_tool boundaries.
					this.append({
						processId,
						toolCallId: message.toolCallId,
						call: this.latestAssistant,
						startedAt:
							(this.latestAssistant === undefined ? undefined : journal[this.latestAssistant]?.timestamp) ??
							entry.timestamp,
					});
					this.byId.get(processId)!.result = this.scanned;
				}
			}
		}
	}

	async read(
		journal: readonly FileEntry[],
		input: ClientParams<"session/readProcess">,
		live: (id: string) => SessionProcessView | undefined = () => undefined,
		readChild?: (agentId: string, toolCallId: string) => Promise<SessionProcessView | null>,
	): Promise<ClientResult<"session/readProcess">> {
		this.index(journal, input.sessionId);
		const total = this.commands.length;
		const index = input.processId
			? this.commands.findIndex((record) => record.processId === input.processId)
			: Math.min(input.index ?? total - 1, total - 1);
		if (total === 0) return { total, index: 0, process: null };
		const record = this.commands[index];
		if (!record) throw new AppServerError("INVALID_CURSOR", { sessionId: input.sessionId });
		const running = live(record.processId);
		if (running)
			return { total, index, process: { ...running, ...(record.startedAt ? { startedAt: record.startedAt } : {}) } };
		if (record.agentId && readChild) {
			let child: SessionProcessView | null;
			try {
				child = await readChild(record.agentId, record.toolCallId);
			} catch (error) {
				// Removing a child must not make the parent's remaining history unreadable.
				if (!(error instanceof AppServerError) || error.code !== "NOT_FOUND") throw error;
				return {
					total,
					index,
					process: {
						processId: record.processId,
						...(record.startedAt ? { startedAt: record.startedAt } : {}),
						command: "",
						output: "",
						truncated: false,
						state: "unavailable",
					},
				};
			}
			return {
				total,
				index,
				process: child
					? { ...child, processId: record.processId, ...(record.turnId ? { turnId: record.turnId } : {}) }
					: null,
			};
		}
		const entry = record.call === undefined ? undefined : journal[record.call];
		const block =
			entry?.type === "message" && entry.message.role === "assistant"
				? entry.message.content.find((block) => block.type === "toolCall" && block.id === record.toolCallId)
				: undefined;
		const command =
			block?.type === "toolCall" && typeof block.arguments.command === "string" ? block.arguments.command : "";
		const resultEntry = record.result === undefined ? undefined : journal[record.result];
		const result =
			resultEntry?.type === "message" && resultEntry.message.role === "toolResult" ? resultEntry.message : undefined;
		return {
			total,
			index,
			process: {
				processId: record.processId,
				...(record.startedAt ? { startedAt: record.startedAt } : {}),
				...(record.turnId ? { turnId: record.turnId } : {}),
				command: processOutput({ content: [{ type: "text", text: command }] }).output,
				state: record.interrupted || !result ? "interrupted" : result.isError ? "failed" : "completed",
				...processOutput(result),
			},
		};
	}
}
