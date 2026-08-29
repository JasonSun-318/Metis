import { randomUUID } from "node:crypto";
import type {
	BrowserActInput,
	BrowserAction,
	BrowserObservation,
	BrowserObserveInput,
	BrowserOperationDetails,
} from "@metis/app-protocol";
import { MAX_BROWSER_SCREENSHOT_UTF8_BYTES, MAX_BROWSER_STATE_UTF8_BYTES } from "@metis/app-protocol";

const MAX_AX_NODES = 3_000;
const SCREENSHOT_QUALITIES = [75, 60, 45, 30] as const;
const INTERACTIVE_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"link",
	"listbox",
	"menuitem",
	"option",
	"radio",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
	"treeitem",
]);
const LANDMARK_ROLES = new Set([
	"banner",
	"complementary",
	"contentinfo",
	"form",
	"main",
	"navigation",
	"region",
	"search",
]);
const EDITABLE_ROLES = new Set(["combobox", "searchbox", "spinbutton", "textbox"]);

type CdpParams = Record<string, unknown>;

export interface BrowserDebuggerTransport {
	isAttached(): boolean;
	attach(protocolVersion?: string): void;
	detach(): void;
	sendCommand(method: string, params?: CdpParams, sessionId?: string): Promise<unknown>;
}

export interface BrowserControllerDependencies {
	readonly browserId: string;
	readonly profileId: string;
	readonly debugger: BrowserDebuggerTransport;
	readonly pageState: () => { readonly url: string; readonly title: string; readonly loading: boolean };
	readonly captureScreenshot: (quality: number) => Promise<Buffer>;
	readonly subscribeMessage: (listener: (method: string, params: CdpParams, sessionId?: string) => void) => () => void;
	readonly subscribeDetach: (listener: () => void) => () => void;
	readonly acceleratorModifier?: number;
}

interface AxValue {
	readonly value?: unknown;
}

interface AxProperty {
	readonly name?: string;
	readonly value?: AxValue;
}

interface AxNode {
	readonly nodeId?: string;
	readonly parentId?: string;
	readonly ignored?: boolean;
	readonly backendDOMNodeId?: number;
	readonly role?: AxValue;
	readonly name?: AxValue;
	readonly value?: AxValue;
	readonly properties?: readonly AxProperty[];
}

interface ElementTarget {
	readonly elementId: string;
	readonly backendNodeId: number;
	readonly sessionId?: string;
	readonly role: string;
}

interface Snapshot {
	readonly revision: number;
	readonly state: string;
}

interface Point {
	readonly x: number;
	readonly y: number;
	readonly sessionId?: string;
}

function stringValue(value: AxValue | undefined): string {
	return typeof value?.value === "string" ? value.value : "";
}

function booleanProperty(node: AxNode, name: string): boolean {
	return node.properties?.some((property) => property.name === name && property.value?.value === true) ?? false;
}

function safeText(value: string): string {
	return JSON.stringify(value.replace(/[\r\n\t]+/gu, " ").trim());
}

function limitUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	const suffix = "\n[truncated]";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") + suffixBytes <= maximumBytes) low = middle;
		else high = middle - 1;
	}
	return `${value.slice(0, low)}${suffix}`;
}

function originOf(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
	} catch {
		return "";
	}
}

function nodePriority(node: AxNode): number {
	const role = stringValue(node.role).toLowerCase();
	if (booleanProperty(node, "focused")) return 0;
	if (INTERACTIVE_ROLES.has(role) || booleanProperty(node, "focusable")) return 1;
	if (LANDMARK_ROLES.has(role)) return 2;
	return 3;
}

function diffText(previous: string, current: string): string {
	const previousLines = new Set(previous.split("\n"));
	const currentLines = new Set(current.split("\n"));
	const lines = [
		...previous
			.split("\n")
			.filter((line) => !currentLines.has(line))
			.map((line) => `- ${line}`),
		...current
			.split("\n")
			.filter((line) => !previousLines.has(line))
			.map((line) => `+ ${line}`),
	];
	return limitUtf8(lines.join("\n"), MAX_BROWSER_STATE_UTF8_BYTES);
}

function axNodes(value: unknown): readonly AxNode[] {
	if (typeof value !== "object" || value === null) return [];
	const nodes = (value as { nodes?: unknown }).nodes;
	return Array.isArray(nodes) ? (nodes as readonly AxNode[]) : [];
}

function boxQuad(value: unknown): readonly number[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const model = (value as { model?: unknown }).model;
	if (typeof model !== "object" || model === null) return undefined;
	const candidate =
		(model as { content?: unknown; border?: unknown }).content ?? (model as { border?: unknown }).border;
	return Array.isArray(candidate) && candidate.length >= 8 && candidate.every((point) => typeof point === "number")
		? (candidate as number[])
		: undefined;
}

/** CDP-only browser observation and input controller. It never evaluates page JavaScript. */
export class BrowserController {
	private readonly dependencies: BrowserControllerDependencies;
	private readonly targetSessions = new Set<string>();
	private readonly elementIds = new Map<string, string>();
	private elements = new Map<string, ElementTarget>();
	private documentId = randomUUID();
	private nextElementId = 1;
	private previous?: Snapshot;
	private current?: Snapshot;
	private attachedByController = false;
	private attachPromise?: Promise<void>;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly unsubscribeMessage: () => void;
	private readonly unsubscribeDetach: () => void;

	constructor(dependencies: BrowserControllerDependencies) {
		this.dependencies = dependencies;
		this.unsubscribeMessage = dependencies.subscribeMessage((method, params, sessionId) => {
			this.onDebuggerMessage(method, params, sessionId);
		});
		this.unsubscribeDetach = dependencies.subscribeDetach(() => {
			this.attachedByController = false;
			this.attachPromise = undefined;
			this.invalidate();
		});
	}

	observe(input: BrowserObserveInput, signal: AbortSignal): Promise<BrowserObservation> {
		return this.exclusive(signal, () => this.observeCurrent(input, signal));
	}

	act(input: BrowserActInput, signal: AbortSignal): Promise<BrowserOperationDetails> {
		return this.exclusive(signal, async () => {
			const stale = async (reason: Extract<BrowserOperationDetails, { status: "stale" }>["reason"]) => ({
				status: "stale" as const,
				reason,
				observation: await this.observeCurrent(
					{ browserId: input.browserId, sinceRevision: input.snapshotRevision },
					signal,
				),
			});
			if (input.documentId !== this.documentId) return stale("document_changed");
			if (input.origin !== originOf(this.dependencies.pageState().url)) return stale("origin_changed");
			const fresh = await this.observeCurrent(
				{ browserId: input.browserId, sinceRevision: input.snapshotRevision },
				signal,
			);
			if (fresh.documentId !== input.documentId)
				return { status: "stale", reason: "document_changed", observation: fresh };
			if (fresh.revision !== input.snapshotRevision)
				return { status: "stale", reason: "revision_changed", observation: fresh };
			if (this.referencesMissingElement(input.action))
				return { status: "stale", reason: "element_missing", observation: fresh };
			try {
				await this.performAction(input.action, signal);
			} catch (cause) {
				if (signal.aborted) throw cause;
				if (cause instanceof MissingElementError) {
					return {
						status: "stale",
						reason: "element_missing",
						observation: await this.observeCurrent(
							{ browserId: input.browserId, sinceRevision: input.snapshotRevision },
							signal,
						),
					};
				}
				throw cause;
			}
			return {
				status: "completed",
				observation: await this.observeCurrent(
					{ browserId: input.browserId, sinceRevision: fresh.revision },
					signal,
				),
			};
		});
	}

	invalidate(): void {
		this.documentId = randomUUID();
		this.previous = undefined;
		this.current = undefined;
		this.elements.clear();
		this.elementIds.clear();
		this.nextElementId = 1;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribeMessage();
		this.unsubscribeDetach();
		this.targetSessions.clear();
		if (this.attachedByController && this.dependencies.debugger.isAttached()) this.dependencies.debugger.detach();
	}

	private async exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		const previous = this.queue.catch(() => undefined);
		let release!: () => void;
		this.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			signal.throwIfAborted();
			if (this.closed) throw new Error("Browser controller is closed");
			return await operation();
		} finally {
			release();
		}
	}

	private async ensureAttached(signal: AbortSignal): Promise<void> {
		if (this.attachPromise) return this.attachPromise;
		this.attachPromise = (async () => {
			signal.throwIfAborted();
			if (!this.dependencies.debugger.isAttached()) {
				this.dependencies.debugger.attach("1.3");
				this.attachedByController = true;
			}
			await this.enableSession(undefined, signal);
			await this.command(
				"Target.setAutoAttach",
				{ autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
				undefined,
				signal,
			);
		})();
		try {
			await this.attachPromise;
		} catch (cause) {
			this.attachPromise = undefined;
			throw cause;
		}
	}

	private async enableSession(sessionId: string | undefined, signal: AbortSignal): Promise<void> {
		await this.command("Page.enable", {}, sessionId, signal);
		await this.command("DOM.enable", {}, sessionId, signal);
		await this.command("Accessibility.enable", {}, sessionId, signal);
	}

	private onDebuggerMessage(method: string, params: CdpParams, sessionId?: string): void {
		if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
			this.targetSessions.add(params.sessionId);
			const controller = new AbortController();
			void this.enableSession(params.sessionId, controller.signal).catch(() => {
				this.targetSessions.delete(params.sessionId as string);
			});
			return;
		}
		if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
			this.targetSessions.delete(params.sessionId);
			this.invalidate();
			return;
		}
		if (
			method === "DOM.documentUpdated" ||
			method === "Page.frameDetached" ||
			method === "Inspector.targetCrashed" ||
			(method === "Page.frameNavigated" && !sessionId)
		) {
			this.invalidate();
		}
	}

	private async observeCurrent(input: BrowserObserveInput, signal: AbortSignal): Promise<BrowserObservation> {
		await this.ensureAttached(signal);
		const state = await this.readState(signal);
		if (!this.current) this.current = { revision: 1, state };
		else if (this.current.state !== state) {
			this.previous = this.current;
			this.current = { revision: this.current.revision + 1, state };
		}
		const current = this.current;
		let change: BrowserObservation["change"] = "full";
		let exposedState = current.state;
		if (input.sinceRevision === current.revision) {
			change = "unchanged";
			exposedState = "";
		} else if (this.previous && input.sinceRevision === this.previous.revision) {
			change = "diff";
			exposedState = diffText(this.previous.state, current.state);
		}
		const page = this.dependencies.pageState();
		const screenshot =
			input.mode === "screenshot" || input.mode === "both" ? await this.screenshot(signal) : undefined;
		return {
			browserId: this.dependencies.browserId,
			profileId: this.dependencies.profileId,
			documentId: this.documentId,
			revision: current.revision,
			change,
			url: page.url,
			title: page.title,
			loading: page.loading,
			state: exposedState,
			...(screenshot ? { screenshot } : {}),
		};
	}

	private async readState(signal: AbortSignal): Promise<string> {
		const sessions: Array<string | undefined> = [undefined, ...this.targetSessions];
		const trees = await Promise.all(
			sessions.map(async (sessionId) => ({
				sessionId,
				nodes: axNodes(await this.command("Accessibility.getFullAXTree", {}, sessionId, signal)),
			})),
		);
		const candidates = trees.flatMap(({ sessionId, nodes }) =>
			nodes.map((node, index) => ({ sessionId, node, index, priority: nodePriority(node) })),
		);
		const selected = [...candidates]
			.sort((left, right) => left.priority - right.priority || left.index - right.index)
			.slice(0, MAX_AX_NODES);
		const nodesBySession = new Map(
			trees.map(({ sessionId, nodes }) => [
				sessionId ?? "main",
				new Map(nodes.flatMap((node) => (node.nodeId ? [[node.nodeId, node] as const] : []))),
			]),
		);
		const nextElements = new Map<string, ElementTarget>();
		const lines: string[] = [];
		for (const { sessionId, node } of selected) {
			if (node.ignored || !node.nodeId) continue;
			const byId = nodesBySession.get(sessionId ?? "main")!;
			const role = stringValue(node.role).toLowerCase() || "node";
			const name = stringValue(node.name);
			const focusable = booleanProperty(node, "focusable");
			const actionable = INTERACTIVE_ROLES.has(role) || focusable;
			let elementId = "";
			if (actionable && Number.isSafeInteger(node.backendDOMNodeId)) {
				const key = `${sessionId ?? "main"}:${node.backendDOMNodeId}`;
				elementId = this.elementIds.get(key) ?? `e${this.nextElementId++}`;
				this.elementIds.set(key, elementId);
				nextElements.set(elementId, {
					elementId,
					backendNodeId: node.backendDOMNodeId!,
					...(sessionId ? { sessionId } : {}),
					role,
				});
			}
			let depth = 0;
			let parentId = node.parentId;
			while (parentId && depth < 12) {
				depth += 1;
				parentId = byId.get(parentId)?.parentId;
			}
			const flags = [
				booleanProperty(node, "focused") ? "focused" : "",
				booleanProperty(node, "disabled") ? "disabled" : "",
				EDITABLE_ROLES.has(role) ? (stringValue(node.value) === "" ? "empty" : "non-empty") : "",
			].filter(Boolean);
			lines.push(
				`${"  ".repeat(depth)}${elementId ? `${elementId} ` : ""}${role}${name ? ` ${safeText(name)}` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}`,
			);
		}
		this.elements = nextElements;
		return limitUtf8(lines.join("\n"), MAX_BROWSER_STATE_UTF8_BYTES);
	}

	private async screenshot(signal: AbortSignal): Promise<BrowserObservation["screenshot"] | undefined> {
		for (const quality of SCREENSHOT_QUALITIES) {
			signal.throwIfAborted();
			const data = (await this.dependencies.captureScreenshot(quality)).toString("base64");
			if (Buffer.byteLength(data, "utf8") <= MAX_BROWSER_SCREENSHOT_UTF8_BYTES) {
				return { mediaType: "image/jpeg", data };
			}
		}
		return undefined;
	}

	private referencesMissingElement(action: BrowserAction): boolean {
		const has = (elementId: string) => this.elements.has(elementId);
		switch (action.type) {
			case "click":
			case "hover":
				return "elementId" in action.target && !has(action.target.elementId);
			case "type":
			case "select":
				return !has(action.elementId);
			case "scroll":
				return action.elementId !== undefined && !has(action.elementId);
			case "drag":
				return (
					("elementId" in action.from && !has(action.from.elementId)) ||
					("elementId" in action.to && !has(action.to.elementId))
				);
			default:
				return false;
		}
	}

	private async performAction(action: BrowserAction, signal: AbortSignal): Promise<void> {
		switch (action.type) {
			case "click": {
				const point = await this.resolvePoint(action.target, signal);
				const button = action.button ?? "left";
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseMoved", x: point.x, y: point.y },
					point.sessionId,
					signal,
				);
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mousePressed", x: point.x, y: point.y, button, clickCount: 1 },
					point.sessionId,
					signal,
				);
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseReleased", x: point.x, y: point.y, button, clickCount: 1 },
					point.sessionId,
					signal,
				);
				return;
			}
			case "hover": {
				const point = await this.resolvePoint(action.target, signal);
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseMoved", x: point.x, y: point.y },
					point.sessionId,
					signal,
				);
				return;
			}
			case "type": {
				const element = this.requiredElement(action.elementId);
				await this.command("DOM.focus", { backendNodeId: element.backendNodeId }, element.sessionId, signal);
				if (action.replace) await this.replaceSelection(element.sessionId, signal);
				await this.command("Input.insertText", { text: action.text }, element.sessionId, signal);
				return;
			}
			case "press":
				await this.press(action.key, undefined, signal);
				return;
			case "scroll": {
				const point = action.elementId
					? await this.resolvePoint({ elementId: action.elementId }, signal)
					: { x: 0, y: 0 };
				const magnitude = (action.pages ?? 1) * 800;
				const deltaX = action.direction === "left" ? -magnitude : action.direction === "right" ? magnitude : 0;
				const deltaY = action.direction === "up" ? -magnitude : action.direction === "down" ? magnitude : 0;
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY },
					point.sessionId,
					signal,
				);
				return;
			}
			case "drag": {
				const from = await this.resolvePoint(action.from, signal);
				const to = await this.resolvePoint(action.to, signal);
				const sessionId = from.sessionId ?? to.sessionId;
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 },
					sessionId,
					signal,
				);
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseMoved", x: to.x, y: to.y, button: "left", buttons: 1 },
					sessionId,
					signal,
				);
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 },
					sessionId,
					signal,
				);
				return;
			}
			case "select":
				await this.select(action.elementId, action.value, signal);
				return;
			case "dialog":
				await this.command(
					"Page.handleJavaScriptDialog",
					{ accept: action.decision === "accept" },
					undefined,
					signal,
				);
		}
	}

	private async resolvePoint(
		target: { readonly elementId: string } | { readonly x: number; readonly y: number },
		signal: AbortSignal,
	): Promise<Point> {
		if ("x" in target) return { x: target.x, y: target.y };
		const element = this.requiredElement(target.elementId);
		let quad: readonly number[] | undefined;
		try {
			quad = boxQuad(
				await this.command("DOM.getBoxModel", { backendNodeId: element.backendNodeId }, element.sessionId, signal),
			);
		} catch (cause) {
			if (signal.aborted) throw cause;
			throw new MissingElementError();
		}
		if (!quad) throw new MissingElementError();
		return {
			x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
			y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
			...(element.sessionId ? { sessionId: element.sessionId } : {}),
		};
	}

	private requiredElement(elementId: string): ElementTarget {
		const element = this.elements.get(elementId);
		if (!element) throw new MissingElementError();
		return element;
	}

	private async replaceSelection(sessionId: string | undefined, signal: AbortSignal): Promise<void> {
		const modifiers = this.dependencies.acceleratorModifier ?? (process.platform === "darwin" ? 4 : 2);
		await this.command(
			"Input.dispatchKeyEvent",
			{ type: "rawKeyDown", key: "a", code: "KeyA", modifiers },
			sessionId,
			signal,
		);
		await this.command(
			"Input.dispatchKeyEvent",
			{ type: "keyUp", key: "a", code: "KeyA", modifiers },
			sessionId,
			signal,
		);
		await this.press("Backspace", sessionId, signal);
	}

	private async press(key: string, sessionId: string | undefined, signal: AbortSignal): Promise<void> {
		await this.command("Input.dispatchKeyEvent", { type: "rawKeyDown", key }, sessionId, signal);
		await this.command("Input.dispatchKeyEvent", { type: "keyUp", key }, sessionId, signal);
	}

	private async select(elementId: string, value: string, signal: AbortSignal): Promise<void> {
		const element = this.requiredElement(elementId);
		const described = await this.command(
			"DOM.describeNode",
			{ backendNodeId: element.backendNodeId, depth: 2, pierce: true },
			element.sessionId,
			signal,
		);
		const node =
			typeof described === "object" && described !== null ? (described as { node?: unknown }).node : undefined;
		const children =
			typeof node === "object" && node !== null && Array.isArray((node as { children?: unknown }).children)
				? ((node as { children: Array<{ attributes?: unknown; nodeValue?: unknown }> }).children ?? [])
				: [];
		const index = children.findIndex((child) => {
			const attributes = Array.isArray(child.attributes) ? child.attributes : [];
			for (let offset = 0; offset < attributes.length - 1; offset += 2) {
				if (attributes[offset] === "value" && attributes[offset + 1] === value) return true;
			}
			return child.nodeValue === value;
		});
		if (index < 0) throw new MissingElementError();
		await this.command("DOM.focus", { backendNodeId: element.backendNodeId }, element.sessionId, signal);
		await this.press("Home", element.sessionId, signal);
		for (let offset = 0; offset < index; offset++) await this.press("ArrowDown", element.sessionId, signal);
		await this.press("Enter", element.sessionId, signal);
	}

	private async command(
		method: string,
		params: CdpParams,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<unknown> {
		if (method.startsWith("Runtime.")) throw new Error("Page JavaScript evaluation is forbidden");
		signal.throwIfAborted();
		return this.dependencies.debugger.sendCommand(method, params, sessionId);
	}
}

class MissingElementError extends Error {}
