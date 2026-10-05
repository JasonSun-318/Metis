// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChatViewContext } from "../src/renderer/components/SessionChatView.tsx";
import { SessionWorkspaceView } from "../src/renderer/components/SessionWorkspace.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserEvent,
	type DesktopBrowserState,
	type MetisDesktopApi,
} from "../src/shared/desktop-api.ts";

vi.mock("../src/renderer/components/preview/UniversalFilePreviewer.tsx", () => ({
	UniversalFilePreviewer: () => null,
}));

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const BROWSER_ID = "22222222-2222-4222-8222-222222222222";
let roots: Root[] = [];

function fixture() {
	const listeners = new Set<(event: DesktopBrowserEvent) => void>();
	const state: DesktopBrowserState = {
		browserId: BROWSER_ID,
		profileId: DEFAULT_BROWSER_PROFILE_ID,
		url: "",
		title: "New tab",
		faviconUrl: null,
		loading: false,
		canGoBack: false,
		canGoForward: false,
		zoomPercent: 100,
	};
	const api = {
		listBrowserProfiles: vi.fn().mockResolvedValue([
			{
				profileId: DEFAULT_BROWSER_PROFILE_ID,
				name: "Default",
				sourceId: null,
				sourceProfileId: null,
			},
		]),
		createBrowser: vi.fn().mockResolvedValue(state),
		captureBrowserPreview: vi.fn().mockResolvedValue("data:image/png;base64,cHJldmlldw=="),
		controlBrowser: vi.fn().mockResolvedValue(undefined),
		closeBrowser: vi.fn().mockResolvedValue(undefined),
		listBrowserDownloads: vi.fn().mockResolvedValue([]),
		listBrowserHistory: vi.fn().mockResolvedValue([]),
		clearBrowserHistory: vi.fn().mockResolvedValue(undefined),
		subscribeBrowser: vi.fn((listener: (event: DesktopBrowserEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		retainWorkspaceSessions: vi.fn().mockResolvedValue(undefined),
	} as unknown as MetisDesktopApi;
	const onActivateSession = vi.fn();
	const chatView: SessionChatViewContext = {
		api,
		bootstrapped: false,
		composerFormRef: { current: null },
		composerSubmitRef: { current: null },
		onChangeModel: vi.fn(),
		onChangePermissionPreset: vi.fn(),
		onChangeThinking: vi.fn(),
		onClearError: vi.fn(),
		onError: vi.fn(),
		onFork: vi.fn(),
		onManageMcp: vi.fn(),
		onManageSkills: vi.fn(),
		onNotice: vi.fn(),
		onOpenKnowledge: vi.fn(),
		onOpenPlan: vi.fn(),
		onPickFiles: vi.fn(async () => []),
		onPreviewDeliveredFile: vi.fn(),
		onResolveDroppedFiles: vi.fn(() => []),
		onRespond: vi.fn(async () => {}),
		reducedMotion: true,
		skillCatalogEpoch: 0,
		store: new AppStore(),
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	void act(() =>
		root.render(
			<SessionWorkspaceView
				api={api}
				chat={<div />}
				chatView={chatView}
				chatCwd={null}
				chatFocusRequest={null}
				chatIsDraft={false}
				chatSessionId={SESSION_ID}
				cleanupSessionIds={[]}
				mode="chat"
				onActivateSession={onActivateSession}
				onChatSession={vi.fn()}
				onCleanupSessionIdsHandled={vi.fn()}
				onDirtySessionIdsChange={vi.fn()}
				onError={vi.fn()}
				onLiveSessionsChange={vi.fn()}
				sessionsById={new Map([[SESSION_ID, { sessionId: SESSION_ID, cwd: null, mode: "chat" }]])}
				sessionTitleFor={() => "Chat"}
				store={{} as AppStore}
				theme="dark"
				visible
			/>,
		),
	);
	return {
		api,
		container,
		onActivateSession,
		emit: async (event: DesktopBrowserEvent) => {
			await act(async () => {
				for (const listener of [...listeners]) listener(event);
				await Promise.resolve();
			});
		},
	};
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("Session workspace browser lifecycle", () => {
	it("uses profile updates emitted by imports outside the workspace", async () => {
		const { container, emit } = fixture();
		const importedProfileId = "33333333-3333-4333-8333-333333333333";
		await emit({
			type: "profiles",
			profiles: [
				{
					profileId: DEFAULT_BROWSER_PROFILE_ID,
					name: "Default",
					sourceId: null,
					sourceProfileId: null,
				},
				{
					profileId: importedProfileId,
					name: "Work",
					sourceId: "chrome",
					sourceProfileId: "Profile 2",
				},
			],
		});
		await emit({ type: "opened", sessionId: SESSION_ID, browserId: BROWSER_ID, profileId: importedProfileId });

		expect(
			[...container.querySelectorAll<HTMLButtonElement>("button")]
				.map((button) => button.getAttribute("aria-label"))
				.join("\n"),
		).toContain("Browser profile: Google Chrome — Work");
	});

	it("deduplicates background tabs and activates the owner only for a requested handoff", async () => {
		const { container, emit, onActivateSession } = fixture();
		const opened: DesktopBrowserEvent = {
			type: "opened",
			sessionId: SESSION_ID,
			browserId: BROWSER_ID,
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		};
		await emit(opened);
		await emit(opened);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(onActivateSession).not.toHaveBeenCalled();

		await emit({ type: "activity", sessionId: SESSION_ID, browserId: BROWSER_ID, active: true });
		expect(container.querySelector('[role="status"]')?.textContent).toContain("Metis is controlling this page");
		expect(onActivateSession).not.toHaveBeenCalled();

		await emit({
			type: "handoff",
			sessionId: SESSION_ID,
			browserId: BROWSER_ID,
			status: "requested",
			reason: "captcha",
		});
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("human verification");
		expect(onActivateSession).toHaveBeenCalledOnce();
		expect(onActivateSession).toHaveBeenCalledWith(SESSION_ID);
	});
});
