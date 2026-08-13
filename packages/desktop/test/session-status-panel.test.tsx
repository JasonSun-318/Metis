// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStatusPanel } from "../src/renderer/components/SessionStatusPanel.tsx";

afterEach(() => document.body.replaceChildren());

describe("SessionStatusPanel", () => {
	it("shows only the requested session metrics and closes with Escape", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onClose = vi.fn();
		await act(async () => root.render(
			<SessionStatusPanel
				loading={false}
				onClose={onClose}
				status={{
					sessionId: "session-1",
					mode: "code",
					contextTokens: 64_000,
					contextWindow: 128_000,
					remainingPercent: 50,
					cacheHitPercent: 24.6,
				}}
			/>,
		));
		expect(container.textContent).toContain("session-1");
		expect(container.textContent).toContain("64,000 / 128,000");
		expect(container.textContent).toContain("50%");
		expect(container.textContent).toContain("25%");
		expect(container.textContent).not.toContain("Usage");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(onClose).toHaveBeenCalledOnce();
		await act(async () => root.unmount());
	});
});
