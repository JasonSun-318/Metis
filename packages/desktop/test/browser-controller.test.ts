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
			{
				nodeId: "checkbox",
				parentId: "root",
				backendDOMNodeId: 9,
				role: { value: "checkbox" },
				name: { value: "Remember" },
				properties: [
					{ name: "checked", value: { value: true } },
					{ name: "selected", value: { value: false } },
				],
			},
		],
	};
}

function fixture(
	overrides: Partial<Pick<BrowserControllerDependencies, "stabilizationQuietMs" | "stabilizationTimeoutMs">> = {},
) {
	const debug = new FakeDebugger();
	debug.responses.set("Accessibility.getFullAXTree", axTree());
	debug.responses.set("DOM.getBoxModel", { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } });
	debug.responses.set("Page.getLayoutMetrics", { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } });
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
		subscriptions: () => ({ message: Boolean(message), detach: Boolean(detach) }),
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
	it("keeps 100 observe/action cycles bounded and releases debugger subscriptions", async () => {
		let sequence = 0;
		const created = fixture();
		const { debug } = created;
		debug.handler = async (method, params, sessionId) => {
			if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
				sequence += 1;
				debug.responses.set("Accessibility.getFullAXTree", axTree(`Step ${sequence}`));
			}
			return debug.responses.get(`${sessionId ?? "main"}:${method}`) ?? debug.responses.get(method) ?? {};
		};
		let current = await observe(created.controller);
		for (let index = 0; index < 100; index += 1) {
			const result = await created.controller.act(
				action(current, { type: "click", target: { elementId: "e2" } }),
				new AbortController().signal,
			);
			expect(result.status).toBe("completed");
			if (result.status === "completed") current = result.observation;
			expect(Buffer.byteLength(current.state, "utf8")).toBeLessThanOrEqual(MAX_BROWSER_STATE_UTF8_BYTES);
		}
		expect(current.revision).toBe(101);
		expect(
			debug.commands.filter(
				({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased",
			),
		).toHaveLength(100);
		expect(created.subscriptions()).toEqual({ message: true, detach: true });
		created.controller.close();
		expect(created.subscriptions()).toEqual({ message: false, detach: false });
		expect(debug.attached).toBe(false);
	});

	it("attaches lazily, enables CDP domains, and emits an AX-first redacted state", async () => {
		const { controller, debug } = fixture();
		expect(debug.attached).toBe(false);
		const result = await observe(controller);
		expect(debug.attached).toBe(true);
		expect(debug.commands.slice(0, 5).map(({ method }) => method)).toEqual([
			"Page.enable",
			"DOM.enable",
			"Accessibility.enable",
			"Page.setLifecycleEventsEnabled",
			"Target.setAutoAttach",
		]);
		expect(result.change).toBe("full");
		expect(result.state).toContain('e1 textbox "Email" [enabled, non-empty, actions=click|type]');
		expect(result.state).toContain('e2 button "Continue" [enabled, actions=click]');
		expect(result.state).toContain('e3 checkbox "Remember" [enabled, checked=true, selected=false, actions=click]');
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

	it("rechecks the document after resolving a target and before dispatching input", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.handler = async (method, _params, sessionId) => {
			if (method === "DOM.getContentQuads") {
				created.page.url = "https://other.test/replaced";
				created.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "loader-2" } });
			}
			return (
				created.debug.responses.get(`${sessionId ?? "main"}:${method}`) ?? created.debug.responses.get(method) ?? {}
			);
		};

		await expect(
			created.controller.act(
				action(first, { type: "click", target: { elementId: "e2" } }),
				new AbortController().signal,
			),
		).resolves.toMatchObject({ status: "stale", reason: "document_changed" });
		expect(created.debug.commands.filter(({ method }) => method.startsWith("Input."))).toHaveLength(0);
	});

	it("fails closed when the same document changes after target resolution", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.handler = async (method, _params, sessionId) => {
			if (method === "DOM.getContentQuads") created.emit("DOM.attributeModified", { nodeId: 8 });
			return (
				created.debug.responses.get(`${sessionId ?? "main"}:${method}`) ?? created.debug.responses.get(method) ?? {}
			);
		};

		await expect(
			created.controller.act(
				action(first, { type: "click", target: { elementId: "e2" } }),
				new AbortController().signal,
			),
		).resolves.toMatchObject({ status: "stale", reason: "revision_changed" });
		expect(created.debug.commands.filter(({ method }) => method.startsWith("Input."))).toHaveLength(0);
	});

	it("finishes an atomic key sequence when keyDown navigates", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.handler = async (method, params, sessionId) => {
			if (method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown") {
				created.page.url = "https://example.test/next";
				created.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "loader-2" } });
			}
			return (
				created.debug.responses.get(`${sessionId ?? "main"}:${method}`) ?? created.debug.responses.get(method) ?? {}
			);
		};

		await expect(
			created.controller.act(action(first, { type: "press", key: "Enter" }), new AbortController().signal),
		).resolves.toMatchObject({ status: "completed", observation: { url: "https://example.test/next" } });
		expect(
			created.debug.commands
				.filter(({ method }) => method === "Input.dispatchKeyEvent")
				.map(({ params }) => params.type),
		).toEqual(["rawKeyDown", "keyUp"]);
	});

	it("rechecks document identity after focus before inserting text", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.handler = async (method, _params, sessionId) => {
			if (method === "DOM.focus") {
				created.page.url = "https://other.test/after-focus";
				created.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "loader-2" } });
			}
			return (
				created.debug.responses.get(`${sessionId ?? "main"}:${method}`) ?? created.debug.responses.get(method) ?? {}
			);
		};

		await expect(
			created.controller.act(
				action(first, { type: "type", elementId: "e1", text: "secret" }),
				new AbortController().signal,
			),
		).resolves.toMatchObject({ status: "stale", reason: "document_changed" });
		expect(created.debug.commands).not.toContainEqual({ method: "Input.insertText", params: { text: "secret" } });
	});

	it("does not send Backspace when select-all navigates during replace", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.handler = async (method, params, sessionId) => {
			if (
				method === "Input.dispatchKeyEvent" &&
				params.type === "rawKeyDown" &&
				Array.isArray(params.commands) &&
				params.commands.includes("selectAll")
			) {
				created.page.url = "https://other.test/after-select-all";
				created.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "loader-2" } });
			}
			return (
				created.debug.responses.get(`${sessionId ?? "main"}:${method}`) ?? created.debug.responses.get(method) ?? {}
			);
		};

		await expect(
			created.controller.act(
				action(first, { type: "type", elementId: "e1", text: "secret", replace: true }),
				new AbortController().signal,
			),
		).resolves.toMatchObject({ status: "stale", reason: "document_changed" });
		expect(
			created.debug.commands.some(
				({ method, params }) => method === "Input.dispatchKeyEvent" && params.key === "Backspace",
			),
		).toBe(false);
	});

	it("best-effort releases keys and pointer buttons when cancellation follows input down", async () => {
		const keyFixture = fixture();
		const keyObservation = await observe(keyFixture.controller);
		const keyAbort = new AbortController();
		keyFixture.debug.handler = async (method, params, sessionId) => {
			if (method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown") {
				keyAbort.abort(new DOMException("Turn interrupted", "AbortError"));
			}
			return (
				keyFixture.debug.responses.get(`${sessionId ?? "main"}:${method}`) ??
				keyFixture.debug.responses.get(method) ??
				{}
			);
		};
		await expect(
			keyFixture.controller.act(action(keyObservation, { type: "press", key: "Enter" }), keyAbort.signal),
		).rejects.toThrow("Turn interrupted");
		expect(
			keyFixture.debug.commands
				.filter(({ method }) => method === "Input.dispatchKeyEvent")
				.map(({ params }) => params.type),
		).toEqual(["rawKeyDown", "keyUp"]);

		const pointerFixture = fixture();
		const pointerObservation = await observe(pointerFixture.controller);
		const pointerAbort = new AbortController();
		pointerFixture.debug.handler = async (method, params, sessionId) => {
			if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
				pointerAbort.abort(new DOMException("Turn interrupted", "AbortError"));
			}
			return (
				pointerFixture.debug.responses.get(`${sessionId ?? "main"}:${method}`) ??
				pointerFixture.debug.responses.get(method) ??
				{}
			);
		};
		await expect(
			pointerFixture.controller.act(
				action(pointerObservation, { type: "click", target: { elementId: "e2" } }),
				pointerAbort.signal,
			),
		).rejects.toThrow("Turn interrupted");
		expect(
			pointerFixture.debug.commands
				.filter(({ method }) => method === "Input.dispatchMouseEvent")
				.map(({ params }) => params.type),
		).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
	});

	it("bounds a hanging release and sends it only once", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.handler = async (method, params, sessionId) => {
			if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") return new Promise(() => undefined);
			return (
				created.debug.responses.get(`${sessionId ?? "main"}:${method}`) ?? created.debug.responses.get(method) ?? {}
			);
		};
		const startedAt = Date.now();

		await expect(
			created.controller.act(action(first, { type: "press", key: "Enter" }), new AbortController().signal),
		).rejects.toThrow("Browser input release timed out");
		expect(Date.now() - startedAt).toBeLessThan(1_500);
		expect(
			created.debug.commands.filter(
				({ method, params }) => method === "Input.dispatchKeyEvent" && params.type === "keyUp",
			),
		).toHaveLength(1);
	});

	it("uses DOM geometry and Input domain commands for click and text actions", async () => {
		const { controller, debug } = fixture();
		const first = await observe(controller);
		const clicked = await controller.act(
			action(first, { type: "click", target: { elementId: "e1" } }),
			new AbortController().signal,
		);
		expect(clicked.status).toBe("completed");
		expect(
			debug.commands.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => params.type),
		).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchMouseEvent",
			params: { type: "mousePressed", x: 20, y: 30, button: "left", buttons: 1, clickCount: 1 },
		});
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchMouseEvent",
			params: { type: "mouseReleased", x: 20, y: 30, button: "left", buttons: 0, clickCount: 1 },
		});
		const afterClick = clicked.status === "completed" ? clicked.observation : first;
		const typed = await controller.act(
			action(afterClick, { type: "type", elementId: "e1", text: "hello", replace: true }),
			new AbortController().signal,
		);
		expect(typed.status).toBe("completed");
		expect(debug.commands).toContainEqual({ method: "DOM.focus", params: { backendNodeId: 7 } });
		expect(debug.commands).toContainEqual({ method: "Input.insertText", params: { text: "hello" } });
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchKeyEvent",
			params: { type: "rawKeyDown", commands: ["selectAll"] },
		});
		expect(
			debug.commands.some(
				({ method, params }) => method === "Input.dispatchKeyEvent" && params.key === "a" && params.modifiers === 4,
			),
		).toBe(false);
		expect(debug.commands.some(({ method }) => method.startsWith("Runtime."))).toBe(false);
	});

	it("uses physical pointer activation for accessible element clicks", async () => {
		const { controller, debug } = fixture();
		const first = await observe(controller);
		await expect(
			controller.act(action(first, { type: "click", target: { elementId: "e2" } }), new AbortController().signal),
		).resolves.toMatchObject({ status: "completed" });
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchMouseEvent",
			params: { type: "mousePressed", x: 20, y: 30, button: "left", buttons: 1, clickCount: 1 },
		});
		expect(debug.commands.filter(({ method }) => method === "Input.dispatchKeyEvent")).toHaveLength(0);
	});

	it("returns a fresh post-action observation after CDP pointer input", async () => {
		const created = fixture();
		const { controller, debug } = created;
		debug.handler = async (method, params, sessionId) => {
			if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
				debug.responses.set("Accessibility.getFullAXTree", axTree("Authorized"));
			}
			return debug.responses.get(`${sessionId ?? "main"}:${method}`) ?? debug.responses.get(method) ?? {};
		};
		const first = await observe(controller);
		const result = await controller.act(
			action(first, { type: "click", target: { elementId: "e2" } }),
			new AbortController().signal,
		);
		expect(result).toMatchObject({ status: "completed", observation: { revision: 2 } });
		if (result.status === "completed") expect(result.observation.state).toContain('button "Authorized"');
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchMouseEvent",
			params: { type: "mouseReleased", x: 20, y: 30, button: "left", buttons: 0, clickCount: 1 },
		});
	});

	it("rejects coordinate input outside the current viewport", async () => {
		const { controller, debug } = fixture();
		const first = await observe(controller);
		const valid = await controller.act(
			action(first, { type: "hover", target: { x: 799, y: 599 } }),
			new AbortController().signal,
		);
		expect(valid).toMatchObject({ status: "completed" });
		const current = valid.status === "completed" ? valid.observation : first;
		const beforeRejected = debug.commands.filter(({ method }) => method === "Input.dispatchMouseEvent").length;
		await expect(
			controller.act(action(current, { type: "hover", target: { x: 800, y: 599 } }), new AbortController().signal),
		).rejects.toThrow("within the current viewport");
		await expect(
			controller.act(action(current, { type: "hover", target: { x: -1, y: 0 } }), new AbortController().signal),
		).rejects.toThrow("within the current viewport");
		expect(debug.commands.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(beforeRejected);
	});

	it("cancels an in-flight CDP command when the page closes", async () => {
		const { controller, debug } = fixture();
		const first = await observe(controller);
		debug.handler = async (method) => {
			if (method === "Input.dispatchMouseEvent") return new Promise(() => undefined);
			return debug.responses.get(method) ?? {};
		};
		const abort = new AbortController();
		const pending = controller.act(action(first, { type: "click", target: { elementId: "e2" } }), abort.signal);
		await vi.waitFor(() =>
			expect(debug.commands.some(({ method }) => method === "Input.dispatchMouseEvent")).toBe(true),
		);
		abort.abort(new DOMException("Page closed", "AbortError"));

		await expect(pending).rejects.toThrow("Page closed");
	});

	it("rejects an in-flight command when Electron detaches the debugger", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		let release!: () => void;
		let blocked = true;
		created.debug.handler = async (method) => {
			if (blocked && method === "Input.dispatchMouseEvent") {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return created.debug.responses.get(method) ?? {};
		};
		const pending = created.controller.act(
			action(first, { type: "click", target: { elementId: "e2" } }),
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(created.debug.commands.some(({ method }) => method === "Input.dispatchMouseEvent")).toBe(true),
		);
		created.detach();
		const outcome = await Promise.race([
			pending.then(
				() => "resolved",
				() => "rejected",
			),
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
		]);
		blocked = false;
		release();
		await pending.catch(() => undefined);
		expect(outcome).toBe("rejected");
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
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchKeyEvent",
			params: {
				type: "keyDown",
				key: "t",
				code: "KeyT",
				windowsVirtualKeyCode: 84,
				text: "t",
				unmodifiedText: "t",
			},
		});
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchKeyEvent",
			params: {
				type: "rawKeyDown",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
			},
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

	it("uses fixed JPEG quality 75 and rejects screenshots that cannot fit the cap", async () => {
		const small = fixture();
		const result = await observe(small.controller, { mode: "both" });
		expect(small.captureScreenshot).toHaveBeenCalledOnce();
		expect(small.captureScreenshot).toHaveBeenCalledWith(75);
		expect(result.screenshot?.data).toBe(Buffer.from("jpeg").toString("base64"));

		const large = Buffer.alloc(Math.ceil((MAX_BROWSER_SCREENSHOT_UTF8_BYTES * 3) / 4) + 128);
		const { controller, captureScreenshot } = fixture();
		captureScreenshot.mockResolvedValue(large);
		await expect(observe(controller, { mode: "both" })).rejects.toThrow("4 MiB");
		expect(captureScreenshot).toHaveBeenCalledOnce();
		expect(captureScreenshot).toHaveBeenCalledWith(75);
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
		emit("Page.frameNavigated", { frame: { id: "frame-1", loaderId: "loader-1" } }, "target-1");
		const second = await observe(controller);
		expect(second.documentId).not.toBe(first.documentId);
		emit("Page.lifecycleEvent", { frameId: "frame-1", loaderId: "loader-1", name: "load" }, "target-1");
		const sameLoader = await observe(controller);
		expect(sameLoader.documentId).toBe(second.documentId);
		emit("Page.lifecycleEvent", { frameId: "frame-1", loaderId: "loader-2", name: "init" }, "target-1");
		const changedLoader = await observe(controller);
		expect(changedLoader.documentId).not.toBe(sameLoader.documentId);
		detach();
		const third = await observe(controller);
		expect(third.documentId).not.toBe(changedLoader.documentId);
		controller.close();
		expect(debug.attached).toBe(false);
	});

	it("clears retained snapshots and element mappings when closed", async () => {
		const { controller } = fixture();
		await observe(controller);
		const retained = controller as unknown as {
			current?: unknown;
			previous?: unknown;
			elements: Map<string, unknown>;
			elementIds: Map<string, string>;
		};
		expect(retained.current).toBeDefined();
		expect(retained.elements.size).toBeGreaterThan(0);
		controller.close();
		expect(retained.current).toBeUndefined();
		expect(retained.previous).toBeUndefined();
		expect(retained.elements.size).toBe(0);
		expect(retained.elementIds.size).toBe(0);
	});
});
