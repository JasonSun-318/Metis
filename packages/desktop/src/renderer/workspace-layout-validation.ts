import type { SessionSummary } from "@metis/app-protocol";
import type { MetisDesktopApi } from "../shared/desktop-api.ts";
import type { SessionWorkspace } from "./workspace-tabs.ts";

type KnownSession = Pick<SessionSummary, "sessionId"> & Partial<Pick<SessionSummary, "archived">>;
type LayoutMetadataApi = Partial<Pick<MetisDesktopApi, "listSessions" | "listAgents">>;

const MAX_METADATA_PAGES = 100;

/**
 * Validates persisted references using metadata only. Incomplete results may be displayed, but
 * must not replace the saved layout: hidden references may still exist in unreadable metadata.
 */
export async function validateRestoredWorkspaceLayout(
	workspace: SessionWorkspace,
	knownSessions: ReadonlyMap<string, KnownSession>,
	api: LayoutMetadataApi,
	isCurrent: () => boolean = () => true,
): Promise<{ workspace: SessionWorkspace; complete: boolean; discoveredSessions: readonly SessionSummary[] }> {
	const requiredRoots = new Set(
		workspace.panes.flatMap((pane) =>
			pane.tabs.flatMap((tab) => (tab.kind === "chat" && tab.sessionId !== null ? [tab.sessionId] : [])),
		),
	);
	const validRoots = new Set<string>();
	const missingRoots = new Set<string>();
	const discoveredSessions: SessionSummary[] = [];
	let complete = true;
	for (const sessionId of requiredRoots) {
		const known = knownSessions.get(sessionId);
		if (!known) missingRoots.add(sessionId);
		else if (!known.archived) validRoots.add(sessionId);
	}

	if (missingRoots.size > 0) {
		if (!api.listSessions) complete = false;
		else {
			const cursors = new Set<string>();
			let afterSessionId: string | undefined;
			for (let pageNumber = 0; missingRoots.size > 0; pageNumber += 1) {
				if (!isCurrent() || pageNumber === MAX_METADATA_PAGES) {
					complete = false;
					break;
				}
				try {
					const page = await api.listSessions({
						includeArchived: true,
						limit: 200,
						...(afterSessionId ? { afterSessionId } : {}),
					});
					if (!isCurrent()) {
						complete = false;
						break;
					}
					for (const summary of page.sessions) {
						if (!missingRoots.delete(summary.sessionId)) continue;
						if (!summary.archived) {
							validRoots.add(summary.sessionId);
							discoveredSessions.push(summary);
						}
					}
					if (missingRoots.size === 0 || page.nextAfterSessionId === null) break;
					if (cursors.has(page.nextAfterSessionId)) {
						complete = false;
						break;
					}
					afterSessionId = page.nextAfterSessionId;
					cursors.add(afterSessionId);
				} catch {
					complete = false;
					break;
				}
			}
		}
	}

	const requiredAgents = new Map<string, Set<string>>();
	for (const pane of workspace.panes) {
		for (const tab of pane.tabs) {
			if (tab.kind !== "chat" || tab.sessionId === null || !tab.agentId || !validRoots.has(tab.sessionId)) continue;
			const agents = requiredAgents.get(tab.sessionId) ?? new Set<string>();
			agents.add(tab.agentId);
			requiredAgents.set(tab.sessionId, agents);
		}
	}
	const validAgents = new Map<string, Set<string>>();
	for (const [sessionId, required] of requiredAgents) {
		if (!isCurrent()) {
			complete = false;
			break;
		}
		if (!api.listAgents) {
			complete = false;
			continue;
		}
		const valid = new Set<string>();
		validAgents.set(sessionId, valid);
		const cursors = new Set<string>();
		let afterAgentId: string | undefined;
		for (let pageNumber = 0; ; pageNumber += 1) {
			if (!isCurrent() || pageNumber === MAX_METADATA_PAGES) {
				complete = false;
				break;
			}
			try {
				const page = await api.listAgents({
					sessionId,
					includeArchived: true,
					limit: 100,
					...(afterAgentId ? { afterAgentId } : {}),
				});
				if (!isCurrent()) {
					complete = false;
					break;
				}
				for (const agent of page.agents) {
					if (!required.has(agent.agentId)) continue;
					if (agent.rootSessionId !== sessionId) {
						complete = false;
						continue;
					}
					if (agent.archived) valid.delete(agent.agentId);
					else valid.add(agent.agentId);
				}
				if ((page.unreadableAgentCount ?? 0) > 0) complete = false;
				if (page.nextAfterAgentId === null) break;
				if (cursors.has(page.nextAfterAgentId)) {
					complete = false;
					break;
				}
				afterAgentId = page.nextAfterAgentId;
				cursors.add(afterAgentId);
			} catch {
				complete = false;
				break;
			}
		}
	}

	const panes = workspace.panes.map((pane) => {
		const tabs = pane.tabs.filter(
			(tab) =>
				tab.kind === "chat" &&
				tab.sessionId !== null &&
				validRoots.has(tab.sessionId) &&
				(!tab.agentId || validAgents.get(tab.sessionId)?.has(tab.agentId)),
		);
		if (tabs.length === 0) return { ...pane, tabs, activeId: "", placeholder: true };
		const { placeholder: _placeholder, ...filledPane } = pane;
		const activeId = tabs.some((tab) => tab.id === pane.activeId) ? pane.activeId : tabs[0]!.id;
		return { ...filledPane, tabs, activeId };
	});
	return { workspace: { ...workspace, panes }, complete: complete && isCurrent(), discoveredSessions };
}
