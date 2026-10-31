import type { InteractionResponseInput, ItemView, SessionSnapshot } from "@metis/app-protocol";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { SessionChatView, type SessionChatViewProps } from "../src/renderer/components/SessionChatView.tsx";
import { applyGeneralPreferencesToDocument, DEFAULT_GENERAL_PREFERENCES } from "../src/renderer/general-preferences.ts";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	COMPOSER_EPOCH,
	COMPOSER_SESSION_ID,
	composerInteraction,
	composerSnapshot,
} from "../test/fixtures/composer-session.ts";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.motion = params.has("reduced") ? "reduced" : "full";
if (params.has("typography"))
	applyGeneralPreferencesToDocument(
		{
			...DEFAULT_GENERAL_PREFERENCES,
			chatFont: params.get("font") === "serif" ? "anthropic-serif" : "system-sans",
			codeFont: params.get("font") === "serif" ? "anthropic-serif" : "system-sans",
			contentFontSize: params.get("size") === "13" ? "13px" : params.get("size") === "20" ? "20px" : "15px",
		},
		{ matches: params.has("reduced") },
	);
const store = new AppStore();
store.setSupervisor({ state: "ready", serverEpoch: COMPOSER_EPOCH, restartAttempt: 0, failure: null });
let current = composerSnapshot();
if (params.get("mode") === "code") current = { ...current, session: { ...current.session, mode: "code" } };
const history: ItemView[] = [
	{
		itemId: "plan-item",
		sessionId: COMPOSER_SESSION_ID,
		role: "assistant",
		state: "completed",
		createdAt: "2026-10-17T00:00:00.000Z",
		content: [
			{
				type: "plan",
				plan: {
					planId: "plan-1",
					revision: 1,
					title: "Review the conversation interface",
					markdown:
						"# Plan\n\n1. Inspect the pending requests.\n2. Keep the conversation draft.\n3. Verify the results.",
					status: "proposed",
					createdAt: "2026-10-17T00:00:00.000Z",
				},
			},
		],
	},
];
current = { ...current, recentItems: history };
if (params.has("empty")) current = { ...current, tasks: [], goal: null, queuedTurns: [] };
if (params.has("review"))
	current = {
		...current,
		activeReview: { actionId: "fixture-review", reviewer: "model", riskLevel: "high" },
	};
if (params.has("typography")) {
	const sample = "检查中文与 English 字号。Keep the conversation readable and preserve every existing feature.";
	current = {
		...current,
		tasks: [],
		goal: null,
		queuedTurns: [],
		recentItems: [
			{
				itemId: "user-sample",
				sessionId: COMPOSER_SESSION_ID,
				role: "user",
				state: "completed",
				createdAt: "2026-10-17T00:00:00.000Z",
				content: [{ type: "text", text: sample }],
			},
			{
				itemId: "assistant-sample",
				sessionId: COMPOSER_SESSION_ID,
				role: "assistant",
				state: "completed",
				createdAt: "2026-10-17T00:00:01.000Z",
				content: [{ type: "text", text: `${sample}\n\n\`const value = 1;\`` }],
			},
		],
	};
}
if (params.has("many")) {
	current = {
		...current,
		queuedTurns: Array.from({ length: 12 }, (_, index) => ({
			queueItemId: `queued-${index + 1}`,
			revision: `revision-${index + 1}`,
			state: "queued",
			text: `Queued message ${index + 1}: preserve this request until the current task is ready.`,
			attachments: [],
		})),
		tasks: Array.from({ length: 8 }, (_, index) => ({ task: `Validation step ${index + 1}`, completed: index < 2 })),
	};
}

function update(overrides: Partial<SessionSnapshot>) {
	current = { ...current, ...overrides, cursor: current.cursor + 1 };
	store.applySnapshot(current);
}

function request(kind: "ask_user" | "session_permission_approval") {
	let interaction = composerInteraction(kind);
	if (params.has("multi") && interaction.kind === "ask_user") {
		interaction = {
			...interaction,
			questions: [
				interaction.questions[0]!,
				{
					id: "clients",
					question: "Which clients should be supported?",
					multiple: true,
					choices: [
						{ id: "desktop", label: "Desktop" },
						{ id: "web", label: "Web" },
					],
				},
				{
					id: "notes",
					question: "Any additional requirements?",
					multiple: false,
					choices: [{ id: "none", label: "None" }],
				},
			],
		};
	}
	if (params.has("many") && interaction.kind === "ask_user") {
		interaction = {
			...interaction,
			questions: [
				{
					...interaction.questions[0]!,
					question: `Choose where the validation results should be stored. ${"Keep the existing conversations and settings available while this question is open. ".repeat(3)}`,
					choices: Array.from({ length: 4 }, (_, index) => ({
						id: `option-${index}`,
						label: `Option ${index + 1}`,
						description: "Keep the original files and their context. ".repeat(8),
					})),
				},
			],
		};
	}
	update({ pendingInteractions: [interaction] });
}

const calls = { queued: 0, sent: 0, deleted: 0, responded: 0, openedPlan: 0 };
const responses: InteractionResponseInput[] = [];
const api = {
	getSessionStatus: async () => {
		if (params.has("statusDelay")) await new Promise((resolve) => setTimeout(resolve, 120));
		return {
			sessionId: COMPOSER_SESSION_ID,
			mode: current.session.mode,
			contextTokens: 3200,
			contextWindow: 128000,
			contextBasis: "reported_total",
			contextBreakdown: [{ category: "conversation", tokens: 3200 }],
			remainingPercent: 97.5,
			cacheHitPercent: 25,
		};
	},
	queueTurn: async () => {
		calls.queued += 1;
		return {};
	},
	startTurn: async () => {
		calls.sent += 1;
		return {};
	},
	sendQueuedTurn: async () => {
		calls.sent += 1;
		return {};
	},
	deleteQueuedTurn: async () => {
		calls.deleted += 1;
		return {};
	},
	interruptTurn: async () => {
		update({ activeTurnId: null, session: { ...current.session, state: "idle" } });
		return {};
	},
	setSessionGoal: async () => ({}),
	clearSessionGoal: async () => {
		update({ goal: null });
		return {};
	},
};
const noOp = () => undefined;
const props: SessionChatViewProps = {
	api: api as unknown as MetisDesktopApi,
	bootstrapped: false,
	canonicalComposer: true,
	composerFormRef: createRef<HTMLFormElement>(),
	focused: true,
	visible: true,
	sessionId: COMPOSER_SESSION_ID,
	store,
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
	onOpenPlan: () => {
		calls.openedPlan += 1;
	},
	onPickFiles: async () => [],
	onPreviewDeliveredFile: noOp,
	onResolveDroppedFiles: () => [],
	onRespond: async (response: InteractionResponseInput) => {
		calls.responded += 1;
		responses.push(response);
		update({ pendingInteractions: [] });
	},
	reducedMotion: params.has("reduced"),
	skillCatalogEpoch: 0,
};

Object.assign(window, { composerFixtureCalls: calls, composerFixtureResponses: responses });
function Fixture() {
	return (
		<main className="fixture-root">
			<nav aria-label="Fixture controls" className="fixture-controls">
				<button onClick={() => request("ask_user")} type="button">
					Ask
				</button>
				<button onClick={() => request("session_permission_approval")} type="button">
					Approval
				</button>
				<button onClick={() => update({ pendingInteractions: [] })} type="button">
					Resolve
				</button>
				<button onClick={() => update({})} type="button">
					Refresh snapshot
				</button>
				<button
					onClick={() => update({ tasks: current.tasks.map((task) => ({ ...task, completed: true })) })}
					type="button"
				>
					Complete tasks
				</button>
				<button
					onClick={() => update({ tasks: current.tasks.length ? [] : composerSnapshot().tasks })}
					type="button"
				>
					Toggle tasks
				</button>
				<button onClick={() => update({ goal: current.goal ? null : composerSnapshot().goal })} type="button">
					Toggle goal
				</button>
				<button
					onClick={() =>
						current.goal && update({ goal: { ...current.goal, status: "complete", activeStartedAt: null } })
					}
					type="button"
				>
					Complete goal
				</button>
				<button
					onClick={() => update({ queuedTurns: current.queuedTurns.length ? [] : composerSnapshot().queuedTurns })}
					type="button"
				>
					Toggle queue
				</button>
				<button
					onClick={() => update({ tasks: [], goal: null, queuedTurns: [], pendingInteractions: [] })}
					type="button"
				>
					Clear all
				</button>
			</nav>
			<section
				aria-label="Conversation pane"
				className="fixture-pane"
				style={params.has("paneHeight") ? { height: Number(params.get("paneHeight")), flex: "none" } : undefined}
			>
				<SessionChatView {...props} />
			</section>
		</main>
	);
}

store.applySnapshot(current);
await setLocale(params.get("locale") === "zh-CN" ? "zh-CN" : "en");
createRoot(document.getElementById("root")!).render(<Fixture />);
if (params.get("request") === "ask") request("ask_user");
if (params.get("request") === "approval") request("session_permission_approval");
