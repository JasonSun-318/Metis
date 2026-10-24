import type { BrowserActInput, BrowserObserveInput } from "@metis/app-protocol";
import { MAX_BROWSER_SCREENSHOT_UTF8_BYTES, MAX_BROWSER_STATE_UTF8_BYTES } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import {
	BrowserController,
	type BrowserControllerDependencies,
	type BrowserDebuggerTransport,
} from "../src/main/browser-controller.ts";
import { SELECT_NATIVE_OPTION } from "../src/main/browser-native-select.ts";

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
	debug.responses.set("DOM.getNodeForLocation", { backendNodeId: 8 });
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
	it("discards frame replies from an invalidated document before publishing elements", async () => {
		const { controller, debug, emit } = fixture();
		let first = true;
		debug.handler = async (method) => {
			if (method === "Accessibility.getFullAXTree" && first) {
				first = false;
				emit("Page.frameNavigated", { frame: { id: "new-frame", loaderId: "new-loader" } });
				return axTree("Old document action");
			}
			if (method === "Accessibility.getFullAXTree") return axTree("New document action");
			return debug.responses.get(method) ?? {};
		};
		const current = await observe(controller);
		expect(current.state).toContain("New document action");
		expect(current.state).not.toContain("Old document action");
		expect(debug.commands.filter(({ method }) => method === "Accessibility.getFullAXTree")).toHaveLength(2);
		controller.close();
	});
	it("reads local frame trees separately and prunes remote frame subtrees from the parent session", async () => {
		const { controller, debug, emit } = fixture();
		const remote = { frame: { id: "remote" }, childFrames: [{ frame: { id: "remote-child" } }] };
		debug.handler = async (method, params, sessionId) => {
			if (method === "Page.getFrameTree")
				return {
					frameTree: sessionId
						? remote
						: { frame: { id: "main" }, childFrames: [{ frame: { id: "local" } }, remote] },
				};
			if (method === "Accessibility.getFullAXTree") {
				const frame = String(params.frameId);
				return {
					nodes: [
						{ nodeId: "root", role: { value: "RootWebArea" }, name: { value: frame } },
						{
							nodeId: "field",
							parentId: "root",
							backendDOMNodeId: frame === "local" ? 20 : 30,
							role: { value: frame === "local" ? "textbox" : "button" },
							name: { value: `Control ${frame}` },
						},
						{
							nodeId: "text",
							parentId: "field",
							role: { value: "StaticText" },
							name: { value: frame === "local" ? "SYNTHETIC_SECRET" : "Public text" },
						},
					],
				};
			}
			return debug.responses.get(method) ?? {};
		};
		emit("Target.attachedToTarget", { sessionId: "remote-session" });
		const first = await observe(controller);
		expect(first.state).not.toContain("SYNTHETIC_SECRET");
		for (const frame of ["main", "local", "remote", "remote-child"])
			expect(first.state).toContain(`Control ${frame}`);
		expect(debug.commands.filter(({ method }) => method === "Accessibility.getFullAXTree")).toEqual([
			{ method: "Accessibility.getFullAXTree", params: { frameId: "main" } },
			{ method: "Accessibility.getFullAXTree", params: { frameId: "local" } },
			{ method: "Accessibility.getFullAXTree", params: { frameId: "remote" }, sessionId: "remote-session" },
			{ method: "Accessibility.getFullAXTree", params: { frameId: "remote-child" }, sessionId: "remote-session" },
		]);
		expect((await observe(controller)).revision).toBe(first.revision);
		controller.close();
	});

	it("never sends arbitrary Runtime code, including the select function on an unregistered object", async () => {
		const { controller, debug } = fixture();
		const transport = controller as unknown as {
			command(
				method: string,
				params: Record<string, unknown>,
				sessionId: undefined,
				signal: AbortSignal,
			): Promise<unknown>;
		};
		for (const [method, params] of [
			["Runtime.evaluate", { expression: "document.body.innerHTML" }],
			[
				"Runtime.callFunctionOn",
				{
					objectId: "unknown",
					functionDeclaration: SELECT_NATIVE_OPTION,
					arguments: [{ value: "x" }],
					returnByValue: true,
					userGesture: true,
				},
			],
			["Runtime.releaseObject", { objectId: "unknown" }],
		] as const)
			await expect(transport.command(method, params, undefined, new AbortController().signal)).rejects.toThrow(
				"forbidden",
			);
		expect(debug.commands).toHaveLength(0);
		controller.close();
	});

	it("releases the native select object when cancellation interrupts its operation", async () => {
		const { controller, debug } = fixture();
		debug.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
		debug.responses.set("Page.createIsolatedWorld", { executionContextId: 42 });
		debug.responses.set("DOM.resolveNode", { object: { objectId: "select-object" } });
		const first = await observe(controller);
		const abort = new AbortController();
		debug.handler = async (method) => {
			if (method === "Runtime.callFunctionOn") {
				abort.abort(new Error("Selection cancelled"));
				return new Promise(() => {});
			}
			return debug.responses.get(method) ?? {};
		};
		await expect(
			controller.act(
				action(first, { type: "select", elementId: "e1", value: 'literal ";alert(1)//' }),
				abort.signal,
			),
		).rejects.toThrow("Selection cancelled");
		expect(debug.commands.filter(({ method }) => method === "Runtime.releaseObject")).toEqual([
			{ method: "Runtime.releaseObject", params: { objectId: "select-object" } },
		]);
		expect(debug.commands.find(({ method }) => method === "Runtime.callFunctionOn")?.params).toMatchObject({
			functionDeclaration: SELECT_NATIVE_OPTION,
			arguments: [{ value: 'literal ";alert(1)//' }],
		});
		controller.close();
	});

	it("releases a composite shortcut exactly once when cancellation follows key down", async () => {
		const { controller, debug } = fixture();
		const first = await observe(controller);
		const abort = new AbortController();
		debug.handler = async (method, params) => {
			if (method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown")
				abort.abort(new Error("Chord cancelled"));
			return debug.responses.get(method) ?? {};
		};
		await expect(
			controller.act(action(first, { type: "press", key: "Control+Shift+ArrowLeft" }), abort.signal),
		).rejects.toThrow("Chord cancelled");
		expect(
			debug.commands
				.filter(({ method }) => method === "Input.dispatchKeyEvent")
				.map(({ params }) => ({ type: params.type, key: params.key, modifiers: params.modifiers })),
		).toEqual([
			{ type: "rawKeyDown", key: "ArrowLeft", modifiers: 10 },
			{ type: "keyUp", key: "ArrowLeft", modifiers: 10 },
		]);
		controller.close();
	});
	it.each(["true", "false", "mixed"])("preserves Chromium's string checked state %s", async (checked) => {
		const { controller, debug } = fixture();
		const tree = axTree();
		debug.responses.set("Accessibility.getFullAXTree", {
			nodes: tree.nodes.map((node) =>
				node.nodeId === "checkbox"
					? { ...node, properties: [{ name: "checked", value: { value: checked } }] }
					: node,
			),
		});
		expect((await observe(controller)).state).toContain(`checked=${checked}`);
		controller.close();
	});

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

	it("redacts editable descendants through ignored ancestors before building diffs", async () => {
		const { controller, debug } = fixture();
		const tree = {
			nodes: [
				...axTree().nodes,
				{ nodeId: "ignored", parentId: "input", ignored: true },
				{ nodeId: "text", parentId: "ignored", role: { value: "StaticText" }, name: { value: "private OTP" } },
				{
					nodeId: "rich",
					role: { value: "generic" },
					name: { value: "Editor" },
					properties: [{ name: "editable", value: { value: "richtext" } }],
				},
				{
					nodeId: "rich-text",
					parentId: "rich",
					role: { value: "StaticText" },
					name: { value: "private document" },
				},
				{ nodeId: "article", role: { value: "StaticText" }, name: { value: "Public article" } },
				{ nodeId: "select", role: { value: "combobox" }, name: { value: "Theme" } },
				{ nodeId: "option", parentId: "select", role: { value: "option" }, name: { value: "Dark" } },
			],
		};
		debug.responses.set("Accessibility.getFullAXTree", tree);
		const first = await observe(controller);
		expect(first.state).not.toContain("private");
		for (const label of ["Email", "Editor", "Public article", "Dark"]) expect(first.state).toContain(label);
		tree.nodes.find((node) => node.nodeId === "text")!.name = { value: "private changed OTP" };
		const second = await observe(controller, { sinceRevision: first.revision });
		expect(second).toMatchObject({ change: "unchanged", state: "" });
		controller.close();
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

	it("keeps strict mutation checks for higher-risk clicks after target resolution", async () => {
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
				{ ...action(first, { type: "click", target: { elementId: "e2" } }), risk: "external_side_effect" },
				new AbortController().signal,
			),
		).resolves.toMatchObject({ status: "stale", reason: "revision_changed" });
		expect(created.debug.commands.filter(({ method }) => method.startsWith("Input."))).toHaveLength(0);
	});

	it("allows a stable ordinary target despite unrelated changes during each AX read", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		let tick = 0;
		created.debug.handler = async (method) => {
			if (method === "Accessibility.getFullAXTree") {
				created.emit("DOM.characterDataModified", { nodeId: 999 });
				return {
					nodes: [
						...axTree().nodes,
						{ nodeId: "ticker", role: { value: "StaticText" }, name: { value: String(++tick) } },
					],
				};
			}
			return created.debug.responses.get(method) ?? {};
		};
		expect(
			await created.controller.act(
				action(first, { type: "click", target: { elementId: "e2" } }),
				new AbortController().signal,
			),
		).toMatchObject({ status: "completed" });
		expect(created.debug.commands.filter(({ params }) => params.type === "mousePressed")).toHaveLength(1);
	});

	it.each(["replacement", "label", "checked", "disabled", "url", "ancestor"])(
		"rejects changed target %s even for an ordinary click",
		async (change) => {
			const created = fixture();
			const first = await observe(created.controller);
			const nodes = axTree().nodes.map((node) => {
				if (change === "ancestor" && node.nodeId === "root")
					return { ...node, name: { value: "Different context" } };
				if (node.nodeId !== "button") return node;
				if (change === "replacement") return { ...node, backendDOMNodeId: 88 };
				if (change === "label") return { ...node, name: { value: "Different action" } };
				return {
					...node,
					properties: [{ name: change, value: { value: change === "url" ? "https://different.test/" : true } }],
				};
			});
			created.debug.responses.set("Accessibility.getFullAXTree", { nodes });
			const result = await created.controller.act(
				action(first, { type: "click", target: { elementId: "e2" } }),
				new AbortController().signal,
			);
			expect(result.status).toBe("stale");
			expect(created.debug.commands.filter(({ method }) => method.startsWith("Input."))).toHaveLength(0);
		},
	);

	it("rechecks target semantics after hover before activation", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.handler = async (method, params) => {
			if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved")
				created.debug.responses.set("Accessibility.getFullAXTree", axTree("Changed on hover"));
			return created.debug.responses.get(method) ?? {};
		};
		expect(
			await created.controller.act(
				action(first, { type: "click", target: { elementId: "e2" } }),
				new AbortController().signal,
			),
		).toMatchObject({ status: "stale", reason: "revision_changed" });
		expect(created.debug.commands.filter(({ params }) => params.type === "mousePressed")).toHaveLength(0);
	});

	it.each([
		{ inputAction: { type: "click", target: { x: 20, y: 30 } }, risk: "ordinary" },
		{ inputAction: { type: "press", key: "Enter" }, risk: "ordinary" },
		{ inputAction: { type: "click", target: { elementId: "e2" } }, risk: "financial" },
	] satisfies Array<{ inputAction: BrowserActInput["action"]; risk: BrowserActInput["risk"] }>)(
		"retains full-state freshness for $inputAction.type with $risk risk",
		async ({ inputAction, risk }) => {
			const created = fixture();
			const first = await observe(created.controller);
			created.debug.responses.set("Accessibility.getFullAXTree", {
				nodes: [...axTree().nodes, { nodeId: "ticker", role: { value: "StaticText" }, name: { value: "Tick" } }],
			});
			expect(
				await created.controller.act({ ...action(first, inputAction), risk }, new AbortController().signal),
			).toMatchObject({ status: "stale", reason: "revision_changed" });
			expect(created.debug.commands.filter(({ method }) => method.startsWith("Input."))).toHaveLength(0);
		},
	);

	it("falls back to full paged state for an oversized diff and explicitly resets an expired cursor", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.responses.set("Accessibility.getFullAXTree", {
			nodes: Array.from({ length: 800 }, (_, i) => ({
				nodeId: String(i),
				role: { value: "StaticText" },
				name: { value: `Item ${i} ${"text ".repeat(40)}` },
			})),
		});
		const large = await observe(created.controller, { sinceRevision: first.revision });
		expect(large.change).toBe("full");
		expect(large.statePage?.nextCursor).toBeDefined();
		expect(JSON.stringify(large).length).toBeLessThan(50_000);
		created.debug.responses.set("Accessibility.getFullAXTree", axTree("New page state"));
		const restarted = await observe(created.controller, { cursor: large.statePage!.nextCursor });
		expect(restarted).toMatchObject({ change: "full", cursorReset: true, statePage: { offset: 0 } });
		expect(restarted.state).toContain("New page state");
	});

	it("finishes an atomic key sequence when keyDown navigates", async () => {
		const created = fixture();
		const first = await observe(created.controller);
		created.debug.handler = async (method, params, sessionId) => {
			if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
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
		).toEqual(["keyDown", "keyUp"]);
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
			if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
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
		).toEqual(["keyDown", "keyUp"]);

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
		debug.responses.set("DOM.getNodeForLocation", { backendNodeId: 7 });
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

	it("rejects obscured and disabled elements without pointer activation", async () => {
		for (const disabled of [false, true]) {
			const { controller, debug } = fixture();
			const tree = axTree();
			if (disabled) tree.nodes[2]!.properties = [{ name: "disabled", value: { value: true } }];
			debug.responses.set("Accessibility.getFullAXTree", tree);
			debug.responses.set("DOM.getNodeForLocation", { backendNodeId: disabled ? 8 : 90 });
			debug.responses.set("DOM.describeNode", { node: { backendNodeId: 8 } });
			const current = await observe(controller);
			expect(
				await controller.act(
					action(current, { type: "click", target: { elementId: "e2" } }),
					new AbortController().signal,
				),
			).toMatchObject({ status: "stale", reason: "element_not_interactable" });
			expect(
				debug.commands.some(
					({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
				),
			).toBe(false);
		}
	});

	it("converts viewport pointer coordinates to page coordinates for hit testing", async () => {
		const { controller, debug } = fixture();
		debug.responses.set("Page.getLayoutMetrics", {
			cssLayoutViewport: { pageX: 40, pageY: 1800, clientWidth: 800, clientHeight: 600 },
		});
		const current = await observe(controller);
		expect(
			await controller.act(
				action(current, { type: "click", target: { elementId: "e2" } }),
				new AbortController().signal,
			),
		).toMatchObject({ status: "completed" });
		expect(debug.commands).toContainEqual({
			method: "DOM.getNodeForLocation",
			params: { x: 60, y: 1830, includeUserAgentShadowDOM: true },
		});
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchMouseEvent",
			params: { type: "mousePressed", x: 20, y: 30, button: "left", buttons: 1, clickCount: 1 },
		});
	});

	it("allows a hit on the intended element's descendant", async () => {
		const { controller, debug } = fixture();
		debug.responses.set("DOM.getNodeForLocation", { backendNodeId: 81 });
		debug.responses.set("DOM.describeNode", { node: { backendNodeId: 8, children: [{ backendNodeId: 81 }] } });
		const current = await observe(controller);
		expect(
			await controller.act(
				action(current, { type: "click", target: { elementId: "e2" } }),
				new AbortController().signal,
			),
		).toMatchObject({ status: "completed" });
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

	it.each([
		[{ result: { value: { failure: "selection_changed" } } }, "selection_changed", "dispatched"],
		[{ result: { value: { failure: "option_unavailable" } } }, "option_unavailable", "not_started"],
		[{ result: { value: { failure: "select_changed" } } }, "select_changed", "unknown"],
		[{ result: { value: { failure: "PRIVATE_PAGE_VALUE" } } }, "selection_unconfirmed", "unknown"],
		[{ exceptionDetails: { text: "PRIVATE_PAGE_VALUE" } }, "selection_unconfirmed", "unknown"],
	])("preserves safe selection failure receipts and releases resolved objects", async (reply, reason, execution) => {
		const { controller, debug } = fixture();
		debug.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main-frame" } } });
		debug.responses.set("Page.createIsolatedWorld", { executionContextId: 42 });
		debug.responses.set("DOM.resolveNode", { object: { objectId: "select-object" } });
		debug.responses.set("Runtime.callFunctionOn", reply);
		try {
			const before = await observe(controller);
			const result = await controller.act(
				action(before, { type: "select", elementId: "e1", value: "PRIVATE_CHOICE" }),
				new AbortController().signal,
			);
			expect(result).toMatchObject({ status: "failed", reason, execution, recovery: "observe" });
			expect(JSON.stringify(result)).not.toContain("PRIVATE_");
			expect(debug.commands).toContainEqual({
				method: "Runtime.releaseObject",
				params: { objectId: "select-object" },
			});
		} finally {
			controller.close();
		}
	});

	it("covers native inputs and limits select runtime execution to a resolved isolated object", async () => {
		const { controller, debug, emit } = fixture();
		debug.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main-frame" } } });
		debug.responses.set("Page.createIsolatedWorld", { executionContextId: 42 });
		debug.responses.set("DOM.resolveNode", { object: { objectId: "select-object" } });
		debug.responses.set("Runtime.callFunctionOn", { result: { value: { selected: true } } });
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
		emit("Page.javascriptDialogOpening", { type: "confirm", message: "Continue?" });
		current = await observe(controller);
		await run({ type: "dialog", decision: "dismiss" });

		expect(debug.commands).toContainEqual({
			method: "Input.dispatchMouseEvent",
			params: { type: "mouseWheel", x: 20, y: 30, deltaX: 0, deltaY: 1_600 },
		});
		expect(debug.commands).toContainEqual({
			method: "Page.createIsolatedWorld",
			params: { frameId: "main-frame", worldName: "metis-browser-select" },
		});
		expect(debug.commands).toContainEqual({
			method: "DOM.resolveNode",
			params: { backendNodeId: 7, executionContextId: 42 },
		});
		expect(debug.commands.find(({ method }) => method === "Runtime.callFunctionOn")?.params).toMatchObject({
			objectId: "select-object",
			arguments: [{ value: "two" }],
			returnByValue: true,
			userGesture: true,
		});
		expect(debug.commands).toContainEqual({ method: "Runtime.releaseObject", params: { objectId: "select-object" } });
		expect(debug.commands).toContainEqual({
			method: "Input.dispatchKeyEvent",
			params: {
				type: "keyDown",
				text: "\r",
				unmodifiedText: "\r",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
				modifiers: 0,
			},
		});
		expect(debug.commands).toContainEqual({ method: "Page.handleJavaScriptDialog", params: { accept: false } });
		expect(debug.commands.filter(({ method }) => method.startsWith("Runtime.")).map(({ method }) => method)).toEqual([
			"Runtime.callFunctionOn",
			"Runtime.releaseObject",
		]);
	});

	it("yields suspended input to a dialog and releases input exactly once", async () => {
		const { controller, debug, emit, captureScreenshot } = fixture();
		const first = await observe(controller);
		debug.handler = async (method, params) => {
			if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
				emit(
					"Page.javascriptDialogOpening",
					{ type: "prompt", message: "Continue?", defaultPrompt: "private default" },
					"",
				);
				return new Promise(() => undefined);
			}
			if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") return new Promise(() => undefined);
			if (method === "Page.handleJavaScriptDialog") emit("Page.javascriptDialogClosed", { result: false }, "");
			return debug.responses.get(method) ?? {};
		};
		const result = await controller.act(action(first, { type: "press", key: "Enter" }), new AbortController().signal);
		expect(result.status).toBe("completed");
		const pending = await observe(controller, { mode: "both" });
		expect(pending.state).toContain('dialog "Continue?"');
		expect(pending.state).toContain("type=prompt");
		expect(pending.state).not.toContain("private default");
		expect(captureScreenshot).not.toHaveBeenCalled();
		expect(
			debug.commands.filter(({ method, params }) => method === "Input.dispatchKeyEvent" && params.type === "keyUp"),
		).toHaveLength(1);
		const stale = await controller.act(
			action(first, { type: "dialog", decision: "accept" }),
			new AbortController().signal,
		);
		expect(stale.status).toBe("stale");
		expect(debug.commands.some(({ method }) => method === "Page.handleJavaScriptDialog")).toBe(false);
		const resolved = await controller.act(
			action(pending, { type: "dialog", decision: "dismiss" }),
			new AbortController().signal,
		);
		expect(resolved).toMatchObject({ status: "completed", observation: { change: "full" } });
		const after = await observe(controller);
		expect(after.documentId).not.toBe(pending.documentId);
		expect(after.state).toContain("Continue");
		emit("Page.javascriptDialogOpening", { type: "prompt", message: "Continue?" }, "");
		const reopened = await observe(controller);
		expect(reopened.state).not.toBe(pending.state);
		expect(
			await controller.act(action(pending, { type: "dialog", decision: "accept" }), new AbortController().signal),
		).toMatchObject({ status: "stale", reason: "document_changed" });
		controller.close();
	});

	it("interrupts a suspended AX read when a dialog opens and clears it on detach", async () => {
		const { controller, debug, emit, detach } = fixture();
		let open = true;
		debug.handler = async (method) => {
			if (method === "Accessibility.getFullAXTree" && open) {
				open = false;
				emit("Page.javascriptDialogOpening", { type: "alert", message: "Notice" });
				return new Promise(() => undefined);
			}
			return debug.responses.get(method) ?? {};
		};
		const pending = await observe(controller);
		expect(pending.state).toContain('dialog "Notice"');
		const inputCount = debug.commands.filter(({ method }) => method.startsWith("Input.")).length;
		expect(
			await controller.act(action(pending, { type: "press", key: "Enter" }), new AbortController().signal),
		).toMatchObject({ status: "stale" });
		expect(debug.commands.filter(({ method }) => method.startsWith("Input."))).toHaveLength(inputCount);
		detach();
		expect((await observe(controller)).state).not.toContain('dialog "Notice"');
		controller.close();
	});

	it("interrupts a suspended screenshot when a dialog opens", async () => {
		const { controller, emit, captureScreenshot } = fixture();
		captureScreenshot.mockImplementation(async () => {
			emit("Page.javascriptDialogOpening", { type: "alert", message: "Screenshot interrupted" });
			return new Promise<never>(() => undefined);
		});
		const result = await observe(controller, { mode: "both" });
		expect(result.state).toContain('dialog "Screenshot interrupted"');
		expect(result.screenshot).toBeUndefined();
		expect(captureScreenshot).toHaveBeenCalledOnce();
		controller.close();
	});

	it("keeps dialog interruption active when navigation occurs during an AX read", async () => {
		const { controller, debug, emit } = fixture();
		debug.handler = async (method) => {
			if (method === "Accessibility.getFullAXTree") {
				emit("Page.frameNavigated", { frame: { id: "main", loaderId: "next" } });
				emit("Page.javascriptDialogOpening", { type: "alert", message: "After navigation" });
				return new Promise(() => undefined);
			}
			return debug.responses.get(method) ?? {};
		};
		expect((await observe(controller)).state).toContain('dialog "After navigation"');
		controller.close();
	});

	it("preserves cancellation while input opens a dialog", async () => {
		const { controller, debug, emit } = fixture();
		const first = await observe(controller);
		const abort = new AbortController();
		debug.handler = async (method, params) => {
			if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
				emit("Page.javascriptDialogOpening", { type: "confirm", message: "Continue?" });
				abort.abort(new Error("Turn interrupted"));
				return new Promise(() => undefined);
			}
			return debug.responses.get(method) ?? {};
		};
		await expect(controller.act(action(first, { type: "press", key: "Enter" }), abort.signal)).rejects.toThrow(
			"Turn interrupted",
		);
		expect(
			debug.commands.filter(({ method, params }) => method === "Input.dispatchKeyEvent" && params.type === "keyUp"),
		).toHaveLength(1);
		controller.close();
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
