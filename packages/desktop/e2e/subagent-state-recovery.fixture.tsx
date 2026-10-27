import type { AgentSummaryView, ClientParams, DomainEvent, ItemView } from "@metis/app-protocol";
import { createRef, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentConversation } from "../src/renderer/components/AgentConversation.tsx";
import { AgentSidebarBranch } from "../src/renderer/components/AgentSidebarBranch.tsx";
import type { SessionChatViewContext } from "../src/renderer/components/SessionChatView.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { COMPOSER_EPOCH, COMPOSER_SESSION_ID, composerSnapshot } from "../test/fixtures/composer-session.ts";
import type { RecoveryFixture } from "./subagent-state-recovery.types.ts";

const ROOT = COMPOSER_SESSION_ID;
const CHILD = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const params = new URLSearchParams(location.search);
const startedAt = new Date(Date.now() - 1000).toISOString();
const stamp = (index: number) => new Date(Date.parse(startedAt) - (100 - index) * 1000).toISOString();
document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.platform = "darwin";
document.documentElement.dataset.motion = params.has("reduced") ? "reduced" : "full";

const task = {
	taskId: TASK,
	status: "running" as const,
	taskSummary: "Follow-up task",
	createdAt: startedAt,
	updatedAt: startedAt,
};
let child: AgentSummaryView = {
	agentId: CHILD,
	rootSessionId: ROOT,
	parentSessionId: ROOT,
	agentPath: [CHILD],
	name: "Recovery worker",
	agentType: "worker",
	depth: 1,
	status: "done",
	archived: false,
	mode: "chat",
	tasks: [],
	createdAt: stamp(0),
	updatedAt: stamp(1),
	runControl: "enabled",
};
let items: readonly ItemView[] = Array.from({ length: 48 }, (_, index) => ({
	itemId: `history-${index}`,
	sessionId: CHILD,
	turnId: `history-turn-${index}`,
	role: "assistant",
	state: "completed",
	createdAt: stamp(index),
	content: [
		{
			type: "text",
			text: `History ${index + 1}. ${"Preserve the earlier conversation while recovering the current task. ".repeat(5)}`,
		},
	],
}));
const listeners = new Set<(event: DesktopApiEvent) => void>();
const calls = { catalog: 0, history: 0, sent: 0 };
const store = new AppStore();
let epoch = COMPOSER_EPOCH;
let cursor = 0;
function emit(event: DesktopApiEvent) {
	for (const listener of listeners) listener(event);
}
function supervisor(state: "ready" | "restarting") {
	const view = { state, serverEpoch: epoch, restartAttempt: state === "restarting" ? 1 : 0, failure: null };
	store.setSupervisor(view);
	emit({ type: "supervisor", view });
}
function changes(events: readonly DomainEvent[]) {
	cursor += 1;
	emit({
		type: "app-server",
		envelope: {
			jsonrpc: "2.0",
			method: "connection/events",
			params: { serverEpoch: epoch, fromCursor: cursor, toCursor: cursor, events: [...events] },
		},
	});
}
const api = {
	readAgentQueuedMessages: async () => ({ queuedTurns: [] }),
	listAgents: async () => {
		calls.catalog += 1;
		return { agents: [structuredClone(child)], nextAfterAgentId: null };
	},
	readAgentItems: async () => {
		calls.history += 1;
		return { items: structuredClone([...items]), nextBeforeItemId: null };
	},
	subscribe: (listener: (event: DesktopApiEvent) => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	sendAgentMessage: async (input: ClientParams<"agent/send">) => {
		calls.sent += 1;
		child = { ...child, status: "running", currentTask: task, latestTask: task, tasks: [task], updatedAt: startedAt };
		items = [
			...items,
			{
				itemId: "follow-up-input",
				sessionId: CHILD,
				turnId: "follow-up-turn",
				agentTaskId: TASK,
				role: "user",
				state: "completed",
				createdAt: startedAt,
				content: [{ type: "text", text: input.input.text }],
			},
		];
		changes([{ type: "agent/updated", sessionId: ROOT, agent: child }]);
		return {
			agentId: CHILD,
			taskId: TASK,
			messageId: "follow-up-message",
			requestId: input.requestId,
			delivery: "start",
			state: "delivered",
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
	onError: (cause) => {
		throw cause;
	},
	onFork: noOp,
	onManageMcp: noOp,
	onManageSkills: noOp,
	onNotice: noOp,
	onOpenKnowledge: noOp,
	onOpenPlan: noOp,
	onPickFiles: async () => [],
	onPreviewDeliveredFile: noOp,
	onResolveDroppedFiles: () => [],
	onRespond: async () => undefined,
	reducedMotion: params.has("reduced"),
	skillCatalogEpoch: 0,
};

declare global {
	interface Window {
		__recoveryFixture: RecoveryFixture;
	}
}

function Fixture() {
	const [visible, setVisible] = useState(true);
	const remembered = useRef<readonly (Element | null)[]>([]);
	const nodes = () => [
		document.querySelector(".agent-conversation"),
		document.querySelector(".transcript-scroll"),
		document.querySelector("[contenteditable]"),
	];
	window.__recoveryFixture = {
		calls,
		disconnect: () => supervisor("restarting"),
		setVisible,
		completeWithoutEvents: () => {
			const completedAt = new Date(Date.now() + 1000).toISOString();
			const completed = {
				...task,
				status: "done" as const,
				updatedAt: completedAt,
				finalMessage: "Recovered durable reply",
			};
			child = {
				...child,
				status: "done",
				currentTask: undefined,
				latestTask: completed,
				tasks: [completed],
				updatedAt: completedAt,
			};
			items = [
				...items,
				{
					itemId: "durable-reply",
					sessionId: CHILD,
					turnId: "follow-up-turn",
					agentTaskId: TASK,
					role: "assistant",
					state: "completed",
					createdAt: completedAt,
					content: [{ type: "text", text: "Recovered durable reply" }],
				},
			];
		},
		ready: (changedEpoch = false) => {
			if (changedEpoch) epoch = "55555555-5555-4555-8555-555555555555";
			supervisor("ready");
		},
		rememberNodes: () => {
			remembered.current = nodes();
		},
		nodesPreserved: () =>
			remembered.current.length === 3 &&
			remembered.current.every((element, index) => element !== null && element === nodes()[index]),
	};
	return (
		<main className="recovery-layout">
			<aside className="recovery-sidebar" aria-label="Session sidebar">
				<AgentSidebarBranch
					sessionId={ROOT}
					navigation={{
						api: context.api,
						active: { sessionId: ROOT, agentId: CHILD, name: child.name },
						onOpen: noOp,
					}}
				>
					{(toggle) => (
						<div className="session-row">
							<button type="button" className="session-button">
								Parent conversation
							</button>
							{toggle}
						</div>
					)}
				</AgentSidebarBranch>
			</aside>
			<section className="recovery-pane" style={{ visibility: visible ? "visible" : "hidden" }}>
				<AgentConversation
					target={{ sessionId: ROOT, agentId: CHILD, name: child.name }}
					context={context}
					visible={visible}
					onOpenParent={noOp}
				/>
			</section>
		</main>
	);
}

const initial = composerSnapshot();
store.applySnapshot({
	...initial,
	session: { ...initial.session, name: "Parent conversation", state: "idle" },
	activeTurnId: null,
	queuedTurns: [],
	tasks: [],
	goal: null,
});
supervisor("ready");
await setLocale("en");
createRoot(document.getElementById("root")!).render(<Fixture />);
