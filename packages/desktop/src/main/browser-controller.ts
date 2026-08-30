import { randomUUID } from "node:crypto";
import {
	type BrowserActInput,
	type BrowserAction,
	type BrowserObservation,
	type BrowserObserveInput,
	type BrowserOperationDetails,
	browserActionElementIds,
	formatBrowserStateNode,
	MAX_BROWSER_SCREENSHOT_UTF8_BYTES,
	MAX_BROWSER_STATE_UTF8_BYTES,
} from "@metis/app-protocol";

const MAX_AX_NODES = 3_000;
const MAX_ELEMENT_ID = 999_999;
const DEFAULT_STABILIZATION_QUIET_MS = 150;
const DEFAULT_STABILIZATION_TIMEOUT_MS = 2_000;
const SCREENSHOT_QUALITY = 75;
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
const KEY_DETAILS: Readonly<
	Record<string, { readonly code: string; readonly keyCode: number; readonly text?: string }>
> = {
	" ": { code: "Space", keyCode: 32, text: " " },
	ArrowDown: { code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { code: "ArrowRight", keyCode: 39 },
	ArrowUp: { code: "ArrowUp", keyCode: 38 },
	Backspace: { code: "Backspace", keyCode: 8 },
	End: { code: "End", keyCode: 35 },
	Enter: { code: "Enter", keyCode: 13 },
	Escape: { code: "Escape", keyCode: 27 },
	Home: { code: "Home", keyCode: 36 },
	Tab: { code: "Tab", keyCode: 9 },
};

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
	readonly stabilizationQuietMs?: number;
	readonly stabilizationTimeoutMs?: number;
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
	readonly label: string;
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

function propertyValue(node: AxNode, name: string): unknown {
	return node.properties?.find((property) => property.name === name)?.value?.value;
}

function supportedActions(role: string, focusable: boolean): readonly string[] {
	if (["button", "checkbox", "link", "menuitem", "radio", "switch", "tab"].includes(role)) return ["click"];
	if (["combobox", "listbox"].includes(role)) return ["click", "select"];
	if (EDITABLE_ROLES.has(role)) return ["click", "type"];
	return focusable ? ["click"] : [];
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

function contentQuad(value: unknown): readonly number[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const quads = (value as { quads?: unknown }).quads;
	if (!Array.isArray(quads)) return undefined;
	return quads.find(
		(quad): quad is number[] =>
			Array.isArray(quad) && quad.length >= 8 && quad.every((point) => typeof point === "number"),
	);
}

function viewportSize(value: unknown): { readonly width: number; readonly height: number } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const metrics = value as {
		readonly cssVisualViewport?: unknown;
		readonly visualViewport?: unknown;
		readonly cssLayoutViewport?: unknown;
		readonly layoutViewport?: unknown;
	};
	for (const candidate of [
		metrics.cssVisualViewport,
		metrics.visualViewport,
		metrics.cssLayoutViewport,
		metrics.layoutViewport,
	]) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const { clientWidth, clientHeight } = candidate as {
			readonly clientWidth?: unknown;
			readonly clientHeight?: unknown;
		};
		if (typeof clientWidth === "number" && clientWidth > 0 && typeof clientHeight === "number" && clientHeight > 0) {
			return { width: clientWidth, height: clientHeight };
		}
	}
	return undefined;
}

function describedNodeText(value: unknown): string {
	if (typeof value !== "object" || value === null) return "";
	const node = value as { readonly nodeValue?: unknown; readonly children?: unknown };
	const own = typeof node.nodeValue === "string" ? node.nodeValue : "";
	const children = Array.isArray(node.children) ? node.children.map(describedNodeText).join("") : "";
	return `${own}${children}`;
}

/** CDP-only browser observation and input controller. It never evaluates page JavaScript. */
export class BrowserController {
	private readonly dependencies: BrowserControllerDependencies;
	private readonly targetSessions = new Set<string>();
	private readonly loaderIds = new Map<string, string>();
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
	private lastStateChangeAt = 0;
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
			this.loaderIds.clear();
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
		this.markStateChange();
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
		this.loaderIds.clear();
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
		await this.command("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId, signal);
	}

	private onDebuggerMessage(method: string, params: CdpParams, sessionId?: string): void {
		if (/^(?:Accessibility|DOM|Page|Target)\./u.test(method)) this.markStateChange();
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
			for (const key of this.loaderIds.keys()) {
				if (key.startsWith(`${params.sessionId}:`)) this.loaderIds.delete(key);
			}
			this.invalidate();
			return;
		}
		if (
			method === "Page.lifecycleEvent" &&
			typeof params.frameId === "string" &&
			typeof params.loaderId === "string"
		) {
			const key = `${sessionId ?? "main"}:${params.frameId}`;
			const previous = this.loaderIds.get(key);
			this.loaderIds.set(key, params.loaderId);
			if (previous && previous !== params.loaderId) this.invalidate();
			return;
		}
		if (method === "Page.frameNavigated") {
			const frame =
				typeof params.frame === "object" && params.frame !== null ? (params.frame as CdpParams) : undefined;
			if (typeof frame?.id === "string" && typeof frame.loaderId === "string") {
				this.loaderIds.set(`${sessionId ?? "main"}:${frame.id}`, frame.loaderId);
			}
			this.invalidate();
			return;
		}
		if (method === "DOM.documentUpdated" || method === "Page.frameDetached" || method === "Inspector.targetCrashed") {
			if (method === "Page.frameDetached") this.loaderIds.clear();
			this.invalidate();
		}
	}

	private async observeCurrent(input: BrowserObserveInput, signal: AbortSignal): Promise<BrowserObservation> {
		await this.ensureAttached(signal);
		await this.waitForStableState(signal);
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
		if (this.nextElementId + selected.length > MAX_ELEMENT_ID) {
			this.elementIds.clear();
			this.nextElementId = 1;
		}
		const nodesBySession = new Map(
			trees.map(({ sessionId, nodes }) => [
				sessionId ?? "main",
				new Map(nodes.flatMap((node) => (node.nodeId ? [[node.nodeId, node] as const] : []))),
			]),
		);
		const nextElements = new Map<string, ElementTarget>();
		const activeElementKeys = new Set<string>();
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
				activeElementKeys.add(key);
				elementId = this.elementIds.get(key) ?? `e${this.nextElementId++}`;
				this.elementIds.set(key, elementId);
				nextElements.set(elementId, {
					elementId,
					backendNodeId: node.backendDOMNodeId!,
					...(sessionId ? { sessionId } : {}),
					role,
					label: name,
				});
			}
			let depth = 0;
			let parentId = node.parentId;
			while (parentId && depth < 12) {
				depth += 1;
				parentId = byId.get(parentId)?.parentId;
			}
			const checked = propertyValue(node, "checked");
			const selected = propertyValue(node, "selected");
			const actions = supportedActions(role, focusable);
			const flags = [
				booleanProperty(node, "focused") ? "focused" : "",
				actionable ? (booleanProperty(node, "disabled") ? "disabled" : "enabled") : "",
				typeof checked === "boolean" || checked === "mixed" ? `checked=${String(checked)}` : "",
				typeof selected === "boolean" ? `selected=${String(selected)}` : "",
				EDITABLE_ROLES.has(role) ? (stringValue(node.value) === "" ? "empty" : "non-empty") : "",
				actions.length > 0 ? `actions=${actions.join("|")}` : "",
			].filter(Boolean);
			lines.push(formatBrowserStateNode({ depth, ...(elementId ? { elementId } : {}), role, label: name, flags }));
		}
		for (const key of this.elementIds.keys()) {
			if (!activeElementKeys.has(key)) this.elementIds.delete(key);
		}
		this.elements = nextElements;
		return limitUtf8(lines.join("\n"), MAX_BROWSER_STATE_UTF8_BYTES);
	}

	private async screenshot(signal: AbortSignal): Promise<BrowserObservation["screenshot"] | undefined> {
		signal.throwIfAborted();
		const data = (await this.dependencies.captureScreenshot(SCREENSHOT_QUALITY)).toString("base64");
		if (Buffer.byteLength(data, "utf8") > MAX_BROWSER_SCREENSHOT_UTF8_BYTES) {
			throw new RangeError("Browser screenshot exceeds the 4 MiB limit");
		}
		return { mediaType: "image/jpeg", data };
	}

	private referencesMissingElement(action: BrowserAction): boolean {
		return browserActionElementIds(action).some((elementId) => !this.elements.has(elementId));
	}

	private async performAction(action: BrowserAction, signal: AbortSignal): Promise<void> {
		this.markStateChange();
		switch (action.type) {
			case "click": {
				const point = await this.resolvePoint(action.target, signal);
				const button = action.button ?? "left";
				const buttons = button === "left" ? 1 : 2;
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseMoved", x: point.x, y: point.y },
					point.sessionId,
					signal,
				);
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mousePressed", x: point.x, y: point.y, button, buttons, clickCount: 1 },
					point.sessionId,
					signal,
				);
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount: 1 },
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
					{ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 },
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
					{ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 },
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

	private markStateChange(): void {
		this.lastStateChangeAt = Date.now();
	}

	private async waitForStableState(signal: AbortSignal): Promise<void> {
		const quietMs = this.dependencies.stabilizationQuietMs ?? DEFAULT_STABILIZATION_QUIET_MS;
		const timeoutMs = this.dependencies.stabilizationTimeoutMs ?? DEFAULT_STABILIZATION_TIMEOUT_MS;
		if (quietMs <= 0 || this.lastStateChangeAt === 0) return;
		const deadline = Date.now() + timeoutMs;
		while (true) {
			signal.throwIfAborted();
			const now = Date.now();
			const quietRemaining = quietMs - (now - this.lastStateChangeAt);
			const timeoutRemaining = deadline - now;
			if (quietRemaining <= 0 || timeoutRemaining <= 0) return;
			await this.delay(Math.min(quietRemaining, timeoutRemaining), signal);
		}
	}

	private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, milliseconds);
			timer.unref?.();
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	}

	private async resolvePoint(
		target: { readonly elementId: string } | { readonly x: number; readonly y: number },
		signal: AbortSignal,
	): Promise<Point> {
		if ("x" in target) {
			const viewport = viewportSize(await this.command("Page.getLayoutMetrics", {}, undefined, signal));
			if (!viewport || target.x < 0 || target.y < 0 || target.x >= viewport.width || target.y >= viewport.height) {
				throw new RangeError("Browser coordinates must stay within the current viewport");
			}
			return { x: target.x, y: target.y };
		}
		const element = this.requiredElement(target.elementId);
		let quad: readonly number[] | undefined;
		try {
			await this.command(
				"DOM.scrollIntoViewIfNeeded",
				{ backendNodeId: element.backendNodeId },
				element.sessionId,
				signal,
			);
			quad = contentQuad(
				await this.command(
					"DOM.getContentQuads",
					{ backendNodeId: element.backendNodeId },
					element.sessionId,
					signal,
				),
			);
			quad ??= boxQuad(
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
		const detail = KEY_DETAILS[key];
		const identity = detail
			? { key, code: detail.code, windowsVirtualKeyCode: detail.keyCode, nativeVirtualKeyCode: detail.keyCode }
			: { key };
		await this.command(
			"Input.dispatchKeyEvent",
			{
				type: detail?.text ? "keyDown" : "rawKeyDown",
				...identity,
				...(detail?.text ? { text: detail.text, unmodifiedText: detail.text } : {}),
			},
			sessionId,
			signal,
		);
		await this.command("Input.dispatchKeyEvent", { type: "keyUp", ...identity }, sessionId, signal);
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
				? ((node as { children: Array<{ attributes?: unknown; nodeValue?: unknown; children?: unknown }> })
						.children ?? [])
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
		const label = (describedNodeText(children[index]).trim() || value).toLocaleLowerCase();
		for (const character of label) {
			const upper = character.toLocaleUpperCase();
			const asciiLetter = /^[A-Z]$/u.test(upper);
			const identity = asciiLetter
				? { key: character, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) }
				: { key: character };
			await this.command(
				"Input.dispatchKeyEvent",
				{ type: "keyDown", ...identity, text: character, unmodifiedText: character },
				element.sessionId,
				signal,
			);
			await this.command("Input.dispatchKeyEvent", { type: "keyUp", ...identity }, element.sessionId, signal);
		}
	}

	private async command(
		method: string,
		params: CdpParams,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<unknown> {
		if (method.startsWith("Runtime.")) throw new Error("Page JavaScript evaluation is forbidden");
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (complete: () => void) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				complete();
			};
			const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
			signal.addEventListener("abort", onAbort, { once: true });
			void this.dependencies.debugger.sendCommand(method, params, sessionId).then(
				(result) => finish(() => resolve(result)),
				(cause) => finish(() => reject(cause)),
			);
			if (signal.aborted) onAbort();
		});
	}
}

class MissingElementError extends Error {}
