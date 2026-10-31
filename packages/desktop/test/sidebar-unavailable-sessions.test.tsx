// @vitest-environment jsdom
import type { SessionSummary } from "@metis/app-protocol";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RecoveryBanner } from "../src/renderer/components/RecoveryBanner.tsx";
import { SessionSidebar } from "../src/renderer/components/SessionSidebar.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

vi.mock("../src/renderer/components/AccountMenu.tsx", () => ({ AccountMenu: () => null }));

it("keeps unavailable sessions readable without fetching their agents and preserves healthy branches", async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	localStorage.clear();
	await setLocale("zh-CN");
	const base: SessionSummary = {
		sessionId: "healthy",
		name: "Healthy",
		mode: "code",
		cwdOrigin: "managed",
		cwd: "/tmp/work",
		createdAt: "2026-10-26T08:00:00Z",
		updatedAt: "2026-10-26T08:00:00Z",
		state: "idle",
		archived: false,
		unread: false,
		useMemory: true,
		contributeMemory: true,
	};
	const future: SessionSummary = { ...base, sessionId: "future", name: "Future", state: "unsupported" };
	const store = new AppStore();
	store.setSessions({
		sessions: [base, future, { ...base, sessionId: "broken", name: "Broken", state: "corrupt" }],
		nextAfterSessionId: null,
	});
	const api = {
		listAgents: vi.fn().mockResolvedValue({ agents: [], nextAfterAgentId: null }),
		subscribe: () => () => undefined,
	} as unknown as MetisDesktopApi;
	const onOpen = vi.fn();
	const workspace: ComponentProps<typeof SessionSidebar>["workspace"] = {
		busy: false,
		mode: "code",
		newTaskOpen: false,
		onModeChange: vi.fn(),
		onNewTask: vi.fn(),
		onOpen,
		onDeleteSession: vi.fn(),
		onPinSession: vi.fn(),
		onRenameSession: vi.fn(),
		onCopySessionTitle: vi.fn(),
		onCreateProjectSession: vi.fn(),
		onDeleteProject: vi.fn(),
		onPinProject: vi.fn(),
		onPreviewProjectDelete: vi.fn(),
		onRenameProject: vi.fn(),
		projectBusy: () => false,
		preferences: new Map(),
		pinnedSessionIds: new Set(),
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<>
					<SessionSidebar
						state={store.getSnapshot()}
						agentNavigation={{ api, active: null, onOpen: vi.fn() }}
						destination="tasks"
						onSettings={vi.fn()}
						onUpdate={vi.fn()}
						onSkills={vi.fn()}
						onSchedules={vi.fn()}
						onOpenSchedule={vi.fn()}
						onDeleteSchedule={vi.fn()}
						onWidthChange={vi.fn()}
						scheduleTasks={[]}
						selectedScheduleTaskId={null}
						updateState={{ status: "unavailable" }}
						width={302}
						workspace={workspace}
					/>
					<RecoveryBanner session={future} />
				</>,
			),
		);
		expect(api.listAgents).toHaveBeenCalledTimes(1);
		expect(api.listAgents).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "healthy" }));
		expect(container.textContent).not.toContain("重新加载子代理");
		const button = container.querySelector<HTMLButtonElement>('.session-button[aria-label="Future"]')!;
		expect(button.title).toContain("兼容版本");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("源数据未被改动");
		await act(async () => button.click());
		expect(onOpen).toHaveBeenCalledWith("future");
	} finally {
		await act(async () => root.unmount());
		container.remove();
		await setLocale("en");
	}
});
