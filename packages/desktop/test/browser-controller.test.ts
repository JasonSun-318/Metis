import type { BrowserActInput, BrowserObserveInput } from "@metis/app-protocol";
import { MAX_BROWSER_SCREENSHOT_UTF8_BYTES, MAX_BROWSER_STATE_UTF8_BYTES } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import {
	BrowserController,
	type BrowserControllerDependencies,
	type BrowserDebuggerTransport,
} from "../src/main/browser-controller.ts";

const BROWSER_ID = "88888888-8888-4888-8888-888888888888";
const PROFILE_ID = "00000000-0000-4000-8000-000000000001";

interface Command {
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly sessionId?: string;
}

class FakeDebugger implements BrowserDebuggerTransport {
	attached = false;
	readonly commands: Command[] = [];
	readonly responses = new Map<string, unknown>();
	handler?: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>;

	isAttached(): boolean {
		return this.attached;
	}

	attach(): void {
		this.attached = true;
	}

	detach(): void {
		this.attached = false;
	}

	async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
		this.commands.push({ method, params, ...(sessionId ? { sessionId } : {}) });
		if (this.handler) return this.handler(method, params, sessionId);
		return this.responses.get(`${sessionId ?? "main"}:${method}`) ?? this.responses.get(method) ?? {};
	}
}

function axTree(name = "Continue", value = "secret") {
	return {
		nodes: [
			{ nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Fixture" } },
			{
				nodeId: "input",
				parentId: "root",
				backendDOMNodeId: 7,
				role: { value: "textbox" },
				name: { value: "Email" },
				value: { value },
				properties: [{ name: "focusable", value: { value: true } }],
			},
			{
				nodeId: "button",
				parentId: "root",
				backendDOMNodeId: 8,
				role: { value: "button" },
				name: { value: name },
			},
		],
	};
}

function fixture(
	overrides: Pick<BrowserControllerDependencies, "stabilizationQuietMs" | "stabilizationTimeoutMs"> = {},
) {
	const debug = new FakeDebugger();
	debug.responses.set("Accessibility.getFullAXTree", axTree());
	debug.responses.set("DOM.getBoxModel", { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } });
	const page = { url: "https://example.test/page", title: "Fixture", loading: false };
	let message: ((method: string, params: Record<string, unknown>, sessionId?: string) => void) | undefined;
	let detach: (() => void) | undefined;
	const captureScreenshot = vi.fn(async (_quality: number) => Buffer.from("jpeg"));
	const dependencies: BrowserControllerDependencies = {
		browserId: BROWSER_ID,
		profileId: PROFILE_ID,
		debugger: debug,
		pageState: () => page,
		captureScreenshot,
		subscribeMessage: (listener) => {
			message = listener;
			return () => {
				message = undefined;
			};
		},
		subscribeDetach: (listener) => {
			detach = listener;
			return () => {
				detach = undefined;
			};
		},
		acceleratorModifier: 4,
		stabilizationQuietMs: 0,
		...overrides,
	};
	const controller = new BrowserController(dependencies);
	return {
		controller,
		debug,
		page,
		captureScreenshot,
		emit: (method: string, params = {}, sessionId?: string) => message?.(method, params, sessionId),
		detach: () => {
			debug.attached = false;
			detach?.();
		},
	};
}

function observe(controller: BrowserController, input: Partial<BrowserObserveInput> = {}) {
	return controller.observe({ browserId: BROWSER_ID, ...input }, new AbortController().signal);
}

function action(
	observation: Awaited<ReturnType<typeof observe>>,
	actionInput: BrowserActInput["action"],
): BrowserActInput {
	return {
		browserId: BROWSER_ID,
		documentId: observation.documentId,
		snapshotRevision: observation.revision,
		origin: "https://example.test",
		intent: "Test the fixture",
		risk: "ordinary",
		action: actionInput,
	};
}

describe("BrowserController", () => {
	it("attaches lazily, enables CDP domains, and emits an AX-first redacted state", async () => {
		const { controller, debug } = fixture();
		expect(debug.attached).toBe(false);
		const result = await observe(controller);
		expect(debug.attached).toBe(true);
		expect(debug.commands.slice(0, 4).map(({ method }) => method)).toEqual([
			"Page.enable",
			"DOM.enable",
			"Accessibility.enable",
			"Target.setAutoAttach",
		]);
		expect(result.change).toBe("full");
		expect(result.state).toContain('e1 textbox "Email" [non-empty]');
		expect(result.state).toContain('e2 button "Continue"');
		expect(result.state).not.toContain("secret");
		expect(debug.commands.some(({ method }) => method.startsWith("Runtime."))).toBe(false);
	});

	it("keeps only current and previous state for diff and unchanged observations", async () => {
		const { controller, debug } = fixture();
		const first = await observe(controller);
		debug.responses.set("Accessibility.getFullAXTree", axTree("Submit"));
		const changed = await observe(controller, { sinceRevision: first.revision });
		expect(changed.change).toBe("diff");
		expect(changed.revision).toBe(2);
		expect(changed.state).toContain('-   e2 button "Continue"');
		expect(changed.state).toContain('+   e2 button "Submit"');
		const unchanged = await observe(controller, { sinceRevision: changed.revision });
		expect(unchanged).toMatchObject({ revision: 2, change: "unchanged", state: "" });
	});

	it("prioritizes actionable nodes and bounds the serialized state", async () => {
		const { controller, debug } = fixture();
		const nodes = Array.from({ length: 3_050 }, (_, index) => ({
			nodeId: `text-${index}`,
			role: { value: "StaticText" },
			name: { value: `text-${index}-${"你".repeat(80)}` },
		}));
		nodes.push({
			nodeId: "last-button",
			backendDOMNodeId: 99,
			role: { value: "button" },
			name: { value: "Important" },
		} as (typeof nodes)[number]);
		debug.responses.set("Accessibility.getFullAXTree", { nodes });
		const result = await observe(controller);
		expect(result.state).toContain('e1 button "Important"');
		expect(Buffer.byteLength(result.state, "utf8")).toBeLessThanOrEqual(MAX_BROWSER_STATE_UTF8_BYTES);
		expect(result.state.split("\n").length).toBeLessThanOrEqual(3_001);
	});

	it("returns explicit stale observations without dispatching input", async () => {
		const { controller, debug, page } = fixture();
		const first = await observe(controller);
		page.url = "https://other.test/page";
		const originChanged = await controller.act(
			action(first, { type: "click", target: { elementId: "e2" } }),
			new AbortController().signal,
		);
		expect(originChanged).toMatchObject({ status: "stale", reason: "origin_changed" });
		page.url = "https://example.test/page";

		debug.responses.set("Accessibility.getFullAXTree", axTree("Changed"));
		const revisionChanged = await controller.act(
			action(first, { type: "click", target: { elementId: "e2" } }),
			new AbortController().signal,
		);
		expect(revisionChanged).toMatchObject({ status: "stale", reason: "revision_changed" });

		const current = (revisionChanged as Extract<typeof revisionChanged, { status: "stale" }>).observation;
		const missing = await controller.act(
			action(current, { type: "click", target: { elementId: "e99" } }),
			new AbortController().signal,
		);
		expect(missing).toMatchObject({ status: "stale", reason: "element_missing" });

		controller.invalidate();
		const documentChanged = await controller.act(
			action(current, { type: "click", target: { elementId: "e2" } }),
			new AbortController().signal,
		);
		expect(documentChanged).toMatchObject({ status: "stale", reason: "document_changed" });
		expect(debug.commands.filter(({ method }) => method.startsWith("Input."))).toHaveLength(0);
	});

	it("uses DOM geometry and Input domain commands for click and text actions", async () => {
		const { controller, debug } = fixture();
		const first = await observe(controller);
		const clicked = await controller.act(
			action(first, { type: "click", target: { elementId: "e2" } }),
			new AbortController().signal,
		);
		expect(clicked.status).toBe("completed");
		expect(
			debug.commands.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => params.type),
		).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
		const afterClick = clicked.status === "completed" ? clicked.observation : first;
		const typed = await controller.act(
			action(afterClick, { type: "type", elementId: "e1", text: "hello", replace: true }),
			new AbortController().signal,
		);
		expect(typed.status).toBe("completed");
		expect(debug.commands).toContainEqual({ method: "DOM.focus", params: { backendNodeId: 7 } });
		expect(debug.commands).toContainEqual({ method: "Input.insertText", params: { text: "hello" } });
		expect(debug.commands.some(({ method }) => method.startsWith("Runtime."))).toBe(false);
	});

	it("waits for a bounded accessibility quiet window after input", async () => {
		const { controller } = fixture({ stabilizationQuietMs: 12, stabilizationTimeoutMs: 50 });
		const first = await observe(controller);
		const startedAt = Date.now();
		const result = await controller.act(
			action(first, { type: "click", target: { elementId: "e2" } }),
			new AbortController().signal,
		);
		expect(result.status).toBe("completed");
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10);
	});

	it("covers hover, press, scroll, drag, select, and dialog with native CDP commands", async () => {
		const { controller, debug } = fixture();
		debug.responses.set("DOM.describeNode", {
			node: {
				children: [
					{ attributes: ["value", "one"], nodeValue: "One" },
					{ attributes: ["value", "two"], nodeValue: "Two" },
				],
			},
		});
		let current = await observe(controller);
		const run = async (nextAction: BrowserActInput["action"]) => {
			const result = await controller.act(action(current, nextAction), new AbortController().signal);
			expect(result.status).toBe("completed");
			if (result.status === "completed") current = result.observation;
		};
		await run({ type: "hover", target: { elementId: "e2" } });
		await run({ type: "press", key: "Enter" });
		await run({ type: "scroll", direction: "down", pages: 2, elementId: "e2" });
		await run({ type: "drag", from: { x: 1, y: 2 }, to: { elementId: "e2" } });
		await run({ type: "select", elementId: "e1", value: "two" });
		await run({ type: "dialog", decision: "dismiss" });

		expect(debug.commands).toContainEqual({
			method: "Input.dispatchMouseEvent",
			params: { type: "mouseWheel", x: 20, y: 30, deltaX: 0, deltaY: 1_600 },
		});
		expect(debug.commands).toContainEqual({
			method: "DOM.describeNode",
			params: { backendNodeId: 7, depth: 2, pierce: true },
		});
		expect(debug.commands).toContainEqual({ method: "Page.handleJavaScriptDialog", params: { accept: false } });
		expect(debug.commands.some(({ method }) => method.startsWith("Runtime."))).toBe(false);
	});

	it("observes OOPIF targets through flattened sessions", async () => {
		const { controller, debug, emit } = fixture();
		emit("Target.attachedToTarget", { sessionId: "target-1" });
		debug.responses.set("target-1:Accessibility.getFullAXTree", {
			nodes: [{ nodeId: "frame-button", backendDOMNodeId: 70, role: { value: "button" }, name: { value: "Frame" } }],
		});
		await vi.waitFor(() => {
			expect(
				debug.commands.some(
					({ method, sessionId }) => method === "Accessibility.enable" && sessionId === "target-1",
				),
			).toBe(true);
		});
		const result = await observe(controller);
		expect(result.state).toContain('button "Frame"');
		expect(debug.commands).toContainEqual({
			method: "Accessibility.getFullAXTree",
			params: {},
			sessionId: "target-1",
		});
	});

	it("downshifts JPEG quality and omits screenshots that cannot fit the cap", async () => {
		const large = Buffer.alloc(Math.ceil((MAX_BROWSER_SCREENSHOT_UTF8_BYTES * 3) / 4) + 128);
		const { controller, captureScreenshot } = fixture();
		captureScreenshot.mockImplementation(async (quality) => (quality === 75 ? large : Buffer.from("small")));
		const result = await observe(controller, { mode: "both" });
		expect(captureScreenshot).toHaveBeenCalledTimes(2);
		expect(result.screenshot?.data).toBe(Buffer.from("small").toString("base64"));
	});

	it("does not start queued input after cancellation", async () => {
		const { controller, debug } = fixture();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let firstAx = true;
		debug.handler = async (method) => {
			if (method === "Accessibility.getFullAXTree" && firstAx) {
				firstAx = false;
				await blocked;
				return axTree();
			}
			return debug.responses.get(method) ?? {};
		};
		const firstObservation = observe(controller);
		await vi.waitFor(() =>
			expect(debug.commands.some(({ method }) => method === "Accessibility.getFullAXTree")).toBe(true),
		);
		const abort = new AbortController();
		const queued = controller.act(
			{
				browserId: BROWSER_ID,
				documentId: "99999999-9999-4999-8999-999999999999",
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Click",
				risk: "ordinary",
				action: { type: "click", target: { x: 1, y: 1 } },
			},
			abort.signal,
		);
		abort.abort();
		release();
		await firstObservation;
		await expect(queued).rejects.toMatchObject({ name: "AbortError" });
		expect(debug.commands.filter(({ method }) => method.startsWith("Input."))).toHaveLength(0);
	});

	it("invalidates the document on navigation events and detaches only its own debugger", async () => {
		const { controller, debug, emit, detach } = fixture();
		const first = await observe(controller);
		emit("Page.frameNavigated", {});
		const second = await observe(controller);
		expect(second.documentId).not.toBe(first.documentId);
		detach();
		const third = await observe(controller);
		expect(third.documentId).not.toBe(second.documentId);
		controller.close();
		expect(debug.attached).toBe(false);
	});
});
