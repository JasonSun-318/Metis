import type { CollaborationModeView, ItemContentBlockView, ItemView, PlanView } from "@metis/app-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { type ConversationSubmission, composerPayload, composerRequestKey } from "../composer-submission.ts";
import { shouldReuseMutationRequest } from "../rpc-error.ts";

interface ConversationPlanFlowOptions {
	readonly api: Pick<
		MetisDesktopApi,
		"cancelPlan" | "queueTurn" | "setCollaborationMode" | "startPlanExecution" | "startTurn"
	>;
	readonly sessionId: string | undefined;
	readonly writableSessionId: string | undefined;
	readonly running: boolean;
	readonly queuedTurnCount: number;
	readonly serverReady: boolean;
	readonly syncReady: boolean;
	readonly compacting: boolean;
	readonly interactionPending: boolean;
	readonly collaborationMode: CollaborationModeView;
	readonly itemOrder: readonly string[];
	readonly itemsById: ReadonlyMap<string, ItemView>;
	readonly clearError: () => void;
	readonly reportError: (cause: unknown) => void;
	readonly composerInputId?: string;
}

export interface ConversationPlanFlow {
	readonly collaborationMode: CollaborationModeView;
	readonly collaborationModeBlocked: boolean;
	readonly collaborationModeChanging: boolean;
	readonly currentProposedPlan: PlanView | undefined;
	readonly planActionsBusy: boolean;
	readonly planRevisionTarget: PlanView | null;
	readonly submittedTurnId: string | undefined;
	readonly submit: (input: ConversationSubmission) => Promise<void>;
	readonly changeCollaborationMode: (next: CollaborationModeView) => Promise<void>;
	readonly revisePlan: (plan: PlanView) => void;
	readonly clearPlanRevision: () => void;
	readonly startPlan: (plan: PlanView) => Promise<void>;
	readonly cancelPlan: (plan: PlanView) => Promise<void>;
}

function planFromItem(item: ItemView): PlanView | undefined {
	const block = item.content.find(
		(candidate): candidate is Extract<ItemContentBlockView, { type: "plan" }> => candidate.type === "plan",
	);
	return block?.plan;
}

function latestProposedPlan(
	itemOrder: readonly string[],
	itemsById: ReadonlyMap<string, ItemView>,
): PlanView | undefined {
	for (let index = itemOrder.length - 1; index >= 0; index -= 1) {
		const item = itemsById.get(itemOrder[index]!);
		if (!item) continue;
		const plan = planFromItem(item);
		if (plan?.status === "proposed") return plan;
	}
	return undefined;
}

function findPlanRevision(
	itemOrder: readonly string[],
	itemsById: ReadonlyMap<string, ItemView>,
	planId: string,
	revision: number,
): PlanView | undefined {
	for (const itemId of itemOrder) {
		const item = itemsById.get(itemId);
		if (!item) continue;
		const plan = planFromItem(item);
		if (plan?.planId === planId && plan.revision === revision) return plan;
	}
	return undefined;
}

export function useConversationPlanFlow({
	api,
	sessionId,
	writableSessionId,
	running,
	queuedTurnCount,
	serverReady,
	syncReady,
	compacting,
	interactionPending,
	collaborationMode,
	itemOrder,
	itemsById,
	clearError,
	reportError,
	composerInputId = "composer-input",
}: ConversationPlanFlowOptions): ConversationPlanFlow {
	const activeTurnRequest = useRef<{
		readonly key: string;
		readonly method: "start" | "queue";
		readonly requestId: string;
	} | null>(null);
	const previousSessionId = useRef(sessionId);
	const generation = useMemo(() => ({ sessionId }), [sessionId]);
	const currentGeneration = useRef(generation);
	currentGeneration.current = generation;
	const inFlight = useRef<{ generation: object; requestId: string } | null>(null);
	const [planRevisionTarget, setPlanRevisionTarget] = useState<PlanView | null>(null);
	const [submittedTurnId, setSubmittedTurnId] = useState<string>();
	const [pendingPlanAction, setPendingPlanAction] = useState<{
		readonly action: "start" | "cancel";
		readonly planId: string;
		readonly revision: number;
	} | null>(null);
	const [pendingCollaborationMode, setPendingCollaborationMode] = useState<CollaborationModeView | null>(null);
	const currentProposedPlan = useMemo(() => latestProposedPlan(itemOrder, itemsById), [itemOrder, itemsById]);
	const planActionsBusy =
		pendingPlanAction !== null || !serverReady || !syncReady || compacting || interactionPending || running;
	const collaborationModeValue = pendingCollaborationMode ?? collaborationMode;

	useEffect(() => {
		if (previousSessionId.current === sessionId) return;
		previousSessionId.current = sessionId;
		activeTurnRequest.current = null;
		setSubmittedTurnId(undefined);
		setPlanRevisionTarget(null);
		setPendingPlanAction(null);
		setPendingCollaborationMode(null);
	}, [sessionId]);

	useEffect(() => {
		if (pendingCollaborationMode === collaborationMode) setPendingCollaborationMode(null);
	}, [collaborationMode, pendingCollaborationMode]);

	useEffect(() => {
		if (!pendingPlanAction) return;
		const plan = findPlanRevision(itemOrder, itemsById, pendingPlanAction.planId, pendingPlanAction.revision);
		if (!plan || plan.status !== "proposed") setPendingPlanAction(null);
	}, [itemOrder, itemsById, pendingPlanAction]);

	useEffect(() => {
		if (!planRevisionTarget) return;
		const plan = findPlanRevision(itemOrder, itemsById, planRevisionTarget.planId, planRevisionTarget.revision);
		if (!plan || plan.status !== "proposed") setPlanRevisionTarget(null);
	}, [itemOrder, itemsById, planRevisionTarget]);

	const submit = useCallback(
		async (input: ConversationSubmission) => {
			if (
				!sessionId ||
				generation !== currentGeneration.current ||
				writableSessionId !== sessionId ||
				!serverReady ||
				!syncReady ||
				compacting ||
				interactionPending ||
				pendingCollaborationMode !== null
			)
				throw new Error("This conversation is not ready to send");
			if (inFlight.current?.generation === generation) throw new Error("A message is already being submitted");
			clearError();
			const key = JSON.stringify({ sessionId, input: composerRequestKey(input) });
			const request =
				activeTurnRequest.current?.key === key
					? activeTurnRequest.current
					: {
							key,
							method: running || queuedTurnCount > 0 ? ("queue" as const) : ("start" as const),
							requestId: crypto.randomUUID(),
						};
			activeTurnRequest.current = request;
			const flight = { generation, requestId: request.requestId };
			inFlight.current = flight;
			try {
				if (request.method === "queue") {
					await api.queueTurn({ sessionId, requestId: request.requestId, ...composerPayload(input) });
				} else {
					const result = await api.startTurn({
						sessionId,
						requestId: request.requestId,
						...composerPayload(input),
					});
					if (currentGeneration.current === generation) setSubmittedTurnId(result.turnId);
				}
				if (currentGeneration.current !== generation) return;
				if (activeTurnRequest.current === request) activeTurnRequest.current = null;
				setPlanRevisionTarget(null);
			} catch (cause) {
				if (!shouldReuseMutationRequest(cause) && activeTurnRequest.current === request) {
					activeTurnRequest.current = null;
				}
				if (currentGeneration.current === generation) reportError(cause);
				throw cause;
			} finally {
				if (inFlight.current === flight) inFlight.current = null;
			}
		},
		[
			api,
			clearError,
			pendingCollaborationMode,
			queuedTurnCount,
			reportError,
			running,
			sessionId,
			writableSessionId,
			serverReady,
			syncReady,
			compacting,
			interactionPending,
			generation,
		],
	);

	const changeCollaborationMode = useCallback(
		async (next: CollaborationModeView) => {
			if (!writableSessionId || pendingCollaborationMode !== null || planActionsBusy) return;
			if (next === "default" && currentProposedPlan) return;
			setPendingCollaborationMode(next);
			try {
				await api.setCollaborationMode({
					sessionId: writableSessionId,
					requestId: crypto.randomUUID(),
					collaborationMode: next,
				});
			} catch (cause) {
				setPendingCollaborationMode(null);
				reportError(cause);
				throw cause;
			}
		},
		[api, currentProposedPlan, pendingCollaborationMode, planActionsBusy, reportError, writableSessionId],
	);

	const revisePlan = useCallback(
		(plan: PlanView) => {
			setPlanRevisionTarget(plan);
			requestAnimationFrame(() => document.getElementById(composerInputId)?.focus());
		},
		[composerInputId],
	);

	const startPlan = useCallback(
		async (plan: PlanView) => {
			if (!writableSessionId || planActionsBusy) return;
			setPendingPlanAction({ action: "start", planId: plan.planId, revision: plan.revision });
			setPlanRevisionTarget(null);
			try {
				await api.startPlanExecution({
					sessionId: writableSessionId,
					requestId: crypto.randomUUID(),
					planId: plan.planId,
					revision: plan.revision,
				});
			} catch (cause) {
				setPendingPlanAction(null);
				reportError(cause);
			}
		},
		[api, planActionsBusy, reportError, writableSessionId],
	);

	const cancelPlan = useCallback(
		async (plan: PlanView) => {
			if (!writableSessionId || planActionsBusy) return;
			setPendingPlanAction({ action: "cancel", planId: plan.planId, revision: plan.revision });
			setPlanRevisionTarget(null);
			try {
				await api.cancelPlan({
					sessionId: writableSessionId,
					requestId: crypto.randomUUID(),
					planId: plan.planId,
					revision: plan.revision,
				});
			} catch (cause) {
				setPendingPlanAction(null);
				reportError(cause);
			}
		},
		[api, planActionsBusy, reportError, writableSessionId],
	);

	return {
		collaborationMode: collaborationModeValue,
		collaborationModeBlocked:
			planActionsBusy || pendingCollaborationMode !== null || currentProposedPlan !== undefined,
		collaborationModeChanging: pendingCollaborationMode !== null,
		currentProposedPlan,
		planActionsBusy,
		planRevisionTarget,
		submittedTurnId,
		submit,
		changeCollaborationMode,
		revisePlan,
		clearPlanRevision: () => setPlanRevisionTarget(null),
		startPlan,
		cancelPlan,
	};
}
