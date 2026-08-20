// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextUsageRing } from "../src/renderer/components/ContextUsageRing.tsx";
import { contextFillPercent, contextUsagePercent, formatContextTokenLine } from "../src/renderer/context-usage.ts";
import { setLocale } from "../src/renderer/i18n.ts";

afterEach(() => document.body.replaceChildren());

describe("ContextUsageRing", () => {
	it("fills the arc from percent and calls onClick", async () => {
		await setLocale("en");
		const onClick = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ContextUsageRing controls="session-status-panel" expanded={false} onClick={onClick} percent={25} />));
		const button = container.querySelector<HTMLButtonElement>("button.context-usage-ring")!;
		expect(button.getAttribute("aria-label")).toMatch(/25%/);
		const meter = container.querySelector<SVGCircleElement>(".context-usage-ring-meter")!;
		const circumference = Number(meter.getAttribute("data-circumference"));
		expect(Number(meter.getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference * 0.75, 3);
		await act(async () => button.click());
		expect(onClick).toHaveBeenCalledOnce();
		await act(async () => root.render(<ContextUsageRing controls="session-status-panel" expanded onClick={onClick} percent={112.5} />));
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(button.getAttribute("aria-controls")).toBe("session-status-panel");
		expect(button.getAttribute("aria-label")).toMatch(/exceeded/i);
		expect(Number(meter.getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 3);
		await act(async () => root.render(<ContextUsageRing controls="session-status-panel" expanded={false} onClick={onClick} percent={null} />));
		expect(button.getAttribute("aria-label")).toMatch(/unknown|unavailable/i);
		expect(Number(meter.getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference, 3);
		await act(async () => root.unmount());
	});
});

describe("contextFillPercent", () => {
	it("clamps occupancy and treats missing totals as unknown", () => {
		expect(contextFillPercent({ contextTokens: 64_000, contextWindow: 128_000 })).toBe(50);
		expect(contextUsagePercent({ contextTokens: 144_000, contextWindow: 128_000 })).toBe(112.5);
		expect(contextFillPercent({ contextTokens: 144_000, contextWindow: 128_000 })).toBe(100);
		expect(contextFillPercent({ contextTokens: null, contextWindow: 128_000 })).toBeNull();
		expect(formatContextTokenLine(64_000, 128_000)).toBe("~64.0K / 128K Tokens");
	});
});
