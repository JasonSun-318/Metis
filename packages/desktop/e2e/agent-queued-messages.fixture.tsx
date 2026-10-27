import type { AgentSummaryView, ClientParams, DomainEvent, ItemView, QueuedTurnView } from "@metis/app-protocol";
import { createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentConversation } from "../src/renderer/components/AgentConversation.tsx";
import type { SessionChatViewContext } from "../src/renderer/components/SessionChatView.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	COMPOSER_EPOCH,
	COMPOSER_SESSION_ID,
	composerInteraction,
	composerSnapshot,
} from "../test/fixtures/composer-session.ts";
import type { AgentQueueFixture, QueueChild, QueueMutationCall } from "./agent-queued-messages.types.ts";

const ROOT = COMPOSER_SESSION_ID;
const IDS: Record<QueueChild, string> = {
	a: "33333333-3333-4333-8333-333333333333",
	b: "44444444-4444-4444-8444-444444444444",
};
const params = new URLSearchParams(location.search);
const started = Date.now() - 1000;
const timestamp = (offset = 0) => new Date(started + offset).toISOString();
document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.platform = "darwin";
document.documentElement.dataset.motion = params.has("reduced") ? "reduced" : "full";
const store = new AppStore();
const listeners = new Set<(event: DesktopApiEvent) => void>();
const queues: Record<QueueChild, QueuedTurnView[]> = { a: [], b: [] };
const histories: Record<QueueChild, ItemView[]> = { a: [], b: [] };
const agents: Record<QueueChild, AgentSummaryView> = Object.fromEntries(
	(["a", "b"] as const).map((key) => {
		const task = {
			taskId: `task-${key}`,
			status: "running" as const,
			taskSummary: `Task ${key}`,
			createdAt: timestamp(),
			updatedAt: timestamp(),
		};
		return [
			key,
			{
				agentId: IDS[key],
				parentSessionId: ROOT,
				rootSessionId: ROOT,
				agentPath: [IDS[key]],
				depth: 1,
				name: `Worker ${key.toUpperCase()}`,
				agentType: "worker",
				mode: "chat",
				status: "running",
				runControl: "enabled",
				archived: false,
				tasks: [task],
				currentTask: task,
				latestTask: task,
				createdAt: timestamp(-100000),
				updatedAt: timestamp(),
			},
		];
	}),
) as Record<QueueChild, AgentSummaryView>;
for (const key of ["a", "b"] as const) {
	histories[key] = Array.from({ length: 32 }, (_, index) => ({
		itemId: `${key}-history-${index}`,
		sessionId: IDS[key],
		turnId: `${key}-history-turn-${index}`,
		role: "assistant",
		state: "completed",
		createdAt: timestamp(-100000 + index * 1000),
		content: [
			{
				type: "text",
				text: `Worker ${key.toUpperCase()} history ${index + 1}. ${"Earlier context stays available while queued messages are managed. ".repeat(4)}`,
			},
		],
	}));
}
const calls = {
	messages: [] as { agentId: string; delivery: string; text: string }[],
	guides: [] as QueueMutationCall[],
	deleted: [] as QueueMutationCall[],
	consumed: [] as string[],
	errors: [] as string[],
	notices: [] as string[],
	queueReads: { a: 0, b: 0 },
};
let epoch = COMPOSER_EPOCH;
let cursor = 0;
let sequence = 0;
let failGuide = false;
let guideHold: Promise<void> | undefined;
let releaseGuide: (() => void) | undefined;
let showNotice: (notice: string | null) => void = () => undefined;
const remembered = new Map<QueueChild, readonly (Element | null)[]>();
function keyFor(sessionId: string, agentId: string): QueueChild {
	if (sessionId !== ROOT) throw new Error("Unexpected root in queue fixture");
	const key = (["a", "b"] as const).find((candidate) => IDS[candidate] === agentId);
	if (!key) throw new Error("Unexpected child in queue fixture");
	return key;
}
function emit(event: DesktopApiEvent) {
	for (const listener of listeners) listener(event);
}
function changes(events: DomainEvent[]) {
	cursor += 1;
	emit({
		type: "app-server",
		envelope: {
			jsonrpc: "2.0",
			method: "connection/events",
			params: { serverEpoch: epoch, fromCursor: cursor, toCursor: cursor, events },
		},
	});
}
function notify(key: QueueChild) {
	agents[key] = { ...agents[key], updatedAt: timestamp(++sequence * 1000) };
	changes([{ type: "agent/updated", sessionId: ROOT, agent: structuredClone(agents[key]) }]);
}
function supervisor(state: "ready" | "restarting") {
	const view = { state, serverEpoch: epoch, restartAttempt: state === "restarting" ? 1 : 0, failure: null };
	store.setSupervisor(view);
	emit({ type: "supervisor", view });
}
function seedQueue(key: QueueChild, text: string, attachment = false, publish = true): string {
	const queueItemId = `${key}-queued-${++sequence}`;
	queues[key].push({
		queueItemId,
		revision: `${queueItemId}-revision`,
		state: "queued",
		text,
		attachments: attachment ? [{ name: "fixture.txt", byteLength: 10 }] : [],
	});
	// Include the durable receipt too, so duplicate transcript filtering is exercised.
	histories[key].push({
		itemId: `agent-input:${queueItemId}`,
		sessionId: IDS[key],
		role: "user",
		origin: { kind: "user" },
		state: "completed",
		deliveryState: "queued",
		agentMessageId: queueItemId,
		createdAt: timestamp(sequence * 1000),
		content: [{ type: "text", text }],
	});
	if (publish) notify(key);
	return queueItemId;
}
function queued(key: QueueChild, id: string, revision: string): QueuedTurnView {
	const turn = queues[key].find((candidate) => candidate.queueItemId === id);
	if (!turn || turn.revision !== revision) throw new Error("Stale or cross-child queue mutation");
	return turn;
}
function setRunning(key: QueueChild, running: boolean) {
	const task = {
		...agents[key].latestTask!,
		status: running ? ("running" as const) : ("done" as const),
		updatedAt: timestamp(++sequence * 1000),
	};
	agents[key] = {
		...agents[key],
		status: running ? "running" : "done",
		tasks: [task],
		latestTask: task,
		currentTask: running ? task : undefined,
	};
	notify(key);
}
const api = {
	listAgents: async () => ({ agents: structuredClone(Object.values(agents)), nextAfterAgentId: null }),
	readAgentItems: async ({ sessionId, agentId }: ClientParams<"agent/readItems">) => ({
		items: structuredClone(histories[keyFor(sessionId, agentId)]),
		nextBeforeItemId: null,
	}),
	readAgentQueuedMessages: async ({ sessionId, agentId }: ClientParams<"agent/queue/read">) => {
		const key = keyFor(sessionId, agentId);
		calls.queueReads[key] += 1;
		return { queuedTurns: structuredClone(queues[key]) };
	},
	subscribe: (listener: (event: DesktopApiEvent) => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	sendAgentMessage: async (input: ClientParams<"agent/send">) => {
		const key = keyFor(input.sessionId, input.agentId);
		calls.messages.push({ agentId: input.agentId, delivery: input.delivery ?? "auto", text: input.input.text });
		const queue = input.delivery === "queue";
		const messageId = queue ? seedQueue(key, input.input.text) : `${key}-direct-${++sequence}`;
		if (!queue) {
			histories[key].push({
				itemId: messageId,
				sessionId: IDS[key],
				turnId: `${key}-direct-turn`,
				role: "user",
				state: "completed",
				createdAt: timestamp(sequence * 1000),
				content: [{ type: "text", text: input.input.text }],
			});
			setRunning(key, true);
		}
		return {
			agentId: input.agentId,
			taskId: agents[key].latestTask!.taskId,
			messageId,
			requestId: input.requestId,
			delivery: queue ? ("queue" as const) : ("start" as const),
			state: queue ? ("queued" as const) : ("delivered" as const),
			instructionRevision: 1,
		};
	},
	deleteAgentQueuedMessage: async (input: ClientParams<"agent/queue/delete">) => {
		const key = keyFor(input.sessionId, input.agentId);
		calls.deleted.push(input);
		queued(key, input.queueItemId, input.expectedRevision);
		queues[key] = queues[key].filter((turn) => turn.queueItemId !== input.queueItemId);
		histories[key] = histories[key].filter((item) => item.agentMessageId !== input.queueItemId);
		notify(key);
		return { queueItemId: input.queueItemId, deleted: true as const };
	},
	sendAgentQueuedMessage: async (input: ClientParams<"agent/queue/send">) => {
		const key = keyFor(input.sessionId, input.agentId);
		calls.guides.push(input);
		const turn = queued(key, input.queueItemId, input.expectedRevision);
		if (guideHold) await guideHold;
		if (failGuide) {
			failGuide = false;
			throw new Error("Fixture Guide failed");
		}
		queues[key] = queues[key].filter((entry) => entry.queueItemId !== turn.queueItemId);
		calls.consumed.push(turn.queueItemId);
		histories[key] = histories[key].filter((item) => item.agentMessageId !== turn.queueItemId);
		histories[key].push({
			itemId: `consumed-${turn.queueItemId}`,
			sessionId: IDS[key],
			role: "user",
			origin: { kind: "user" },
			turnId: `task-turn-${key}`,
			agentMessageId: turn.queueItemId,
			deliveryState: "delivered",
			state: "completed",
			createdAt: timestamp(++sequence * 1000),
			content: [{ type: "text", text: turn.text }],
		});
		notify(key);
		return {
			agentId: input.agentId,
			taskId: agents[key].latestTask!.taskId,
			messageId: turn.queueItemId,
			requestId: input.requestId,
			delivery: input.delivery,
			state: "delivered" as const,
			instructionRevision: 1,
		};
	},
} satisfies Partial<MetisDesktopApi>;
const noOp = () => undefined;
const context: SessionChatViewContext = {
	api: api as unknown as MetisDesktopApi,
	store,
	bootstrapped: true,
	composerFormRef: createRef<HTMLFormElement>(),
	registerSubmit: noOp,
	unregisterSubmit: noOp,
	onChangeModel: async () => undefined,
	onChangePermissionPreset: async () => undefined,
	onChangeThinking: async () => undefined,
	onClearError: noOp,
	onError: (cause) => calls.errors.push(cause instanceof Error ? cause.message : String(cause)),
	onFork: noOp,
	onManageMcp: noOp,
	onManageSkills: noOp,
	onNotice: (message) => {
		if (message) calls.notices.push(message);
		showNotice(message);
	},
	onOpenKnowledge: noOp,
	onOpenPlan: noOp,
	onPickFiles: async () => [],
	onPreviewDeliveredFile: noOp,
	onResolveDroppedFiles: () => [],
	onRespond: async ({ interactionId }) => store.removeInteraction(interactionId),
	reducedMotion: params.has("reduced"),
	skillCatalogEpoch: 0,
};
function nodes(key: QueueChild) {
	const pane = document.querySelector(`[data-child="${key}"]`);
	return [
		pane?.querySelector(".agent-conversation") ?? null,
		pane?.querySelector(".transcript-scroll") ?? null,
		pane?.querySelector("[contenteditable]") ?? null,
	];
}
const fixture: AgentQueueFixture = {
	calls,
	seedQueue,
	setRunning,
	disconnect: () => supervisor("restarting"),
	complete: (key) => {
		histories[key].push({
			itemId: `${key}-reply`,
			sessionId: IDS[key],
			turnId: `task-turn-${key}`,
			role: "assistant",
			state: "completed",
			createdAt: timestamp(++sequence * 1000),
			content: [{ type: "text", text: `Worker ${key.toUpperCase()} durable reply` }],
		});
		setRunning(key, false);
	},
	ready: (changed = false) => {
		if (changed) epoch = "55555555-5555-4555-8555-555555555555";
		supervisor("ready");
	},
	holdGuide: () => {
		guideHold = new Promise<void>((resolve) => {
			releaseGuide = resolve;
		});
	},
	releaseGuide: () => {
		releaseGuide?.();
		releaseGuide = undefined;
		guideHold = undefined;
	},
	failNextGuide: () => {
		failGuide = true;
	},
	block: (key, kind) => {
		store.removeInteraction(`pending-${key}`);
		if (kind)
			store.addInteraction({
				...composerInteraction(kind),
				interactionId: `pending-${key}`,
				actorSessionId: IDS[key],
			});
	},
	remember: (key) => {
		remembered.set(key, nodes(key));
	},
	nodesPreserved: (key) =>
		remembered.get(key)?.every((node, index) => node !== null && node === nodes(key)[index]) ?? false,
};
declare global {
	interface Window {
		__agentQueueFixture: AgentQueueFixture;
	}
}
window.__agentQueueFixture = fixture;
function Fixture() {
	const [notice, setNotice] = useState<string | null>(null);
	showNotice = setNotice;
	return (
		<main className="queue-fixture-layout">
			{(["a", "b"] as const).map((key) => (
				<section
					className="queue-fixture-pane"
					data-child={key}
					key={key}
					aria-label={`Worker ${key.toUpperCase()} pane`}
				>
					<AgentConversation
						context={context}
						target={{ sessionId: ROOT, agentId: IDS[key], name: agents[key].name }}
						visible
						onOpenParent={noOp}
					/>
				</section>
			))}
			{notice && (
				<output data-testid="queue-notice" className="queue-fixture-notice">
					{notice}
				</output>
			)}
		</main>
	);
}
const initial = composerSnapshot();
store.applySnapshot({
	...initial,
	session: { ...initial.session, state: "idle" },
	activeTurnId: null,
	queuedTurns: [],
	tasks: [],
	goal: null,
});
supervisor("ready");
await setLocale("en");
createRoot(document.getElementById("root")!).render(<Fixture />);
