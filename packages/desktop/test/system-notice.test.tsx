// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SystemNotice,
	systemErrorNotice,
	systemErrorNoticeForCode,
} from "../src/renderer/components/SystemNotice.tsx";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("SystemNotice", () => {
	it("uses one compact semantic surface with accessible actions", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onAction = vi.fn();
		const onDismiss = vi.fn();

		await act(async () => root.render(
			<SystemNotice
				action={{ label: "Retry", onClick: onAction }}
				message="Check your connection and try again."
				onDismiss={onDismiss}
				title="Connection failed"
				tone="error"
			/>,
		));

		const notice = container.querySelector<HTMLElement>('.system-notice[data-tone="error"]')!;
		expect(notice.getAttribute("role")).toBe("alert");
		expect(notice.textContent).toContain("Connection failed");
		await act(async () => container.querySelector<HTMLButtonElement>(".system-notice-action")!.click());
		await act(async () => container.querySelector<HTMLButtonElement>(".system-notice-dismiss")!.click());
		expect(onAction).toHaveBeenCalledOnce();
		expect(onDismiss).toHaveBeenCalledOnce();
		await act(async () => root.unmount());
	});

	it("automatically dismisses transient notices after five seconds", async () => {
		vi.useFakeTimers();
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onDismiss = vi.fn();

		await act(async () => root.render(<SystemNotice onDismiss={onDismiss} title="Request failed" tone="error" />));
		await act(async () => vi.advanceTimersByTime(4_999));
		expect(onDismiss).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTime(1));
		expect(onDismiss).toHaveBeenCalledOnce();
		await act(async () => root.unmount());
	});

	it("turns a provider 404 into model-configuration guidance", () => {
		expect(systemErrorNotice('OpenAI API error (404): 404 "Not Found"')).toEqual({
			message: "The model endpoint returned 404. Check the provider protocol, Base URL, and model ID in Model Settings.",
			title: "Model configuration needs attention",
		});
		expect(systemErrorNoticeForCode("MODEL_ENDPOINT_NOT_FOUND")).toEqual({
			message: "The model endpoint returned 404. Check the provider protocol, Base URL, and model ID in Model Settings.",
			title: "Model configuration needs attention",
		});
	});
});
