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
import { parseBrowserKey } from "./browser-keyboard.ts";
import {
	type NativeSelect,
	NativeSelectionError,
	nativeSelectMetadata,
	SELECT_NATIVE_OPTION,
} from "./browser-native-select.ts";
import { observationNeedsPaging, pageBrowserObservation } from "./browser-observation.ts";

const MAX_AX_NODES = 3_000;
const MAX_ELEMENT_ID = 999_999;
const DEFAULT_STABILIZATION_QUIET_MS = 150;
const DEFAULT_STABILIZATION_TIMEOUT_MS = 2_000;
const INPUT_RELEASE_TIMEOUT_MS = 500;
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
	readonly frameId?: string;
	readonly role: string;
	readonly label: string;
	readonly disabled: boolean;
	readonly signature: string;
	readonly nativeSelect?: NativeSelect;
}

interface Snapshot {
	readonly revision: number;
	readonly state: string;
	readonly elements: ReadonlyMap<string, ElementTarget>;
}

interface Point {
	readonly x: number;
	readonly y: number;
	readonly sessionId?: string;
}

interface PendingDialog {
	readonly id: number;
	readonly type: string;
	readonly message: string;
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

function isEditableNode(node: AxNode): boolean {
	const editable = propertyValue(node, "editable");
	return (
		editable === "plaintext" ||
		editable === "richtext" ||
		["textbox", "searchbox", "spinbutton"].includes(stringValue(node.role).toLowerCase())
	);
}

function hasEditableAncestor(node: AxNode, byId: ReadonlyMap<string, AxNode>): boolean {
	const visited = new Set<string>();
	let parentId = node.parentId;
	while (parentId && !visited.has(parentId)) {
		visited.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) return false;
		if (isEditableNode(parent)) return true;
		parentId = parent.parentId;
	}
	return false;
}

function targetSignature(node: AxNode, byId: ReadonlyMap<string, AxNode>): string {
	const context: unknown[] = [];
	let current: AxNode | undefined = node;
	for (let depth = 0; current && depth < 13; depth++) {
		context.push([
			current.nodeId,
			current.backendDOMNodeId,
			stringValue(current.role),
			stringValue(current.name),
			...(["disabled", "checked", "selected", "expanded", "pressed", "readonly", "required", "url"] as const).map(
				(name) => propertyValue(current!, name),
			),
		]);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return JSON.stringify(context);
}

function sameTarget(left: ElementTarget | undefined, right: ElementTarget | undefined): boolean {
	return Boolean(
		left &&
			right &&
			left.backendNodeId === right.backendNodeId &&
			left.sessionId === right.sessionId &&
			left.frameId === right.frameId &&
			left.signature === right.signature,
	);
}

function sameTargets(left: ReadonlyMap<string, ElementTarget>, right: ReadonlyMap<string, ElementTarget>): boolean {
	return left.size === right.size && [...left].every(([id, target]) => sameTarget(target, right.get(id)));
}

function frameIds(response: unknown, skipRoots: ReadonlySet<string> = new Set()): string[] {
	const result: string[] = [];
	const visit = (tree: unknown) => {
		if (!tree || typeof tree !== "object") return;
		const { frame, childFrames } = tree as { frame?: { id?: string }; childFrames?: unknown[] };
		if (frame?.id && skipRoots.has(frame.id)) return;
		if (typeof frame?.id === "string") result.push(frame.id);
		if (Array.isArray(childFrames)) childFrames.forEach(visit);
	};
	visit((response as { frameTree?: unknown } | null)?.frameTree);
	return result;
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

function containsBackendNode(value: unknown, backendNodeId: number): boolean {
	if (typeof value !== "object" || value === null) return false;
	const node = value as CdpParams;
	if (node.backendNodeId === backendNodeId) return true;
	return [node.children, node.shadowRoots, node.pseudoElements, node.distributedNodes].some(
		(children) => Array.isArray(children) && children.some((child) => containsBackendNode(child, backendNodeId)),
	);
}

/** CDP browser controller. Runtime calls are limited to the fixed isolated native-select routine. */
export class BrowserController {
	private readonly nativeSelectObjects = new Set<string>();
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
	private debuggerAbort = new AbortController();
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private lastStateChangeAt = 0;
	private stateChangeSequence = 0;
	private pendingDialog?: PendingDialog;
	private dialogSequence = 0;
	private dialogOpened = new AbortController();
	private readonly unsubscribeMessage: () => void;
	private readonly unsubscribeDetach: () => void;

	constructor(dependencies: BrowserControllerDependencies) {
		this.dependencies = dependencies;
		this.unsubscribeMessage = dependencies.subscribeMessage((method, params, sessionId) => {
			this.onDebuggerMessage(method, params, sessionId);
		});
		this.unsubscribeDetach = dependencies.subscribeDetach(() => {
			this.clearDialog();
			this.debuggerAbort.abort(new Error("Browser debugger detached"));
			this.debuggerAbort = new AbortController();
			this.attachedByController = false;
			this.attachPromise = undefined;
			this.loaderIds.clear();
			this.invalidate();
		});
	}

	observe(input: BrowserObserveInput, signal: AbortSignal): Promise<BrowserObservation> {
		return this.exclusive(signal, () => this.observeCurrent(input, signal));
	}

	leaseSignal(): AbortSignal {
		return this.debuggerAbort.signal;
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
			// Only ordinary element clicks can tolerate unrelated page changes. Keep
			// the exact observed target, including its semantic ancestors and link URL.
			const snapshot = [this.current, this.previous].find((entry) => entry?.revision === input.snapshotRevision);
			const expectedTarget =
				input.risk === "ordinary" && input.action.type === "click" && "elementId" in input.action.target
					? snapshot?.elements.get(input.action.target.elementId)
					: undefined;
			const fresh = await this.observeCurrent(
				{ browserId: input.browserId, sinceRevision: input.snapshotRevision },
				signal,
			);
			if (fresh.documentId !== input.documentId)
				return { status: "stale", reason: "document_changed", observation: fresh };
			if (fresh.revision !== input.snapshotRevision && !expectedTarget)
				return { status: "stale", reason: "revision_changed", observation: fresh };
			if (this.referencesMissingElement(input.action))
				return { status: "stale", reason: "element_missing", observation: fresh };
			try {
				await this.performAction(input, signal, expectedTarget);
				this.markStateChange();
			} catch (cause) {
				signal.throwIfAborted();
				if (cause instanceof NativeSelectionError) {
					this.markStateChange();
					return cause.details;
				}
				if (cause instanceof StaleActionError) return stale(cause.reason);
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
				// An input can synchronously open a modal and suspend its CDP reply.
				// Return the pending dialog instead of waiting for the renderer or retrying input.
				if (!(cause instanceof DialogOpenedError)) throw cause;
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
		this.clearDialog();
		this.debuggerAbort.abort(new Error("Browser controller is closed"));
		this.unsubscribeMessage();
		this.unsubscribeDetach();
		this.targetSessions.clear();
		this.loaderIds.clear();
		this.invalidate();
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
		if (this.pendingDialog && this.dependencies.debugger.isAttached()) return;
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
			if (cause instanceof DialogOpenedError && this.pendingDialog) return;
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
		sessionId ||= undefined;
		if (/^(?:Accessibility|DOM|Page|Target)\./u.test(method)) this.markStateChange();
		if (method === "Page.javascriptDialogOpening") {
			this.pendingDialog = {
				id: ++this.dialogSequence,
				type: typeof params.type === "string" ? limitUtf8(params.type, 64) : "dialog",
				message: typeof params.message === "string" ? limitUtf8(params.message, 8_192) : "",
				...(sessionId ? { sessionId } : {}),
			};
			this.dialogOpened.abort(new DialogOpenedError());
			return;
		}
		if (method === "Page.javascriptDialogClosed") {
			if (this.pendingDialog && this.pendingDialog.sessionId === sessionId) {
				this.clearDialog();
				this.invalidate();
			}
			return;
		}
		if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
			this.targetSessions.add(params.sessionId);
			const controller = new AbortController();
			void this.enableSession(params.sessionId, controller.signal).catch(() => {
				this.targetSessions.delete(params.sessionId as string);
			});
			return;
		}
		if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
			if (this.pendingDialog?.sessionId === params.sessionId) this.clearDialog();
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
			if (this.pendingDialog && this.pendingDialog.sessionId === sessionId && !frame?.parentId) this.clearDialog();
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
		const state = await this.readObservableState(signal);
		if (!this.current) this.current = { revision: 1, state, elements: this.elements };
		else if (this.current.state !== state || !sameTargets(this.current.elements, this.elements)) {
			this.previous = this.current;
			this.current = { revision: this.current.revision + 1, state, elements: this.elements };
		}
		const current = this.current;
		let change: BrowserObservation["change"] = "full";
		let exposedState = current.state;
		if (!input.cursor && input.sinceRevision === current.revision) {
			change = "unchanged";
			exposedState = "";
		} else if (!input.cursor && this.previous && input.sinceRevision === this.previous.revision) {
			change = "diff";
			exposedState = diffText(this.previous.state, current.state);
		}
		const page = this.dependencies.pageState();
		let screenshot: BrowserObservation["screenshot"];
		try {
			if (!this.pendingDialog && (input.mode === "screenshot" || input.mode === "both")) {
				screenshot = await this.screenshot(signal);
			}
		} catch (cause) {
			signal.throwIfAborted();
			if (!(cause instanceof DialogOpenedError) || !this.pendingDialog) throw cause;
			return this.observeCurrent({ ...input, mode: "state" }, signal);
		}
		let observation: BrowserObservation = {
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
		// Continuations always refer to a full snapshot, never a disappearing diff.
		if (observation.change === "diff" && observationNeedsPaging(observation)) {
			observation = { ...observation, change: "full", state: current.state };
		}
		return pageBrowserObservation(observation, input.cursor);
	}

	private clearDialog(): void {
		this.pendingDialog = undefined;
		this.dialogOpened = new AbortController();
	}

	private async readObservableState(signal: AbortSignal): Promise<string> {
		signal.throwIfAborted();
		for (let attempt = 0; !this.pendingDialog; attempt++) {
			const documentId = this.documentId;
			try {
				return await this.readState(signal);
			} catch (cause) {
				signal.throwIfAborted();
				if (documentId !== this.documentId && attempt < 2) continue;
				if (!(cause instanceof DialogOpenedError) || !this.pendingDialog) throw cause;
			}
		}
		const dialog = this.pendingDialog;
		// Do not read AX, screenshot the blocked renderer, or expose prompt default values.
		this.elements.clear();
		return formatBrowserStateNode({
			depth: 0,
			role: "dialog",
			label: dialog.message,
			flags: [`type=${dialog.type}`, `dialogId=${dialog.id}`, "actions=dialog"],
		});
	}

	private async readState(signal: AbortSignal): Promise<string> {
		const documentId = this.documentId;
		const sessions: Array<string | undefined> = [undefined, ...this.targetSessions];
		const frameTrees = await Promise.all(
			sessions.map(async (sessionId) => {
				const response = await this.command("Page.getFrameTree", {}, sessionId, signal);
				return { sessionId, response, frames: frameIds(response) };
			}),
		);
		// A remote frame may appear in its parent's Page tree as well as in its
		// own target. Read it only through the session that owns its root.
		const owners = new Map(
			frameTrees.flatMap(({ sessionId, frames }) => (frames[0] ? [[frames[0], sessionId] as const] : [])),
		);
		const trees = await Promise.all(
			frameTrees.flatMap(({ sessionId, response, frames }) =>
				(frames.length
					? frameIds(response, new Set([...owners].filter(([, owner]) => owner !== sessionId).map(([id]) => id)))
					: [undefined]
				).map(async (frameId) => ({
					sessionId,
					frameId,
					nodes: axNodes(
						await this.command("Accessibility.getFullAXTree", frameId ? { frameId } : {}, sessionId, signal),
					),
				})),
			),
		);
		const candidates = trees.flatMap(({ sessionId, frameId, nodes }) => {
			const byId = new Map(nodes.flatMap((node) => (node.nodeId ? [[node.nodeId, node] as const] : [])));
			// Chromium repeats editable values in StaticText/InlineTextBox descendants,
			// including through ignored nodes. Filter before limiting, caching or diffing.
			return nodes.flatMap((node, index) =>
				hasEditableAncestor(node, byId)
					? []
					: [{ sessionId, frameId, byId, node, index, priority: nodePriority(node) }],
			);
		});
		const selected = [...candidates]
			.sort((left, right) => left.priority - right.priority || left.index - right.index)
			.slice(0, MAX_AX_NODES);
		const nativeSelects = new Map<AxNode, NativeSelect>();
		for (const { node, sessionId } of selected) {
			if (
				!["combobox", "listbox"].includes(stringValue(node.role).toLowerCase()) ||
				!Number.isSafeInteger(node.backendDOMNodeId)
			)
				continue;
			const metadata = nativeSelectMetadata(
				await this.command(
					"DOM.describeNode",
					{ backendNodeId: node.backendDOMNodeId, depth: -1 },
					sessionId,
					signal,
				),
			);
			if (metadata) nativeSelects.set(node, metadata);
		}
		// Navigation can occur while frame/AX/DOM replies are outstanding. Never
		// publish those old nodes under the new document's identity.
		if (documentId !== this.documentId) throw new StaleActionError("document_changed");
		if (this.nextElementId + selected.length > MAX_ELEMENT_ID) {
			this.elementIds.clear();
			this.nextElementId = 1;
		}
		const nextElements = new Map<string, ElementTarget>();
		const activeElementKeys = new Set<string>();
		const lines: string[] = [];
		for (const { sessionId, frameId, byId, node } of selected) {
			if (node.ignored || !node.nodeId) continue;
			const role = stringValue(node.role).toLowerCase() || "node";
			const name = stringValue(node.name);
			const focusable = booleanProperty(node, "focusable");
			const actionable = INTERACTIVE_ROLES.has(role) || focusable;
			const nativeSelect = nativeSelects.get(node);
			let elementId = "";
			if (actionable && Number.isSafeInteger(node.backendDOMNodeId)) {
				const key = `${sessionId ?? "main"}:${frameId ?? "root"}:${node.backendDOMNodeId}`;
				activeElementKeys.add(key);
				elementId = this.elementIds.get(key) ?? `e${this.nextElementId++}`;
				this.elementIds.set(key, elementId);
				nextElements.set(elementId, {
					elementId,
					backendNodeId: node.backendDOMNodeId!,
					...(sessionId ? { sessionId } : {}),
					...(frameId ? { frameId } : {}),
					role,
					label: name,
					disabled: booleanProperty(node, "disabled"),
					signature: JSON.stringify([targetSignature(node, byId), nativeSelect]),
					...(nativeSelect ? { nativeSelect } : {}),
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
			const actions = supportedActions(role, focusable).filter(
				(action) => action !== "select" || (nativeSelect && !nativeSelect.multiple),
			);
			const flags = [
				booleanProperty(node, "focused") ? "focused" : "",
				actionable ? (booleanProperty(node, "disabled") ? "disabled" : "enabled") : "",
				typeof checked === "boolean" || checked === "true" || checked === "false" || checked === "mixed"
					? `checked=${String(checked)}`
					: "",
				typeof selected === "boolean" ? `selected=${String(selected)}` : "",
				EDITABLE_ROLES.has(role) || isEditableNode(node)
					? stringValue(node.value) === ""
						? "empty"
						: "non-empty"
					: "",
				actions.length > 0 ? `actions=${actions.join("|")}` : "",
				nativeSelect
					? `options=${JSON.stringify(nativeSelect.options.map(({ value: _value, ...option }) => option))}`
					: "",
				nativeSelect?.truncated ? "options-truncated" : "",
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
		const pending = AbortSignal.any([signal, this.debuggerAbort.signal, this.dialogOpened.signal]);
		pending.throwIfAborted();
		let onAbort!: () => void;
		const interrupted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(pending.reason);
			pending.addEventListener("abort", onAbort, { once: true });
		});
		let buffer: Buffer;
		try {
			buffer = await Promise.race([this.dependencies.captureScreenshot(SCREENSHOT_QUALITY), interrupted]);
			pending.throwIfAborted();
		} finally {
			pending.removeEventListener("abort", onAbort);
		}
		const data = buffer.toString("base64");
		if (Buffer.byteLength(data, "utf8") > MAX_BROWSER_SCREENSHOT_UTF8_BYTES) {
			throw new RangeError("Browser screenshot exceeds the 4 MiB limit");
		}
		return { mediaType: "image/jpeg", data };
	}

	private referencesMissingElement(action: BrowserAction): boolean {
		return browserActionElementIds(action).some((elementId) => !this.elements.has(elementId));
	}

	private async performAction(
		input: BrowserActInput,
		signal: AbortSignal,
		expectedTarget?: ElementTarget,
	): Promise<void> {
		const { action } = input;
		const verifiedSequence = await this.validateAction(input, signal, expectedTarget);
		if (this.pendingDialog && action.type !== "dialog") throw new StaleActionError("revision_changed");
		const leaseSignal = this.debuggerAbort.signal;
		switch (action.type) {
			case "click": {
				const point = await this.resolvePoint(action.target, signal);
				const button = action.button ?? "left";
				const buttons = button === "left" ? 1 : 2;
				this.assertAction(input, verifiedSequence, expectedTarget);
				await this.command(
					"Input.dispatchMouseEvent",
					{ type: "mouseMoved", x: point.x, y: point.y },
					point.sessionId,
					signal,
				);
				if (expectedTarget) await this.validateAction(input, signal, expectedTarget);
				if ("elementId" in action.target) await this.assertHitTarget(action.target.elementId, point, signal);
				this.assertActionIdentity(input);
				await this.pressAndRelease(
					"Input.dispatchMouseEvent",
					{ type: "mousePressed", x: point.x, y: point.y, button, buttons, clickCount: 1 },
					{ type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount: 1 },
					point.sessionId,
					signal,
					leaseSignal,
				);
				return;
			}
			case "hover": {
				const point = await this.resolvePoint(action.target, signal);
				this.assertAction(input, verifiedSequence);
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
				this.assertAction(input, verifiedSequence);
				await this.command("DOM.focus", { backendNodeId: element.backendNodeId }, element.sessionId, signal);
				this.assertActionIdentity(input);
				if (action.replace) await this.replaceSelection(element.sessionId, input, signal, leaseSignal);
				this.assertActionIdentity(input);
				await this.command("Input.insertText", { text: action.text }, element.sessionId, signal);
				return;
			}
			case "press":
				this.assertAction(input, verifiedSequence);
				await this.press(action.key, undefined, signal, leaseSignal);
				return;
			case "scroll": {
				const point = action.elementId
					? await this.resolvePoint({ elementId: action.elementId }, signal)
					: { x: 0, y: 0 };
				const magnitude = (action.pages ?? 1) * 800;
				const deltaX = action.direction === "left" ? -magnitude : action.direction === "right" ? magnitude : 0;
				const deltaY = action.direction === "up" ? -magnitude : action.direction === "down" ? magnitude : 0;
				this.assertAction(input, verifiedSequence);
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
				this.assertAction(input, verifiedSequence);
				await this.pressAndRelease(
					"Input.dispatchMouseEvent",
					{ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 },
					{ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 },
					sessionId,
					signal,
					leaseSignal,
					() => {
						this.assertActionIdentity(input);
						return this.command(
							"Input.dispatchMouseEvent",
							{ type: "mouseMoved", x: to.x, y: to.y, button: "left", buttons: 1 },
							sessionId,
							signal,
							leaseSignal,
						);
					},
				);
				return;
			}
			case "select":
				await this.select(action.elementId, action, input, verifiedSequence, signal, leaseSignal);
				return;
			case "dialog": {
				this.assertAction(input, verifiedSequence);
				const dialog = this.pendingDialog;
				if (!dialog) throw new Error("No JavaScript dialog is open");
				await this.command(
					"Page.handleJavaScriptDialog",
					{ accept: action.decision === "accept" },
					dialog.sessionId,
					signal,
				);
				if (this.pendingDialog === dialog) {
					this.clearDialog();
					this.invalidate();
				}
			}
		}
	}

	private markStateChange(): void {
		this.lastStateChangeAt = Date.now();
		this.stateChangeSequence += 1;
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
			if (cause instanceof StaleActionError) throw cause;
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

	private async assertHitTarget(elementId: string, point: Point, signal: AbortSignal): Promise<void> {
		const element = this.requiredElement(elementId);
		if (element.disabled) throw new StaleActionError("element_not_interactable");
		const metrics = (await this.command("Page.getLayoutMetrics", {}, point.sessionId, signal)) as {
			cssLayoutViewport?: { pageX?: number; pageY?: number };
			layoutViewport?: { pageX?: number; pageY?: number };
		};
		const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
		// Input uses viewport CSS pixels, but DOM hit-testing uses page coordinates.
		const hit = (await this.command(
			"DOM.getNodeForLocation",
			{
				x: Math.round(point.x + (viewport?.pageX ?? 0)),
				y: Math.round(point.y + (viewport?.pageY ?? 0)),
				includeUserAgentShadowDOM: true,
			},
			point.sessionId,
			signal,
		)) as { backendNodeId?: number };
		if (hit.backendNodeId === element.backendNodeId) return;
		if (Number.isSafeInteger(hit.backendNodeId)) {
			// A button's span, SVG or shadow content is a valid hit; a covering sibling is not.
			const described = (await this.command(
				"DOM.describeNode",
				{ backendNodeId: element.backendNodeId, depth: -1, pierce: true },
				element.sessionId,
				signal,
			)) as { node?: unknown };
			if (containsBackendNode(described.node, hit.backendNodeId!)) return;
		}
		throw new StaleActionError("element_not_interactable");
	}

	private async replaceSelection(
		sessionId: string | undefined,
		input: BrowserActInput,
		signal: AbortSignal,
		leaseSignal: AbortSignal,
	): Promise<void> {
		await this.pressAndRelease(
			"Input.dispatchKeyEvent",
			{ type: "rawKeyDown", commands: ["selectAll"] },
			{ type: "keyUp", commands: ["selectAll"] },
			sessionId,
			signal,
			leaseSignal,
		);
		this.assertActionIdentity(input);
		await this.press("Backspace", sessionId, signal, leaseSignal);
	}

	private async press(
		key: string,
		sessionId: string | undefined,
		signal: AbortSignal,
		leaseSignal: AbortSignal,
	): Promise<void> {
		const { down, up } = parseBrowserKey(
			key,
			this.dependencies.acceleratorModifier ?? (process.platform === "darwin" ? 4 : 2),
		);
		await this.pressAndRelease("Input.dispatchKeyEvent", down, up, sessionId, signal, leaseSignal);
	}

	private async select(
		elementId: string,
		selection: Extract<BrowserAction, { type: "select" }>,
		input: BrowserActInput,
		verifiedSequence: number,
		signal: AbortSignal,
		leaseSignal: AbortSignal,
	): Promise<void> {
		const element = this.requiredElement(elementId);
		const option = "optionIndex" in selection ? element.nativeSelect?.options[selection.optionIndex] : undefined;
		if ("optionIndex" in selection && !option) throw new NativeSelectionError("option_not_found");
		const choice =
			"value" in selection ? selection.value : { index: option!.index, value: option!.value, label: option!.label };
		if (element.disabled) throw new StaleActionError("element_not_interactable");
		if (!element.frameId) throw new NativeSelectionError("select_unavailable");
		const world = (await this.command(
			"Page.createIsolatedWorld",
			{
				frameId: element.frameId,
				worldName: "metis-browser-select",
			},
			element.sessionId,
			signal,
		)) as { executionContextId?: number };
		if (!Number.isSafeInteger(world.executionContextId)) throw new NativeSelectionError("select_unavailable");
		const resolved = (await this.command(
			"DOM.resolveNode",
			{
				backendNodeId: element.backendNodeId,
				executionContextId: world.executionContextId,
			},
			element.sessionId,
			signal,
		)) as { object?: { objectId?: string } };
		const objectId = resolved.object?.objectId;
		if (!objectId) throw new MissingElementError();
		const objectKey = `${element.sessionId ?? "main"}:${objectId}`;
		this.nativeSelectObjects.add(objectKey);
		try {
			this.assertAction(input, verifiedSequence);
			const result = (await this.command(
				"Runtime.callFunctionOn",
				{
					objectId,
					functionDeclaration: SELECT_NATIVE_OPTION,
					arguments: [{ value: choice }],
					returnByValue: true,
					userGesture: true,
				},
				element.sessionId,
				signal,
			)) as { result?: { value?: { selected?: boolean; failure?: unknown } }; exceptionDetails?: unknown };
			if (result.exceptionDetails) throw new NativeSelectionError("selection_unconfirmed");
			if (result.result?.value?.selected !== true) throw new NativeSelectionError(result.result?.value?.failure);
		} finally {
			// Navigation/dialogs may destroy or suspend the context. Cleanup is bounded
			// and must not replace the original operation's result or cancellation.
			await this.command(
				"Runtime.releaseObject",
				{ objectId },
				element.sessionId,
				AbortSignal.timeout(INPUT_RELEASE_TIMEOUT_MS),
				leaseSignal,
			).catch(() => undefined);
			this.nativeSelectObjects.delete(objectKey);
		}
	}

	private async pressAndRelease(
		method: "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent",
		down: CdpParams,
		release: CdpParams,
		sessionId: string | undefined,
		signal: AbortSignal,
		leaseSignal: AbortSignal,
		between?: () => Promise<unknown>,
	): Promise<void> {
		signal.throwIfAborted();
		let operationFailure: unknown;
		try {
			await this.command(method, down, sessionId, signal, leaseSignal);
			if (this.pendingDialog) throw new DialogOpenedError();
			await between?.();
			signal.throwIfAborted();
		} catch (cause) {
			operationFailure = cause;
		}
		let releaseFailure: unknown;
		try {
			await this.releaseCommand(method, release, sessionId, leaseSignal);
		} catch (cause) {
			releaseFailure = cause;
		}
		signal.throwIfAborted();
		if (operationFailure) throw operationFailure;
		if (releaseFailure) throw releaseFailure;
	}

	private async releaseCommand(
		method: "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent",
		params: CdpParams,
		sessionId: string | undefined,
		leaseSignal: AbortSignal,
	): Promise<void> {
		const releaseAbort = new AbortController();
		const timer = setTimeout(
			() => releaseAbort.abort(new Error("Browser input release timed out")),
			INPUT_RELEASE_TIMEOUT_MS,
		);
		timer.unref?.();
		try {
			await this.command(method, params, sessionId, releaseAbort.signal, leaseSignal);
		} finally {
			clearTimeout(timer);
		}
	}

	private async validateAction(
		input: BrowserActInput,
		signal: AbortSignal,
		expectedTarget?: ElementTarget,
	): Promise<number> {
		this.assertActionIdentity(input);
		if (!expectedTarget && this.current?.revision !== input.snapshotRevision)
			throw new StaleActionError("revision_changed");
		const sequence = this.stateChangeSequence;
		const state = await this.readObservableState(signal);
		this.assertActionIdentity(input);
		if (expectedTarget) this.assertTarget(expectedTarget);
		else if (
			sequence !== this.stateChangeSequence ||
			this.current?.state !== state ||
			!sameTargets(this.current.elements, this.elements)
		) {
			throw new StaleActionError("revision_changed");
		}
		if (this.referencesMissingElement(input.action)) throw new StaleActionError("element_missing");
		return sequence;
	}

	private assertAction(input: BrowserActInput, verifiedSequence: number, expectedTarget?: ElementTarget): void {
		this.assertActionIdentity(input);
		if (expectedTarget) this.assertTarget(expectedTarget);
		else if (verifiedSequence !== this.stateChangeSequence) throw new StaleActionError("revision_changed");
		if (this.referencesMissingElement(input.action)) throw new StaleActionError("element_missing");
	}

	private assertTarget(expected: ElementTarget): void {
		const current = this.elements.get(expected.elementId);
		if (!current) throw new StaleActionError("element_missing");
		if (!sameTarget(expected, current)) throw new StaleActionError("revision_changed");
	}

	private assertActionIdentity(input: Pick<BrowserActInput, "documentId" | "origin">): void {
		if (input.documentId !== this.documentId) throw new StaleActionError("document_changed");
		if (input.origin !== originOf(this.dependencies.pageState().url)) throw new StaleActionError("origin_changed");
	}

	private async command(
		method: string,
		params: CdpParams,
		sessionId: string | undefined,
		signal: AbortSignal,
		debuggerSignal = this.debuggerAbort.signal,
	): Promise<unknown> {
		if (method.startsWith("Runtime.")) {
			// The only runtime capability is our fixed native-select routine on an
			// object resolved by select(). Arbitrary source and other Runtime APIs stay forbidden.
			const knownSelect =
				typeof params.objectId === "string" &&
				this.nativeSelectObjects.has(`${sessionId ?? "main"}:${params.objectId}`);
			const selects =
				method === "Runtime.callFunctionOn" &&
				params.functionDeclaration === SELECT_NATIVE_OPTION &&
				Array.isArray(params.arguments) &&
				params.arguments.length === 1 &&
				(typeof params.arguments[0]?.value === "string" ||
					(typeof params.arguments[0]?.value?.index === "number" &&
						typeof params.arguments[0]?.value?.value === "string" &&
						typeof params.arguments[0]?.value?.label === "string")) &&
				params.returnByValue === true &&
				params.userGesture === true;
			if (!knownSelect || !(selects || method === "Runtime.releaseObject"))
				throw new Error("Page JavaScript evaluation is forbidden");
		}
		signal.throwIfAborted();
		debuggerSignal.throwIfAborted();
		const handlesDialog = method === "Page.handleJavaScriptDialog";
		const releasesInput = method.startsWith("Input.") && (params.type === "keyUp" || params.type === "mouseReleased");
		const releasesResource = releasesInput || method === "Runtime.releaseObject";
		const dialogSignal = this.dialogOpened.signal;
		if (this.pendingDialog && !handlesDialog && !releasesResource) throw new DialogOpenedError();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (complete: () => void) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				debuggerSignal.removeEventListener("abort", onDebuggerAbort);
				dialogSignal.removeEventListener("abort", onDialog);
				complete();
			};
			const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
			const onDebuggerAbort = () =>
				finish(() => reject(debuggerSignal.reason ?? new Error("Browser debugger detached")));
			const onDialog = () => finish(() => (releasesResource ? resolve(undefined) : reject(new DialogOpenedError())));
			signal.addEventListener("abort", onAbort, { once: true });
			debuggerSignal.addEventListener("abort", onDebuggerAbort, { once: true });
			if (!handlesDialog) dialogSignal.addEventListener("abort", onDialog, { once: true });
			void this.dependencies.debugger.sendCommand(method, params, sessionId).then(
				(result) => finish(() => resolve(result)),
				(cause) => finish(() => reject(cause)),
			);
			if (signal.aborted) onAbort();
			if (debuggerSignal.aborted) onDebuggerAbort();
			// Send release exactly once even while the original input reply is suspended.
			if (!handlesDialog && dialogSignal.aborted) onDialog();
		});
	}
}

class MissingElementError extends Error {}

class DialogOpenedError extends Error {}

class StaleActionError extends Error {
	readonly reason: Extract<BrowserOperationDetails, { status: "stale" }>["reason"];

	constructor(reason: Extract<BrowserOperationDetails, { status: "stale" }>["reason"]) {
		super(reason);
		this.reason = reason;
	}
}
