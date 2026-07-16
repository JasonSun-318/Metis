import type {
	ConnectionEventsParams,
	InteractionResponseInput,
	ItemView,
	SessionSnapshot,
	SessionSummary,
	TurnView,
} from "@arcmind/app-protocol";

const session = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	cwd: "/tmp/project",
	createdAt: "2026-07-16T00:00:00.000Z",
	updatedAt: "2026-07-16T00:00:00.000Z",
	state: "idle",
	archived: false,
} satisfies SessionSummary;

const turns: TurnView[] = [];
const items: ItemView[] = [];
const snapshot: SessionSnapshot = {
	session,
	turns,
	recentItems: items,
	nextBeforeItemId: null,
	activeTurnId: null,
	pendingInteractions: [],
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
