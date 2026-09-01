// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "../src/renderer/hooks/use-app-store.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";

afterEach(() => document.body.replaceChildren());

describe("useAppStore selector", () => {
	it("does not rerender when an unrelated store field changes", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const store = new AppStore();
		let renders = 0;
		function SidebarRevision() {
			renders += 1;
			const revision = useAppStore(store, (snapshot) => snapshot.sidebarRevision);
			return <span>{revision}</span>;
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<SidebarRevision />));
		expect(renders).toBe(1);

		await act(async () => store.setSupervisor({
			state: "ready",
			serverEpoch: "11111111-1111-4111-8111-111111111111",
			restartAttempt: 0,
			failure: null,
		}));
		expect(renders).toBe(1);

		await act(async () => store.upsertSession({
			sessionId: "session-1",
			mode: "chat",
			cwdOrigin: "managed",
			cwd: null,
			createdAt: "2026-08-31T00:00:00.000Z",
			updatedAt: "2026-08-31T00:00:00.000Z",
			state: "idle",
			archived: false,
			unread: false,
		}));
		expect(renders).toBe(2);
		expect(container.textContent).toBe("1");
		await act(async () => root.unmount());
	});

	it("recomputes when the selector changes without a store update", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const store = new AppStore();
		function SelectedVersion({ offset }: { offset: number }) {
			const selected = useAppStore(store, (snapshot) => snapshot.version + offset);
			return <span>{selected}</span>;
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<SelectedVersion offset={1} />));
		expect(container.textContent).toBe("1");

		await act(async () => root.render(<SelectedVersion offset={2} />));
		expect(container.textContent).toBe("2");
		await act(async () => root.unmount());
	});
});
