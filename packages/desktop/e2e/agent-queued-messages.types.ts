export type QueueChild = "a" | "b";

export interface QueueMutationCall {
	readonly agentId: string;
	readonly queueItemId: string;
	readonly expectedRevision: string;
	readonly delivery?: "steer" | "start";
}

export interface AgentQueueFixture {
	readonly calls: {
		readonly messages: { agentId: string; delivery: string; text: string }[];
		readonly guides: QueueMutationCall[];
		readonly deleted: QueueMutationCall[];
		readonly consumed: string[];
		readonly errors: string[];
		readonly notices: string[];
		readonly queueReads: Record<QueueChild, number>;
	};
	seedQueue(child: QueueChild, text: string, attachment?: boolean, notify?: boolean): string;
	complete(child: QueueChild): void;
	setRunning(child: QueueChild, running: boolean): void;
	disconnect(): void;
	ready(changedEpoch?: boolean): void;
	holdGuide(): void;
	releaseGuide(): void;
	failNextGuide(): void;
	block(child: QueueChild, kind: "ask_user" | "session_permission_approval" | null): void;
	remember(child: QueueChild): void;
	nodesPreserved(child: QueueChild): boolean;
}
