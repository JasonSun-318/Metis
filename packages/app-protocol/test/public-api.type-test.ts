import type {
	ClientParams,
	ClientResult,
	ConnectionEventsParams,
	InteractionResponseInput,
	ItemView,
	SessionSnapshot,
	SessionSummary,
	SkillSummaryView,
	TurnView,
} from "@arcmind/app-protocol";

const projectDelete = {
	requestId: "00000000-0000-4000-8000-000000000001",
	mode: "chat",
	cwd: "/tmp/project",
	expectedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} satisfies ClientParams<"project/delete">;
const projectDeletePreview = {
	mode: "chat",
	cwd: "/tmp/project",
	sessionCount: 1,
	blockingScheduleCount: 0,
	revision: projectDelete.expectedRevision,
} satisfies ClientResult<"project/deletePreview">;
const projectDeleteResult = {
	mode: "chat",
	cwd: "/tmp/project",
	deletedSessionCount: 1,
} satisfies ClientResult<"project/delete">;

const session = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	mode: "code",
	cwdOrigin: "user-selected",
	cwd: "/tmp/project",
	createdAt: "2026-07-16T00:00:00.000Z",
	updatedAt: "2026-07-16T00:00:00.000Z",
	state: "idle",
	archived: false,
} satisfies SessionSummary;

const turns: TurnView[] = [];
const items: ItemView[] = [];
const skill = {
	name: "pdf",
	description: "Read PDF documents",
	source: "system",
} satisfies SkillSummaryView;
const snapshot: SessionSnapshot = {
	session,
	turns,
	recentItems: items,
	nextBeforeItemId: null,
	activeTurnId: null,
	pendingInteractions: [],
	thinkingSelection: "off",
	actualThinkingLevel: "off",
	availableThinkingSelections: ["off"],
	subagents: [],
	serverEpoch: "33333333-3333-4333-8333-333333333333",
	cursor: 0,
};
const events: ConnectionEventsParams = {
	serverEpoch: snapshot.serverEpoch,
	fromCursor: 1,
	toCursor: 1,
	events: [{ type: "server/state", state: "ready" }],
};
const interactionResponse: InteractionResponseInput = {
	interactionId: "44444444-4444-4444-8444-444444444444",
	kind: "confirm",
	confirmed: true,
};

void events;
void interactionResponse;
void skill;
void projectDelete;
void projectDeletePreview;
void projectDeleteResult;
