import type {
	ClientParams,
	ClientResult,
	DeclarativeHookView,
	HookEventNameView,
	McpCatalogEntryView,
	McpCatalogItemDetailView,
	McpCatalogItemKindView,
	McpScopeView,
	McpServerDetailView,
	McpServerSummaryView,
	McpStateView,
	SkillDetailView,
	SkillSourceView,
	SkillSummaryView,
	WritableMcpScopeView,
	WritableSkillSourceView,
} from "@metis/app-protocol";
import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { localeForIntl } from "../i18n.ts";
import {
	ArrowLeft,
	ArrowsClockwise,
	CaretDown,
	CaretRight,
	CheckCircle,
	FolderOpen,
	Key,
	Lightning,
	MagnifyingGlass,
	PencilSimple,
	Plug,
	Plus,
	PuzzlePiece,
	Trash,
	X,
	XCircle,
} from "../icons.tsx";
import type { AppStoreSnapshot } from "../store/app-store.ts";
import type { ProjectPreferenceMap } from "../store/project-preferences.ts";
import { DialogFrame } from "./DialogFrame.tsx";
import { type HookDraft, HookEditorDialog } from "./HookEditorDialog.tsx";
import { Markdown } from "./Markdown.tsx";
import { McpCreationDialog, type McpCreationTarget } from "./McpCreationDialog.tsx";
import {
	McpServerDialog as EditMcpServerDialog,
	McpCredentialDialog,
	type McpServerDraft,
} from "./McpServerDialog.tsx";
import { MenuSelect } from "./MenuSelect.tsx";
import { PluginMarketplacePanel } from "./PluginMarketplacePanel.tsx";
import { SkillCreationDialog, type SkillCreationTarget } from "./SkillCreationDialog.tsx";
import { SkillEditorDialog } from "./SkillEditorDialog.tsx";

const BUILTIN_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
	"create-skill": "Create reusable skills for recurring workflows.",
	docx: "Create and edit Word documents.",
	pptx: "Create and edit PowerPoint presentations.",
	xlsx: "Create and analyze spreadsheets.",
};

type PluginSection = "skills" | "mcp" | "hooks" | "plugins";
type SkillFilter = "all" | SkillSourceView;
type McpFilter = "all" | McpScopeView;
type McpTarget = ClientParams<"mcp/list">;
type PluginPage =
	| { readonly kind: "catalog" }
	| { readonly kind: "skill"; readonly source: SkillSourceView; readonly name: string; readonly cwd: string | null }
	| { readonly kind: "mcp"; readonly scope: McpScopeView; readonly name: string; readonly target: McpTarget }
	| { readonly kind: "hook"; readonly hookId: string };
type PluginApi = Pick<
	MetisDesktopApi,
	| "listSkills"
	| "getSkill"
	| "upsertSkill"
	| "removeSkill"
	| "inspectSkillImport"
	| "importSkills"
	| "openSkillFolder"
	| "selectProjectFolder"
	| "selectAttachmentFiles"
	| "resolveDroppedFiles"
	| "listMcpServers"
	| "inspectMcpImport"
	| "importMcpServers"
	| "getMcpServer"
	| "getMcpCatalogItem"
	| "upsertMcpServer"
	| "removeMcpServer"
	| "restartMcpServer"
	| "setMcpCredential"
	| "clearMcpCredential"
	| "listHooks"
	| "upsertHook"
	| "deleteHook"
	| "listPluginMarkets"
	| "addPluginMarket"
	| "selectPluginMarket"
	| "removePluginMarket"
	| "refreshPluginMarket"
	| "getPluginCatalog"
	| "inspectPlugin"
	| "installPlugin"
	| "listInstalledPlugins"
	| "getInstalledPlugin"
	| "setPluginEnabled"
	| "removePlugin"
	| "inspectPluginUpdate"
	| "updatePlugin"
>;

interface PluginsPanelProps {
	readonly api: PluginApi;
	readonly initialSection?: PluginSection;
	readonly onCreateSkillWithMetis?: (target: SkillCreationTarget) => Promise<void>;
	readonly onSkillsChanged?: () => void;
	readonly preferences: ProjectPreferenceMap;
	readonly serverReady: boolean;
	readonly state: AppStoreSnapshot;
}

type LoadState<T> =
	| { readonly status: "idle" | "loading" }
	| { readonly status: "success"; readonly value: T }
	| { readonly status: "error"; readonly message: string };

type DialogState =
	| { readonly kind: "skill-create"; readonly source: WritableSkillSourceView; readonly initialCwd: string | null }
	| {
			readonly kind: "skill-editor";
			readonly mode: "create" | "edit";
			readonly source: WritableSkillSourceView;
			readonly cwd: string | null;
			readonly initial?: SkillDetailView;
	  }
	| { readonly kind: "skill-remove"; readonly skill: SkillDetailView; readonly cwd: string | null }
	| {
			readonly kind: "mcp-create";
			readonly scope: WritableMcpScopeView;
			readonly initialCwd: string | null;
			readonly initialSession:
				| { readonly sessionId: string; readonly state: string; readonly cwd: string | null }
				| undefined;
	  }
	| {
			readonly kind: "server";
			readonly mode: "edit";
			readonly scope: McpScopeView;
			readonly server: McpServerSummaryView;
			readonly target: McpTarget;
	  }
	| { readonly kind: "remove"; readonly server: McpServerSummaryView; readonly target: McpTarget }
	| { readonly kind: "credential"; readonly server: McpServerSummaryView; readonly sessionId: string }
	| { readonly kind: "hook-editor"; readonly mode: "create" | "edit"; readonly initial?: DeclarativeHookView }
	| { readonly kind: "hook-remove"; readonly hook: DeclarativeHookView };

const HOOK_EVENTS: readonly HookEventNameView[] = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
];

function eventLabelKey(event: HookEventNameView): string {
	switch (event) {
		case "SessionStart":
			return "Session start";
		case "UserPromptSubmit":
			return "User prompt submit";
		case "PreToolUse":
			return "Pre tool use";
		case "PostToolUse":
			return "Post tool use";
		case "PostToolUseFailure":
			return "Post tool use failure";
		case "Stop":
			return "Stop";
	}
}

function eventEffectKey(event: HookEventNameView, protocol?: string): string {
	if (protocol === "command-v1") {
		switch (event) {
			case "SessionStart":
				return "Injects startup context into the first model prompt.";
			case "UserPromptSubmit":
				return "Injects prompt context or blocks prompt execution.";
			case "PreToolUse":
				return "Injects tool context or denies/blocks tool execution.";
			case "PostToolUse":
				return "Appends diagnostic or feedback context to successful tool results.";
			case "PostToolUseFailure":
				return "Appends diagnostic or remediation context to failed tool results.";
			case "Stop":
				return "Requests agent continuation before final settlement.";
		}
	}
	switch (event) {
		case "SessionStart":
			return "Observes session startup.";
		case "UserPromptSubmit":
			return "Observes user prompt submission.";
		case "PreToolUse":
			return "Can block tool execution with exit code 2.";
		case "PostToolUse":
			return "Observes successful tool execution.";
		case "PostToolUseFailure":
			return "Observes tool execution failure.";
		case "Stop":
			return "Observes completion after turn has settled.";
	}
}

function eventTimingKey(event: HookEventNameView, protocol?: string): string {
	if (protocol === "command-v1") {
		switch (event) {
			case "SessionStart":
				return "Runs once when the session is initialized or reloaded.";
			case "UserPromptSubmit":
				return "Runs immediately before prompt template expansion and model request.";
			case "PreToolUse":
				return "Runs before the tool is invoked by the agent.";
			case "PostToolUse":
				return "Runs immediately after a tool finishes successfully.";
			case "PostToolUseFailure":
				return "Runs immediately after a tool fails or exits with an error.";
			case "Stop":
				return "Runs before final settlement, allowing continuation.";
		}
	}
	switch (event) {
		case "SessionStart":
			return "Runs once when the session is initialized or reloaded.";
		case "UserPromptSubmit":
			return "Runs before prompt processing.";
		case "PreToolUse":
			return "Runs before tool execution.";
		case "PostToolUse":
			return "Runs after tool execution.";
		case "PostToolUseFailure":
			return "Runs after tool failure.";
		case "Stop":
			return "Runs after the agent has fully settled.";
	}
}

function RemoveHookDialog({
	error,
	hook,
	onCancel,
	onRemove,
	pending,
}: {
	readonly error: string | null;
	readonly hook: DeclarativeHookView;
	readonly onCancel: () => void;
	readonly onRemove: () => void;
	readonly pending: boolean;
}) {
	const { t } = useTranslation();
	const cancel = useRef<HTMLButtonElement>(null);
	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog hook-remove-dialog"
			descriptionId="hook-remove-description"
			initialFocus={cancel}
			onCancel={onCancel}
			titleId="hook-remove-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onCancel}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="hook-remove-title">{t("Remove Hook?")}</h2>
			<p id="hook-remove-description">
				{t("Remove {{name}}? This will stop it from running automatically.", { name: hook.name })}
			</p>
			{error && (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			)}
			<div className="mcp-dialog-actions">
				<button className="button-secondary" disabled={pending} onClick={onCancel} ref={cancel} type="button">
					{t("Cancel")}
				</button>
				<button className="mcp-danger" disabled={pending} onClick={onRemove} type="button">
					{t(pending ? "Removing…" : "Remove")}
				</button>
			</div>
		</DialogFrame>
	);
}

const noop = () => undefined;

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The operation could not be completed.";
}

function isConflict(cause: unknown): boolean {
	return typeof cause === "object" && cause !== null && "code" in cause && cause.code === -32014;
}

function stateLabel(state: McpStateView): string {
	return (
		{
			inactive: "Inactive",
			disabled: "Disabled",
			connecting: "Connecting",
			connected: "Connected",
			auth_required: "Authentication required",
			reconnecting: "Reconnecting",
			error: "Error",
			closed: "Closed",
			shadowed: "Shadowed",
		} satisfies Record<McpStateView, string>
	)[state];
}

function sourceLabel(source: SkillSourceView): "System" | "User" | "Project" | "Plugin" {
	return source === "system" ? "System" : source === "user" ? "User" : source === "project" ? "Project" : "Plugin";
}

function mcpProtocolTarget(
	target: McpCreationTarget,
	active: { readonly sessionId: string; readonly state: string; readonly cwd: string | null } | undefined,
): McpTarget {
	if (active?.state === "idle" && (target.scope === "user" || active.cwd === target.cwd)) {
		return { sessionId: active.sessionId } as const;
	}
	return { cwd: target.cwd } as const;
}

function RemoveMcpDialog({
	error,
	onCancel,
	onRemove,
	pending,
	server,
}: {
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onRemove: () => void;
	readonly pending: boolean;
	readonly server: McpServerSummaryView;
}) {
	const { t } = useTranslation();
	const cancel = useRef<HTMLButtonElement>(null);
	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog mcp-remove-dialog"
			descriptionId="mcp-remove-description"
			initialFocus={cancel}
			onCancel={onCancel}
			titleId="mcp-remove-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onCancel}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="mcp-remove-title">{t("Remove MCP server?")}</h2>
			<p id="mcp-remove-description">
				{t("Remove {{name}} from the {{scope}} scope?", {
					name: server.name,
					scope: t(server.scope === "user" ? "User" : "Project"),
				})}
			</p>
			{error && (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			)}
			<div className="mcp-dialog-actions">
				<button className="button-secondary" disabled={pending} onClick={onCancel} ref={cancel} type="button">
					{t("Cancel")}
				</button>
				<button className="mcp-danger" disabled={pending} onClick={onRemove} type="button">
					{t(pending ? "Removing…" : "Remove")}
				</button>
			</div>
		</DialogFrame>
	);
}

function RemoveSkillDialog({
	error,
	onCancel,
	onRemove,
	pending,
	skill,
}: {
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onRemove: () => void;
	readonly pending: boolean;
	readonly skill: SkillDetailView;
}) {
	const { t } = useTranslation();
	const cancel = useRef<HTMLButtonElement>(null);
	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog skill-remove-dialog"
			descriptionId="skill-remove-description"
			initialFocus={cancel}
			onCancel={onCancel}
			titleId="skill-remove-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onCancel}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<h2 id="skill-remove-title">{t("Move Skill to Trash?")}</h2>
			<p id="skill-remove-description">
				{t("Move {{name}} to Trash? You can recover it from the Skill trash folder.", { name: skill.name })}
			</p>
			{error && (
				<p className="mcp-dialog-error" role="alert">
					{error}
				</p>
			)}
			<div className="mcp-dialog-actions">
				<button className="button-secondary" disabled={pending} onClick={onCancel} ref={cancel} type="button">
					{t("Cancel")}
				</button>
				<button className="mcp-danger" disabled={pending} onClick={onRemove} type="button">
					{t(pending ? "Moving…" : "Move to Trash")}
				</button>
			</div>
		</DialogFrame>
	);
}

function NewPluginMenu({
	disabled,
	onSelect,
	section,
}: {
	readonly disabled: boolean;
	readonly onSelect: (scope: "user" | "project", trigger: HTMLButtonElement) => void;
	readonly section: PluginSection;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<CSSProperties>({});
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const label = t(section === "skills" ? "New Skill" : "New MCP");
	const updatePosition = useCallback(() => {
		const rect = trigger.current?.getBoundingClientRect();
		if (!rect) return;
		const width = Math.max(150, rect.width);
		setPosition({
			top: rect.bottom + 7,
			left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
			width,
		});
	}, []);
	const close = useCallback((focus = false) => {
		setOpen(false);
		if (focus) queueMicrotask(() => trigger.current?.focus());
	}, []);
	useEffect(() => {
		if (!open) return;
		updatePosition();
		queueMicrotask(() => menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
		const pointer = (event: PointerEvent) => {
			const node = event.target as Node;
			if (!trigger.current?.contains(node) && !menu.current?.contains(node)) close();
		};
		const key = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close(true);
			}
		};
		document.addEventListener("pointerdown", pointer);
		document.addEventListener("keydown", key);
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			document.removeEventListener("pointerdown", pointer);
			document.removeEventListener("keydown", key);
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [close, open, updatePosition]);
	return (
		<div className="plugins-new-control">
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={label}
				className="plugins-new-trigger"
				disabled={disabled}
				onClick={() => setOpen((current) => !current)}
				ref={trigger}
				type="button"
			>
				<span>{label}</span>
				<CaretDown aria-hidden="true" size={14} />
			</button>
			{open &&
				createPortal(
					<div
						aria-label={label}
						className="plugins-new-menu"
						onKeyDown={(event) => {
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
							event.preventDefault();
							const items = [
								...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
							];
							const current = items.indexOf(document.activeElement as HTMLButtonElement);
							const next =
								event.key === "Home"
									? 0
									: event.key === "End"
										? items.length - 1
										: event.key === "ArrowDown"
											? (current + 1) % items.length
											: (current <= 0 ? items.length : current) - 1;
							items[next]?.focus();
						}}
						ref={menu}
						role="menu"
						style={position}
					>
						{(["user", "project"] as const).map((scope) => (
							<button
								key={scope}
								onClick={() => {
									const restore = trigger.current;
									close();
									if (restore) onSelect(scope, restore);
								}}
								role="menuitem"
								type="button"
							>
								{t(scope === "user" ? "User" : "Project")}
							</button>
						))}
					</div>,
					document.body,
				)}
		</div>
	);
}

function SearchBox({
	label,
	query,
	setQuery,
	inputRef,
}: {
	readonly inputRef: RefObject<HTMLInputElement | null>;
	readonly label: string;
	readonly query: string;
	readonly setQuery: (value: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<label className="plugins-search">
			<MagnifyingGlass aria-hidden="true" size={18} />
			<input
				aria-label={label}
				ref={inputRef}
				onChange={(event) => setQuery(event.target.value)}
				placeholder={`${label}…`}
				value={query}
			/>
			{query && (
				<button
					type="button"
					className="search-clear-button"
					aria-label={t("Clear search")}
					onClick={() => {
						setQuery("");
						inputRef.current?.focus();
					}}
				>
					<X aria-hidden="true" size={15} />
				</button>
			)}
		</label>
	);
}

function CatalogList({
	children,
	hasItems,
	label,
	onKeyDown,
}: {
	readonly children: ReactNode;
	readonly hasItems: boolean;
	readonly label: string;
	readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
	return hasItems ? (
		<div className="plugins-full-list" aria-label={label} role="listbox" onKeyDown={onKeyDown}>
			{children}
		</div>
	) : (
		<section className="plugins-full-list" aria-label={label}>
			{children}
		</section>
	);
}

function CatalogEmptyState({
	message,
	description,
	actionLabel,
	onAction,
	disabled = false,
}: {
	readonly message: string;
	readonly description: string;
	readonly actionLabel: string;
	readonly onAction: () => void;
	readonly disabled?: boolean;
}) {
	return (
		<div className="plugins-catalog-message">
			<p>{message}</p>
			<p>{description}</p>
			<button className="settings-secondary-button" disabled={disabled} onClick={onAction} type="button">
				{actionLabel}
			</button>
		</div>
	);
}

function PluginBackButton({ label, onBack }: { readonly label: string; readonly onBack: () => void }) {
	return (
		<div className="plugins-back-row">
			<button aria-label={label} className="plugins-back" onClick={onBack} type="button">
				<ArrowLeft aria-hidden="true" size={17} />
				{label}
			</button>
		</div>
	);
}

function prettyJson(value: string): string {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}

function CatalogItemDetail({ item }: { readonly item: McpCatalogItemDetailView }) {
	const { t } = useTranslation();
	return (
		<div className="mcp-catalog-item-detail">
			{item.description && <p>{item.description}</p>}
			{item.kind === "tool" && (
				<>
					<h4>{t("Input schema")}</h4>
					<pre>
						<code>{prettyJson(item.inputSchema)}</code>
					</pre>
					{item.outputSchema && (
						<>
							<h4>{t("Output schema")}</h4>
							<pre>
								<code>{prettyJson(item.outputSchema)}</code>
							</pre>
						</>
					)}
					{item.annotations && (
						<>
							<h4>{t("Annotations")}</h4>
							<pre>
								<code>{prettyJson(item.annotations)}</code>
							</pre>
						</>
					)}
				</>
			)}
			{item.kind === "prompt" &&
				(item.arguments.length === 0 ? (
					<p>{t("No arguments")}</p>
				) : (
					<dl>
						{item.arguments.map((argument) => (
							<div key={argument.name}>
								<dt>{argument.name}</dt>
								<dd>{argument.description ?? t(argument.required ? "Required" : "Optional")}</dd>
							</div>
						))}
					</dl>
				))}
			{item.kind === "resource" && (
				<dl>
					<div>
						<dt>{t("URI")}</dt>
						<dd>
							<code>{item.uri}</code>
						</dd>
					</div>
					{item.mimeType && (
						<div>
							<dt>{t("MIME type")}</dt>
							<dd>{item.mimeType}</dd>
						</div>
					)}
					{item.size !== undefined && (
						<div>
							<dt>{t("Size")}</dt>
							<dd>{item.size}</dd>
						</div>
					)}
				</dl>
			)}
			{item.kind === "resourceTemplate" && (
				<dl>
					<div>
						<dt>{t("URI template")}</dt>
						<dd>
							<code>{item.uriTemplate}</code>
						</dd>
					</div>
					{item.mimeType && (
						<div>
							<dt>{t("MIME type")}</dt>
							<dd>{item.mimeType}</dd>
						</div>
					)}
				</dl>
			)}
		</div>
	);
}

function DetailList({
	active,
	busy,
	kind,
	label,
	onSelect,
	values,
}: {
	readonly active: McpCatalogItemDetailView | null;
	readonly busy: boolean;
	readonly kind: McpCatalogItemKindView;
	readonly label: string;
	readonly onSelect: (kind: McpCatalogItemKindView, id: string) => void;
	readonly values: readonly McpCatalogEntryView[];
}) {
	if (values.length === 0) return null;
	return (
		<section className="plugins-detail-list">
			<h3>{label}</h3>
			<ul>
				{values.map((value) => {
					const selected = active?.kind === kind && active.id === value.id;
					return (
						<li key={value.id}>
							<button
								aria-expanded={selected}
								aria-label={value.name}
								disabled={busy}
								onClick={() => onSelect(kind, value.id)}
								type="button"
							>
								<span>
									<strong>{value.name}</strong>
									{value.description && <small>{value.description}</small>}
								</span>
								<CaretRight aria-hidden="true" size={14} />
							</button>
							{selected && <CatalogItemDetail item={active} />}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

function McpConfiguration({ server }: { readonly server: McpServerSummaryView }) {
	const { t } = useTranslation();
	const headers = Object.entries(server.envHttpHeaders ?? {}).map(([header, variable]) => `${header}=${variable}`);
	return (
		<dl className="plugins-detail-fields">
			<dt>{t("Transport")}</dt>
			<dd>{t(server.transport === "stdio" ? "Local command" : "Remote HTTP")}</dd>
			{server.command && (
				<>
					<dt>{t("Command")}</dt>
					<dd>
						<code>{server.command}</code>
					</dd>
				</>
			)}
			{server.args?.length ? (
				<>
					<dt>{t("Arguments")}</dt>
					<dd>{server.args.join(" · ")}</dd>
				</>
			) : null}
			{server.envVars?.length ? (
				<>
					<dt>{t("Forwarded variables")}</dt>
					<dd>{server.envVars.join(", ")}</dd>
				</>
			) : null}
			{server.inlineEnvKeys?.length ? (
				<>
					<dt>{t("Configured legacy variables")}</dt>
					<dd>{server.inlineEnvKeys.join(", ")}</dd>
				</>
			) : null}
			{server.cwd && (
				<>
					<dt>{t("Working directory")}</dt>
					<dd>
						<code>{server.cwd}</code>
					</dd>
				</>
			)}
			{server.url && (
				<>
					<dt>{t("URL")}</dt>
					<dd>
						<code>{server.url}</code>
					</dd>
				</>
			)}
			{server.bearerTokenEnvVar && (
				<>
					<dt>{t("Bearer token environment variable")}</dt>
					<dd>{server.bearerTokenEnvVar}</dd>
				</>
			)}
			{headers.length ? (
				<>
					<dt>{t("HTTP headers")}</dt>
					<dd>{headers.join(", ")}</dd>
				</>
			) : null}
			{server.startupTimeoutSec !== undefined && (
				<>
					<dt>{t("Startup timeout (seconds)")}</dt>
					<dd>{server.startupTimeoutSec}</dd>
				</>
			)}
			{server.toolTimeoutSec !== undefined && (
				<>
					<dt>{t("Tool timeout (seconds)")}</dt>
					<dd>{server.toolTimeoutSec}</dd>
				</>
			)}
			{server.enabledTools?.length ? (
				<>
					<dt>{t("Enabled tools")}</dt>
					<dd>{server.enabledTools.join(", ")}</dd>
				</>
			) : null}
			{server.disabledTools.length ? (
				<>
					<dt>{t("Disabled tools")}</dt>
					<dd>{server.disabledTools.join(", ")}</dd>
				</>
			) : null}
			<dt>{t("Enabled")}</dt>
			<dd>{t(server.enabled ? "Yes" : "No")}</dd>
			<dt>{t("Required")}</dt>
			<dd>{t(server.required ? "Yes" : "No")}</dd>
		</dl>
	);
}

function keyNavigation(event: KeyboardEvent<HTMLDivElement>): void {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	event.preventDefault();
	const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".plugins-list-row:not(:disabled)")];
	if (rows.length === 0) return;
	const current = rows.indexOf(document.activeElement as HTMLButtonElement);
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? rows.length - 1
				: event.key === "ArrowDown"
					? Math.min(rows.length - 1, current + 1)
					: Math.max(0, current < 0 ? 0 : current - 1);
	rows[next]?.focus();
}

export function PluginsPanel({
	api,
	initialSection = "skills",
	onCreateSkillWithMetis = async () => undefined,
	onSkillsChanged = noop,
	preferences,
	serverReady,
	state,
}: PluginsPanelProps) {
	const { t } = useTranslation();
	const [section, setSection] = useState<PluginSection>(initialSection);
	const [marketplaceActionsTarget, setMarketplaceActionsTarget] = useState<HTMLDivElement | null>(null);
	const [page, setPage] = useState<PluginPage>({ kind: "catalog" });
	const [skillFilter, setSkillFilter] = useState<SkillFilter>("all");
	const [mcpFilter, setMcpFilter] = useState<McpFilter>("all");
	const [skillQuery, setSkillQuery] = useState("");
	const [mcpQuery, setMcpQuery] = useState("");
	const [skillCursor, setSkillCursor] = useState<string | null>(null);
	const [mcpCursor, setMcpCursor] = useState<string | null>(null);
	const [skillsState, setSkillsState] = useState<LoadState<readonly SkillSummaryView[]>>({ status: "idle" });
	const [skillDetail, setSkillDetail] = useState<SkillDetailView | null>(null);
	const [skillDetailError, setSkillDetailError] = useState<string | null>(null);
	const [skillRetry, setSkillRetry] = useState(0);
	const [mcpState, setMcpState] = useState<LoadState<readonly McpServerSummaryView[]>>({ status: "idle" });
	const [mcpDetail, setMcpDetail] = useState<McpServerDetailView | null>(null);
	const [mcpDetailError, setMcpDetailError] = useState<string | null>(null);
	const [mcpRefreshedAt, setMcpRefreshedAt] = useState<string | null>(null);
	const [mcpRefresh, setMcpRefresh] = useState(0);
	const [hooksState, setHooksState] = useState<LoadState<readonly DeclarativeHookView[]>>({ status: "idle" });
	const [hooksRefresh, setHooksRefresh] = useState(0);
	const [hookFilter, setHookFilter] = useState<"all" | HookEventNameView>("all");
	const [hookQuery, setHookQuery] = useState("");
	const [hookCursor, setHookCursor] = useState<string | null>(null);
	const [dialog, setDialog] = useState<DialogState | null>(null);
	const [dialogError, setDialogError] = useState<string | null>(null);
	const [hookActionError, setHookActionError] = useState<string | null>(null);
	const [hookTogglePending, setHookTogglePending] = useState(false);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
	const navigateToPlugin = useCallback((pluginId: string) => {
		setSelectedPluginId(pluginId);
		setSection("plugins");
		setPage({ kind: "catalog" });
	}, []);
	const skillListGeneration = useRef(0);
	const skillDetailGeneration = useRef(0);
	const mcpListGeneration = useRef(0);
	const mcpDetailGeneration = useRef(0);
	const hooksListGeneration = useRef(0);
	const hookToggleRef = useRef(false);
	const skipSkillDetailLoad = useRef<string | null>(null);
	const detailHeading = useRef<HTMLHeadingElement>(null);
	const catalogSearch = useRef<HTMLInputElement>(null);
	const restoreFocus = useRef<HTMLButtonElement | null>(null);
	const activeSession = state.activeSessionId ? state.sessionsById.get(state.activeSessionId) : undefined;
	const activeCwd = activeSession?.cwd ?? null;
	const activeProjectCwd = activeSession?.cwdOrigin === "managed" ? null : activeCwd;
	const projects = useMemo(() => {
		const names = new Map<string, string>();
		const aliases = new Map(
			[...preferences.values()].flatMap((entry) => (entry.alias ? [[entry.cwd, entry.alias] as const] : [])),
		);
		for (const session of state.sessionsById.values()) {
			if (!session.cwd || session.cwdOrigin === "managed") continue;
			names.set(
				session.cwd,
				aliases.get(session.cwd) ?? session.cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? session.cwd,
			);
		}
		if (activeProjectCwd && !names.has(activeProjectCwd))
			names.set(activeProjectCwd, activeProjectCwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? activeProjectCwd);
		return [...names]
			.map(([cwd, name]) => ({ cwd, name }))
			.sort((left, right) => left.name.localeCompare(right.name));
	}, [activeProjectCwd, preferences, state.sessionsById]);
	const activeSessionId = activeSession?.sessionId;
	const activeSessionState = activeSession?.state;
	const skillTarget = useMemo<ClientParams<"skill/list">>(
		() => (activeSessionId && activeSessionState !== "running" ? { sessionId: activeSessionId } : { cwd: activeCwd }),
		[activeCwd, activeSessionId, activeSessionState],
	);
	const mcpTarget = useMemo<McpTarget>(
		() => (activeSessionId && activeSessionState !== "running" ? { sessionId: activeSessionId } : { cwd: activeCwd }),
		[activeCwd, activeSessionId, activeSessionState],
	);
	const displayedMcpTarget = page.kind === "mcp" ? page.target : mcpTarget;
	const mcpSessionId = "sessionId" in displayedMcpTarget ? displayedMcpTarget.sessionId : null;
	useEffect(() => {
		if (activeProjectCwd !== null) return;
		if (skillFilter === "project") setSkillFilter("all");
		if (mcpFilter === "project") setMcpFilter("all");
	}, [activeProjectCwd, mcpFilter, skillFilter]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(skillRetry): Retry explicitly reloads the skill list.
	useEffect(() => {
		const generation = ++skillListGeneration.current;
		if (!serverReady) {
			setSkillsState({ status: "loading" });
			return;
		}
		setSkillsState({ status: "loading" });
		void api.listSkills(skillTarget).then(
			(result) => {
				if (generation === skillListGeneration.current)
					setSkillsState({
						status: "success",
						value: [...result.skills].sort((a, b) => a.name.localeCompare(b.name)),
					});
			},
			(cause) => {
				if (generation === skillListGeneration.current)
					setSkillsState({ status: "error", message: message(cause) });
			},
		);
		return () => {
			if (generation === skillListGeneration.current) skillListGeneration.current += 1;
		};
	}, [api, serverReady, skillRetry, skillTarget]);

	useEffect(() => {
		const generation = ++skillDetailGeneration.current;
		setSkillDetailError(null);
		if (page.kind !== "skill") {
			setSkillDetail(null);
			return;
		}
		const identity = `${page.source}:${page.name}`;
		if (skipSkillDetailLoad.current === identity) {
			skipSkillDetailLoad.current = null;
			return;
		}
		setSkillDetail(null);
		void api.getSkill({ cwd: page.cwd, source: page.source, name: page.name }).then(
			(detail) => {
				if (generation === skillDetailGeneration.current) setSkillDetail(detail);
			},
			(cause) => {
				if (generation === skillDetailGeneration.current) setSkillDetailError(message(cause));
			},
		);
		return () => {
			if (generation === skillDetailGeneration.current) skillDetailGeneration.current += 1;
		};
	}, [api, page]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(mcpRefresh): MCP mutations and retry requests invalidate the server list.
	useEffect(() => {
		if (section !== "mcp") {
			mcpListGeneration.current += 1;
			return;
		}
		const generation = ++mcpListGeneration.current;
		if (!serverReady) {
			setMcpState({ status: "loading" });
			return;
		}
		setMcpState({ status: "loading" });
		void api.listMcpServers(displayedMcpTarget).then(
			(result) => {
				if (generation === mcpListGeneration.current) {
					setMcpState({ status: "success", value: result.servers });
					setMcpRefreshedAt(new Date().toISOString());
				}
			},
			(cause) => {
				if (generation === mcpListGeneration.current) setMcpState({ status: "error", message: message(cause) });
			},
		);
		return () => {
			if (generation === mcpListGeneration.current) mcpListGeneration.current += 1;
		};
	}, [api, displayedMcpTarget, mcpRefresh, section, serverReady]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(hooksRefresh): Hook mutations and retry requests invalidate the hook list.
	useEffect(() => {
		if (section !== "hooks") {
			hooksListGeneration.current += 1;
			return;
		}
		const generation = ++hooksListGeneration.current;
		if (!serverReady) {
			setHooksState({ status: "loading" });
			return;
		}
		setHooksState({ status: "loading" });
		void api.listHooks().then(
			(result) => {
				if (generation === hooksListGeneration.current) setHooksState({ status: "success", value: result.hooks });
			},
			(cause) => {
				if (generation === hooksListGeneration.current) setHooksState({ status: "error", message: message(cause) });
			},
		);
		return () => {
			if (generation === hooksListGeneration.current) hooksListGeneration.current += 1;
		};
	}, [api, hooksRefresh, section, serverReady]);

	const selectedMcp =
		page.kind === "mcp" && mcpState.status === "success"
			? mcpState.value.find((server) => server.scope === page.scope && server.name === page.name)
			: undefined;
	useEffect(() => {
		const generation = ++mcpDetailGeneration.current;
		setMcpDetailError(null);
		if (page.kind !== "mcp" || !selectedMcp) {
			setMcpDetail(null);
			return;
		}
		if (!mcpSessionId) {
			setMcpDetail({ server: selectedMcp, tools: [], resources: [], resourceTemplates: [], prompts: [] });
			return;
		}
		setMcpDetail(null);
		void api.getMcpServer({ sessionId: mcpSessionId, scope: page.scope, name: page.name }).then(
			(detail) => {
				if (generation === mcpDetailGeneration.current) {
					setMcpDetail(detail);
					setMcpRefreshedAt(new Date().toISOString());
				}
			},
			(cause) => {
				if (generation !== mcpDetailGeneration.current) return;
				if (isConflict(cause)) setMcpRefresh((value) => value + 1);
				setMcpDetailError(
					isConflict(cause)
						? t("This MCP server changed elsewhere. Review the latest settings and try again.")
						: message(cause),
				);
			},
		);
		return () => {
			if (generation === mcpDetailGeneration.current) mcpDetailGeneration.current += 1;
		};
	}, [api, mcpSessionId, page, selectedMcp, t]);

	const selectedHook =
		page.kind === "hook" && hooksState.status === "success"
			? hooksState.value.find((hook) => hook.id === page.hookId)
			: undefined;
	const hookPageId = page.kind === "hook" ? page.hookId : null;
	const hookPageRef = useRef<string | null>(null);
	hookPageRef.current = section === "hooks" ? hookPageId : null;
	const hookControlsDisabled = hookTogglePending || pendingAction === "hook" || pendingAction === "hook-remove";

	// biome-ignore lint/correctness/useExhaustiveDependencies: Clear stale action feedback when the selected hook or section changes.
	useEffect(() => {
		setHookActionError(null);
	}, [hookPageId, section]);

	useEffect(() => {
		if (
			(page.kind === "skill" && skillDetail) ||
			(page.kind === "mcp" && mcpDetail) ||
			(page.kind === "hook" && selectedHook)
		)
			queueMicrotask(() => detailHeading.current?.focus());
	}, [mcpDetail, page.kind, selectedHook, skillDetail]);

	const visibleSkills = useMemo(() => {
		if (skillsState.status !== "success") return [];
		const query = skillQuery.trim().toLocaleLowerCase();
		return skillsState.value.filter(
			(skill) =>
				(skillFilter === "all" || skill.source === skillFilter) &&
				(!query ||
					`${skill.name} ${skill.description} ${(skill.source ?? "system") === "system" ? t(BUILTIN_SKILL_DESCRIPTIONS[skill.name] ?? "") : ""}`
						.toLocaleLowerCase()
						.includes(query)),
		);
	}, [skillFilter, skillQuery, skillsState, t]);
	const visibleMcp = useMemo(() => {
		if (mcpState.status !== "success") return [];
		const query = mcpQuery.trim().toLocaleLowerCase();
		return mcpState.value.filter(
			(server) =>
				(mcpFilter === "all" || server.scope === mcpFilter) &&
				(!query || server.name.toLocaleLowerCase().includes(query)),
		);
	}, [mcpFilter, mcpQuery, mcpState]);
	const visibleHooks = useMemo(() => {
		if (hooksState.status !== "success") return [];
		const query = hookQuery.trim().toLocaleLowerCase();
		return hooksState.value.filter(
			(hook) =>
				(hookFilter === "all" || hook.event === hookFilter) &&
				(!query || `${hook.name} ${hook.command} ${hook.statusMessage ?? ""}`.toLocaleLowerCase().includes(query)),
		);
	}, [hookFilter, hookQuery, hooksState]);

	const catalogFiltered =
		section === "skills"
			? Boolean(skillQuery.trim() || skillFilter !== "all")
			: section === "mcp"
				? Boolean(mcpQuery.trim() || mcpFilter !== "all")
				: Boolean(hookQuery.trim() || hookFilter !== "all");
	const resetCatalogFilters = () => {
		if (section === "skills") {
			setSkillQuery("");
			setSkillFilter("all");
		} else if (section === "mcp") {
			setMcpQuery("");
			setMcpFilter("all");
		} else {
			setHookQuery("");
			setHookFilter("all");
		}
		catalogSearch.current?.focus();
	};

	const switchSection = (next: PluginSection) => {
		setSection(next);
		setPage({ kind: "catalog" });
		if (next === "skills") {
			mcpDetailGeneration.current += 1;
			setSkillRetry((v) => v + 1);
		} else if (next === "mcp") {
			skillDetailGeneration.current += 1;
			setMcpRefresh((v) => v + 1);
		} else if (next === "hooks") {
			setHooksRefresh((v) => v + 1);
		}
	};
	const closeDialog = () => {
		if (pendingAction) return;
		setDialog(null);
		setDialogError(null);
		queueMicrotask(() => restoreFocus.current?.focus());
	};
	const openDialog = (next: DialogState, trigger?: HTMLButtonElement | null) => {
		restoreFocus.current = trigger ?? (document.activeElement as HTMLButtonElement | null);
		setDialogError(null);
		setDialog(next);
	};
	const applyMcpRows = (servers: readonly McpServerSummaryView[]) =>
		setMcpState({ status: "success", value: servers });
	const applyMcpServer = (server: McpServerSummaryView) =>
		setMcpState((current) =>
			current.status === "success"
				? {
						status: "success",
						value: current.value.map((row) =>
							row.scope === server.scope && row.name === server.name ? server : row,
						),
					}
				: current,
		);
	const applySkill = (detail: SkillDetailView) =>
		setSkillsState((current) => {
			if (current.status !== "success") return current;
			const summary = { name: detail.name, description: detail.description, source: detail.source };
			const rows = current.value.filter((row) => !(row.name === detail.name && row.source === detail.source));
			return { status: "success", value: [...rows, summary].sort((a, b) => a.name.localeCompare(b.name)) };
		});

	const submitSkill = async (name: string, content: string) => {
		if (dialog?.kind !== "skill-editor") return;
		setPendingAction("skill");
		setDialogError(null);
		try {
			const detail = await api.upsertSkill({
				requestId: crypto.randomUUID(),
				cwd: dialog.cwd,
				source: dialog.source,
				name,
				expectedRevision: dialog.mode === "edit" ? dialog.initial!.revision : null,
				content,
			});
			applySkill(detail);
			setSkillDetail(detail);
			skipSkillDetailLoad.current = `${detail.source}:${detail.name}`;
			setPage({ kind: "skill", source: detail.source, name: detail.name, cwd: dialog.cwd });
			setDialog(null);
			onSkillsChanged();
		} catch (cause) {
			setDialogError(
				isConflict(cause)
					? t("This Skill changed elsewhere. Review the latest version and try again.")
					: message(cause),
			);
			if (isConflict(cause)) setSkillRetry((value) => value + 1);
		} finally {
			setPendingAction(null);
		}
	};
	const removeSkill = async (skill: SkillDetailView, cwd: string | null) => {
		setPendingAction("skill-remove");
		setDialogError(null);
		try {
			const result = await api.removeSkill({
				requestId: crypto.randomUUID(),
				cwd,
				source: skill.source as WritableSkillSourceView,
				name: skill.name,
				expectedRevision: skill.revision,
			});
			setSkillsState({ status: "success", value: result.skills });
			setDialog(null);
			setPage({ kind: "catalog" });
			onSkillsChanged();
		} catch (cause) {
			setDialogError(
				isConflict(cause)
					? t("This Skill changed elsewhere. Review the latest version and try again.")
					: message(cause),
			);
			if (isConflict(cause)) setSkillRetry((value) => value + 1);
		} finally {
			setPendingAction(null);
		}
	};
	const submitServer = async (draft: McpServerDraft) => {
		if (dialog?.kind !== "server") return;
		setPendingAction("server");
		setDialogError(null);
		try {
			const result = await api.upsertMcpServer({
				...dialog.target,
				requestId: crypto.randomUUID(),
				scope: dialog.server.scope,
				name: dialog.server.name,
				expectedRevision: dialog.server.revision,
				server: draft.server,
				...(draft.credential ? { credential: draft.credential } : {}),
			} as ClientParams<"mcp/upsert">);
			applyMcpRows(result.servers);
			setPage({ kind: "mcp", scope: dialog.server.scope, name: dialog.server.name, target: dialog.target });
			setDialog(null);
		} catch (cause) {
			if (isConflict(cause)) setMcpRefresh((value) => value + 1);
			setDialogError(
				isConflict(cause)
					? t("This MCP server changed elsewhere. Review the latest settings and try again.")
					: message(cause),
			);
		} finally {
			setPendingAction(null);
		}
	};
	const creationSession = dialog?.kind === "mcp-create" ? dialog.initialSession : undefined;
	const createMcpServer = async (
		target: McpCreationTarget,
		draft: McpServerDraft,
		expectedRevision: string | null,
	) => {
		const protocolTarget = mcpProtocolTarget(target, creationSession);
		const result = await api.upsertMcpServer({
			...protocolTarget,
			requestId: crypto.randomUUID(),
			scope: target.scope,
			name: draft.name,
			expectedRevision,
			server: draft.server,
			...(draft.credential ? { credential: draft.credential } : {}),
		} as ClientParams<"mcp/upsert">);
		applyMcpRows(result.servers);
		setPage({ kind: "mcp", scope: target.scope, name: draft.name, target: protocolTarget });
		setDialog(null);
	};
	const inspectMcpCreation = (target: McpCreationTarget, text: string) =>
		api.inspectMcpImport({
			...mcpProtocolTarget(target, creationSession),
			scope: target.scope,
			text,
		} as ClientParams<"mcp/import/inspect">);
	const importMcpCreation = async (
		target: McpCreationTarget,
		text: string,
		inspection: ClientResult<"mcp/import/inspect">,
		candidateIds: readonly string[],
	) => {
		const selected = new Set(candidateIds);
		const result = await api.importMcpServers({
			...mcpProtocolTarget(target, creationSession),
			requestId: crypto.randomUUID(),
			scope: target.scope,
			text,
			sourceRevision: inspection.sourceRevision,
			candidates: inspection.candidates
				.filter((candidate) => selected.has(candidate.id))
				.map((candidate) => ({ id: candidate.id, expectedRevision: candidate.existingRevision })),
		} as ClientParams<"mcp/import">);
		applyMcpRows(result.servers);
		setDialog(null);
	};
	const removeServer = async (server: McpServerSummaryView, target: McpTarget) => {
		setPendingAction("remove");
		setDialogError(null);
		try {
			const result = await api.removeMcpServer({
				...target,
				requestId: crypto.randomUUID(),
				scope: server.scope,
				name: server.name,
				expectedRevision: server.revision,
			} as ClientParams<"mcp/remove">);
			applyMcpRows(result.servers);
			setDialog(null);
			setPage({ kind: "catalog" });
		} catch (cause) {
			if (isConflict(cause)) setMcpRefresh((value) => value + 1);
			setDialogError(
				isConflict(cause)
					? t("This MCP server changed elsewhere. Review the latest settings and try again.")
					: message(cause),
			);
		} finally {
			setPendingAction(null);
		}
	};
	const liveAction = async (kind: "restart" | "clear", server: McpServerSummaryView) => {
		if (!mcpSessionId) return;
		setPendingAction(kind);
		setMcpDetailError(null);
		try {
			const base = {
				requestId: crypto.randomUUID(),
				sessionId: mcpSessionId,
				scope: server.scope,
				name: server.name,
				expectedRevision: server.revision,
			};
			const detail = kind === "restart" ? await api.restartMcpServer(base) : await api.clearMcpCredential(base);
			setMcpDetail(detail);
			applyMcpServer(detail.server);
		} catch (cause) {
			if (isConflict(cause)) setMcpRefresh((value) => value + 1);
			setMcpDetailError(
				isConflict(cause)
					? t("This MCP server changed elsewhere. Review the latest settings and try again.")
					: message(cause),
			);
		} finally {
			setPendingAction(null);
		}
	};
	const setCredential = async (
		server: McpServerSummaryView,
		sessionId: string,
		credential: ClientParams<"mcp/credential/set">["credential"],
	) => {
		setPendingAction("credential");
		setDialogError(null);
		try {
			const detail = await api.setMcpCredential({
				requestId: crypto.randomUUID(),
				sessionId,
				scope: server.scope,
				name: server.name,
				expectedRevision: server.revision,
				credential,
			});
			setMcpDetail(detail);
			applyMcpServer(detail.server);
			setDialog(null);
		} catch (cause) {
			if (isConflict(cause)) setMcpRefresh((value) => value + 1);
			setDialogError(
				isConflict(cause)
					? t("This MCP server changed elsewhere. Review the latest settings and try again.")
					: message(cause),
			);
		} finally {
			setPendingAction(null);
		}
	};

	const submitHook = async (draft: HookDraft) => {
		setPendingAction("hook");
		setDialogError(null);
		try {
			const timeoutSeconds = draft.timeout.trim() === "" ? undefined : Number(draft.timeout);
			let metadata: Record<string, unknown> | undefined;
			if (draft.metadataJson.trim() !== "") {
				metadata = JSON.parse(draft.metadataJson) as Record<string, unknown>;
			}
			const args =
				draft.runMode === "process"
					? draft.args
							.split("\n")
							.map((l) => l.trim())
							.filter((l) => l.length > 0)
					: undefined;
			const hookInput: DeclarativeHookView = {
				id: draft.id ?? crypto.randomUUID(),
				name: draft.name.trim(),
				enabled: draft.enabled,
				event: draft.event,
				protocol: draft.protocol,
				runMode: draft.runMode,
				command: draft.command.trim(),
				...(draft.matcher.trim() ? { matcher: draft.matcher.trim() } : {}),
				...(args && args.length > 0 ? { args } : {}),
				...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
				...(draft.statusMessage.trim() ? { statusMessage: draft.statusMessage.trim() } : {}),
				...(metadata ? { metadata } : {}),
			};
			const result = await api.upsertHook({ hook: hookInput });
			setHooksState({ status: "success", value: result.hooks });
			setDialog(null);
		} catch (cause) {
			setDialogError(message(cause));
		} finally {
			setPendingAction(null);
		}
	};

	const removeHook = async (hook: DeclarativeHookView) => {
		setPendingAction("hook-remove");
		setDialogError(null);
		try {
			const result = await api.deleteHook({ id: hook.id });
			setHooksState({ status: "success", value: result.hooks });
			if (page.kind === "hook" && page.hookId === hook.id) {
				setPage({ kind: "catalog" });
			}
			setDialog(null);
		} catch (cause) {
			setDialogError(message(cause));
		} finally {
			setPendingAction(null);
		}
	};

	const toggleHookEnabled = async (hook: DeclarativeHookView) => {
		if (hookToggleRef.current) return;
		hookToggleRef.current = true;
		setHookTogglePending(true);
		setHookActionError(null);
		try {
			const result = await api.upsertHook({ hook: { ...hook, enabled: !hook.enabled } });
			setHooksState({ status: "success", value: result.hooks });
		} catch (cause) {
			if (hookPageRef.current === hook.id) setHookActionError(message(cause));
		} finally {
			hookToggleRef.current = false;
			setHookTogglePending(false);
		}
	};

	const catalog = (
		<section
			aria-busy={
				(section === "skills" ? skillsState : section === "mcp" ? mcpState : hooksState).status === "loading"
			}
			className="plugins-catalog-page"
		>
			<header className="plugins-page-header">
				<div>
					<h1 id="plugins-title">{t("Customize")}</h1>
					<p>{t("Extend Metis with built-in capabilities, MCP servers, and hooks.")}</p>
				</div>
				{section === "plugins" ? (
					<div className="plugins-page-actions" ref={setMarketplaceActionsTarget} />
				) : (
					<div className="plugins-page-actions">
						{section === "skills" && (
							<button
								aria-label={t(skillsState.status === "loading" ? "Reloading skills…" : "Reload Skills")}
								className="plugins-reload"
								disabled={
									!serverReady || skillsState.status === "loading" || activeSession?.state === "running"
								}
								onClick={() => {
									onSkillsChanged();
									setSkillRetry((value) => value + 1);
								}}
								title={t("Reload Skills")}
								type="button"
							>
								<ArrowsClockwise
									aria-hidden="true"
									className={skillsState.status === "loading" ? "plugins-spin" : undefined}
									size={16}
								/>
								{t("Reload")}
							</button>
						)}
						{section === "hooks" && (
							<button
								aria-label={t(hooksState.status === "loading" ? "Reloading hooks…" : "Reload Hooks")}
								className="plugins-reload"
								disabled={!serverReady || hooksState.status === "loading"}
								onClick={() => setHooksRefresh((v) => v + 1)}
								title={t("Reload Hooks")}
								type="button"
							>
								<ArrowsClockwise
									aria-hidden="true"
									className={hooksState.status === "loading" ? "plugins-spin" : undefined}
									size={16}
								/>
								{t("Reload")}
							</button>
						)}
						{section === "hooks" ? (
							<button
								className="plugins-new-btn"
								disabled={!serverReady}
								onClick={() => openDialog({ kind: "hook-editor", mode: "create" })}
								type="button"
							>
								<Plus aria-hidden="true" size={16} />
								<span>{t("New Hook")}</span>
							</button>
						) : (
							<NewPluginMenu
								disabled={!serverReady}
								onSelect={(scope, trigger) =>
									openDialog(
										section === "skills"
											? {
													kind: "skill-create",
													source: scope,
													initialCwd: scope === "project" ? activeProjectCwd : null,
												}
											: {
													kind: "mcp-create",
													scope,
													initialCwd: scope === "project" ? activeProjectCwd : null,
													initialSession: activeSession,
												},
										trigger,
									)
								}
								section={section}
							/>
						)}
					</div>
				)}
			</header>
			<div className="plugins-section-switch-row">
				<div
					aria-label={t("Plugin sections")}
					className="plugins-section-switch"
					data-section={section}
					role="tablist"
				>
					<span aria-hidden="true" className="plugins-section-indicator" />
					<button
						aria-selected={section === "skills"}
						onClick={() => switchSection("skills")}
						role="tab"
						type="button"
					>
						{t("Skills")}
					</button>
					<button aria-selected={section === "mcp"} onClick={() => switchSection("mcp")} role="tab" type="button">
						{t("MCP")}
					</button>
					<button
						aria-selected={section === "hooks"}
						onClick={() => switchSection("hooks")}
						role="tab"
						type="button"
					>
						{t("Hooks")}
					</button>
					<button
						aria-selected={section === "plugins"}
						onClick={() => switchSection("plugins")}
						role="tab"
						type="button"
					>
						{t("Plugins")}
					</button>
				</div>
			</div>
			{section === "plugins" ? (
				<PluginMarketplacePanel
					headerActionsTarget={marketplaceActionsTarget}
					api={api as unknown as MetisDesktopApi}
					onClearSelectedPlugin={() => setSelectedPluginId(null)}
					onOpenHook={(id) => {
						switchSection("hooks");
						setPage({ kind: "hook", hookId: id });
					}}
					onOpenMcp={(name) => {
						switchSection("mcp");
						setMcpDetail(null);
						setPage({ kind: "mcp", scope: "plugin", name, target: mcpTarget });
					}}
					onOpenSkill={(name) => {
						switchSection("skills");
						setSkillDetail(null);
						setPage({ kind: "skill", source: "plugin", name, cwd: activeCwd });
					}}
					selectedPluginId={selectedPluginId}
					serverReady={serverReady}
				/>
			) : (
				<>
					<div className="plugins-list-controls">
						<SearchBox
							inputRef={catalogSearch}
							label={t(
								section === "skills"
									? "Search Skills"
									: section === "mcp"
										? "Search MCP servers"
										: "Search Hooks",
							)}
							query={section === "skills" ? skillQuery : section === "mcp" ? mcpQuery : hookQuery}
							setQuery={section === "skills" ? setSkillQuery : section === "mcp" ? setMcpQuery : setHookQuery}
						/>
						{section === "skills" ? (
							<MenuSelect
								ariaLabel={t("Skill sources")}
								className="plugins-filter"
								onChange={setSkillFilter}
								options={(["all", "system", "user", "project", "plugin"] as const).map((value) => ({
									value,
									label: t(value === "all" ? "All sources" : sourceLabel(value)),
									disabled: value === "project" && activeProjectCwd === null,
								}))}
								value={skillFilter}
							/>
						) : section === "mcp" ? (
							<MenuSelect
								ariaLabel={t("MCP scopes")}
								className="plugins-filter"
								onChange={setMcpFilter}
								options={(["all", "user", "project", "plugin"] as const).map((value) => ({
									value,
									label: t(
										value === "all"
											? "All scopes"
											: value === "user"
												? "User"
												: value === "project"
													? "Project"
													: "Plugin",
									),
									disabled: value === "project" && activeProjectCwd === null,
								}))}
								value={mcpFilter}
							/>
						) : (
							<MenuSelect
								ariaLabel={t("Hook events")}
								className="plugins-filter"
								onChange={setHookFilter}
								options={[
									{ value: "all", label: t("All events") },
									...HOOK_EVENTS.map((ev) => ({ value: ev, label: t(eventLabelKey(ev)) })),
								]}
								value={hookFilter}
							/>
						)}
					</div>
					<CatalogList
						label={t(section === "skills" ? "Skills" : section === "mcp" ? "MCP" : "Hooks")}
						hasItems={
							(section === "skills" ? visibleSkills : section === "mcp" ? visibleMcp : visibleHooks).length > 0
						}
						onKeyDown={keyNavigation}
					>
						{section === "skills" ? (
							skillsState.status === "loading" ? (
								<output className="status-paragraph plugins-catalog-message">{t("Loading skills")}</output>
							) : skillsState.status === "error" ? (
								<div className="plugins-catalog-message" role="alert">
									<p>{skillsState.message}</p>
									<button onClick={() => setSkillRetry((value) => value + 1)} type="button">
										{t("Retry")}
									</button>
								</div>
							) : visibleSkills.length === 0 ? (
								<CatalogEmptyState
									message={t(
										catalogFiltered ? "No matching results" : "No Skills are available in this category.",
									)}
									description={t(
										catalogFiltered
											? "Try another search or clear the filters."
											: "Create reusable instructions for tasks you do often.",
									)}
									actionLabel={t(catalogFiltered ? "Clear filters" : "Create User Skill")}
									disabled={!catalogFiltered && !serverReady}
									onAction={
										catalogFiltered
											? resetCatalogFilters
											: () => openDialog({ kind: "skill-create", source: "user", initialCwd: null })
									}
								/>
							) : (
								visibleSkills.map((skill) => (
									<button
										aria-label={skill.name}
										aria-selected={skillCursor === `${skill.source}:${skill.name}`}
										className="plugins-list-row"
										key={`${skill.source}:${skill.name}`}
										onClick={() => {
											setSkillDetail(null);
											setPage({
												kind: "skill",
												source: skill.source ?? "system",
												name: skill.name,
												cwd: activeCwd,
											});
										}}
										onFocus={() => setSkillCursor(`${skill.source}:${skill.name}`)}
										role="option"
										type="button"
									>
										<span className="plugins-row-icon">
											<PuzzlePiece aria-hidden="true" size={22} />
										</span>
										<span className="plugins-row-copy">
											<strong>{skill.name}</strong>
											<small>
												{(skill.source ?? "system") === "system"
													? t(BUILTIN_SKILL_DESCRIPTIONS[skill.name] ?? skill.description)
													: skill.description}
											</small>
										</span>
										<span className="plugins-row-meta">
											{t(sourceLabel(skill.source ?? "system"))}
											{skill.pluginOwner && (
												<span className="plugins-from-owner-badge">{skill.pluginOwner.displayName}</span>
											)}
										</span>
										<CaretRight aria-hidden="true" size={17} />
									</button>
								))
							)
						) : section === "mcp" ? (
							mcpState.status === "loading" ? (
								<output className="status-paragraph plugins-catalog-message">
									{t("Loading MCP servers…")}
								</output>
							) : mcpState.status === "error" ? (
								<div className="plugins-catalog-message" role="alert">
									<p>{mcpState.message}</p>
									<button onClick={() => setMcpRefresh((value) => value + 1)} type="button">
										{t("Retry")}
									</button>
								</div>
							) : visibleMcp.length === 0 ? (
								<CatalogEmptyState
									message={t(catalogFiltered ? "No matching results" : "No MCP servers in this scope.")}
									description={t(
										catalogFiltered
											? "Try another search or clear the filters."
											: "Connect tools and data through a local or remote MCP server.",
									)}
									actionLabel={t(catalogFiltered ? "Clear filters" : "Create User MCP")}
									disabled={!catalogFiltered && !serverReady}
									onAction={
										catalogFiltered
											? resetCatalogFilters
											: () =>
													openDialog({
														kind: "mcp-create",
														scope: "user",
														initialCwd: null,
														initialSession: activeSession,
													})
									}
								/>
							) : (
								visibleMcp.map((server) => (
									<button
										aria-label={server.name}
										aria-selected={mcpCursor === `${server.scope}:${server.name}`}
										className="plugins-list-row plugins-mcp-row"
										key={`${server.scope}:${server.name}`}
										onClick={() => {
											setMcpDetail(null);
											setPage({ kind: "mcp", scope: server.scope, name: server.name, target: mcpTarget });
										}}
										onFocus={() => setMcpCursor(`${server.scope}:${server.name}`)}
										role="option"
										type="button"
									>
										<span className="plugins-row-icon">
											<Plug aria-hidden="true" size={22} />
										</span>
										<span className="plugins-row-copy">
											<strong>{server.name}</strong>
											<small>{t(server.transport === "stdio" ? "Local command" : "Remote HTTP")}</small>
										</span>
										<span className="plugins-row-meta">
											{t(
												server.scope === "user"
													? "User"
													: server.scope === "project"
														? "Project"
														: "Plugin",
											)}{" "}
											· {t(stateLabel(server.state))}
											{server.pluginOwner && (
												<span className="plugins-from-owner-badge">{server.pluginOwner.displayName}</span>
											)}
										</span>
										<CaretRight aria-hidden="true" size={17} />
									</button>
								))
							)
						) : hooksState.status === "loading" ? (
							<output className="status-paragraph plugins-catalog-message">{t("Loading hooks…")}</output>
						) : hooksState.status === "error" ? (
							<div className="plugins-catalog-message" role="alert">
								<p>{hooksState.message}</p>
								<button onClick={() => setHooksRefresh((value) => value + 1)} type="button">
									{t("Retry")}
								</button>
							</div>
						) : visibleHooks.length === 0 ? (
							<CatalogEmptyState
								message={t(catalogFiltered ? "No matching results" : "No Hooks configured yet.")}
								description={t(
									catalogFiltered
										? "Try another search or clear the filters."
										: "Run a script automatically at a chosen point in a conversation.",
								)}
								actionLabel={t(catalogFiltered ? "Clear filters" : "New Hook")}
								disabled={!catalogFiltered && !serverReady}
								onAction={
									catalogFiltered
										? resetCatalogFilters
										: () => openDialog({ kind: "hook-editor", mode: "create" })
								}
							/>
						) : (
							visibleHooks.map((hook) => (
								<button
									aria-label={hook.name}
									aria-selected={hookCursor === hook.id}
									className="plugins-list-row plugins-hook-row"
									key={hook.id}
									onClick={() => {
										setPage({ kind: "hook", hookId: hook.id });
									}}
									onFocus={() => setHookCursor(hook.id)}
									role="option"
									type="button"
								>
									<span className="plugins-row-icon">
										<Lightning aria-hidden="true" size={22} />
									</span>
									<span className="plugins-row-copy">
										<strong>{hook.name}</strong>
										<small>
											{hook.command} {hook.runMode === "process" && hook.args ? hook.args.join(" ") : ""}
										</small>
									</span>
									<span className="plugins-row-meta">
										{t(eventLabelKey(hook.event))} · {hook.enabled ? t("Enabled") : t("Disabled")}
										{hook.pluginOwner && (
											<span className="plugins-from-owner-badge">{hook.pluginOwner.displayName}</span>
										)}
									</span>
									<CaretRight aria-hidden="true" size={17} />
								</button>
							))
						)}
					</CatalogList>
				</>
			)}
		</section>
	);

	let content = catalog;
	if (page.kind === "skill")
		content = (
			<section
				aria-busy={!skillDetail && !skillDetailError}
				className="plugins-detail-page"
				data-plugin-detail="skill"
			>
				<PluginBackButton label={t("Back to Skills")} onBack={() => setPage({ kind: "catalog" })} />
				{skillDetail ? (
					<>
						<header className="plugins-detail-header">
							<div>
								<h1 id="plugins-title" ref={detailHeading} tabIndex={-1}>
									{skillDetail.name}
								</h1>
								<p>{skillDetail.description}</p>
								<span>
									{t(sourceLabel(skillDetail.source))} · {t("Skill")} · {t("Available")}
								</span>
							</div>
							{skillDetail.pluginOwner ? (
								<div className="plugins-detail-actions">
									<button onClick={() => navigateToPlugin(skillDetail.pluginOwner!.pluginId)} type="button">
										{t("Manage Plugin")}
									</button>
								</div>
							) : skillDetail.editable ? (
								<div className="plugins-detail-actions">
									<button
										onClick={(event) =>
											openDialog(
												{
													kind: "skill-editor",
													mode: "edit",
													source: skillDetail.source as WritableSkillSourceView,
													cwd: page.cwd,
													initial: skillDetail,
												},
												event.currentTarget,
											)
										}
										type="button"
									>
										<PencilSimple aria-hidden="true" size={17} />
										{t("Edit")}
									</button>
									<button
										onClick={() =>
											void api
												.openSkillFolder({
													cwd: page.cwd,
													source: skillDetail.source,
													name: skillDetail.name,
												})
												.catch((cause) => setSkillDetailError(message(cause)))
										}
										type="button"
									>
										<FolderOpen aria-hidden="true" size={17} />
										{t("Open containing folder")}
									</button>
									<button
										className="plugins-danger-action"
										onClick={(event) =>
											openDialog(
												{ kind: "skill-remove", skill: skillDetail, cwd: page.cwd },
												event.currentTarget,
											)
										}
										type="button"
									>
										<Trash aria-hidden="true" size={17} />
										{t("Delete")}
									</button>
								</div>
							) : null}
						</header>
						{skillDetailError && (
							<p className="plugins-detail-error" role="alert">
								{skillDetailError}
							</p>
						)}
						<div className="plugins-detail-grid">
							<article className="plugins-detail-document">
								<Markdown text={skillDetail.instructions} />
							</article>
							<aside className="plugins-detail-meta">
								<dl>
									<dt>{t("Scope")}</dt>
									<dd>{t(sourceLabel(skillDetail.source))}</dd>
									{skillDetail.pluginOwner && (
										<>
											<dt>{t("Plugin")}</dt>
											<dd>
												<button
													className="plugins-link-btn"
													onClick={() => navigateToPlugin(skillDetail.pluginOwner!.pluginId)}
													type="button"
												>
													{skillDetail.pluginOwner.displayName}
												</button>
											</dd>
										</>
									)}
									<dt>{t("Local path")}</dt>
									<dd>
										<code>{skillDetail.directoryPath}</code>
									</dd>
									<dt>{t("Entry file")}</dt>
									<dd>{skillDetail.entryFile}</dd>
									<dt>{t("Included files")}</dt>
									<dd>
										<ul>
											{skillDetail.files.map((file) => (
												<li key={file}>{file}</li>
											))}
										</ul>
									</dd>
									<dt>{t("Last updated")}</dt>
									<dd>{new Date(skillDetail.updatedAt).toLocaleString(localeForIntl())}</dd>
								</dl>
							</aside>
						</div>
					</>
				) : skillDetailError ? (
					<div className="plugins-detail-load-error" role="alert">
						<p>{skillDetailError}</p>
						<button onClick={() => setPage({ ...page })} type="button">
							{t("Retry")}
						</button>
					</div>
				) : (
					<output className="status-paragraph plugins-detail-loading">{t("Loading Skill…")}</output>
				)}
			</section>
		);
	if (page.kind === "mcp")
		content = (
			<section aria-busy={!mcpDetail && !mcpDetailError} className="plugins-detail-page" data-plugin-detail="mcp">
				<PluginBackButton label={t("Back to MCP")} onBack={() => setPage({ kind: "catalog" })} />
				{mcpDetail ? (
					<McpDetail
						actionsEnabled={Boolean(mcpSessionId)}
						detail={mcpDetail}
						detailError={mcpDetailError}
						headingRef={detailHeading}
						onCatalogItem={(kind, id) => {
							if (!mcpSessionId)
								return Promise.reject(new Error(t("Open a task to view MCP capability details.")));
							return api.getMcpCatalogItem({ sessionId: mcpSessionId, server: mcpDetail.server.name, kind, id });
						}}
						onClear={(server) => void liveAction("clear", server)}
						onCredential={(server, trigger) => {
							if (mcpSessionId) openDialog({ kind: "credential", server, sessionId: mcpSessionId }, trigger);
						}}
						onEdit={(server, trigger) =>
							openDialog(
								{ kind: "server", mode: "edit", scope: server.scope, server, target: page.target },
								trigger,
							)
						}
						onManagePlugin={(pluginId) => navigateToPlugin(pluginId)}
						onRemove={(server, trigger) => openDialog({ kind: "remove", server, target: page.target }, trigger)}
						onRestart={(server) => void liveAction("restart", server)}
						pendingAction={pendingAction}
						refreshedAt={mcpRefreshedAt}
					/>
				) : mcpDetailError ? (
					<div className="plugins-detail-load-error" role="alert">
						<p>{mcpDetailError}</p>
						<button onClick={() => setPage({ ...page })} type="button">
							{t("Retry")}
						</button>
					</div>
				) : (
					<output className="status-paragraph plugins-detail-loading">{t("Loading MCP server…")}</output>
				)}
			</section>
		);
	if (page.kind === "hook")
		content = (
			<section
				aria-busy={!selectedHook || hookControlsDisabled}
				className="plugins-detail-page"
				data-plugin-detail="hook"
			>
				<PluginBackButton label={t("Back to Hooks")} onBack={() => setPage({ kind: "catalog" })} />
				{selectedHook ? (
					<>
						<header className="plugins-detail-header">
							<div>
								<h1 id="plugins-title" ref={detailHeading} tabIndex={-1}>
									{selectedHook.name}
								</h1>
								<p>{selectedHook.statusMessage || selectedHook.command}</p>
								<span>
									{selectedHook.protocol ?? "legacy"} · {t(eventLabelKey(selectedHook.event))} ·{" "}
									{selectedHook.runMode === "shell" ? t("Shell command") : t("Direct process")} ·{" "}
									{selectedHook.enabled ? t("Enabled") : t("Disabled")}
								</span>
							</div>
							<div className="plugins-detail-actions">
								{selectedHook.pluginOwner ? (
									<button onClick={() => navigateToPlugin(selectedHook.pluginOwner!.pluginId)} type="button">
										{t("Manage Plugin")}
									</button>
								) : (
									<>
										<button
											disabled={hookControlsDisabled}
											onClick={() => void toggleHookEnabled(selectedHook)}
											type="button"
										>
											{selectedHook.enabled ? (
												<XCircle aria-hidden="true" size={17} />
											) : (
												<CheckCircle aria-hidden="true" size={17} />
											)}
											{hookTogglePending
												? t("Updating…")
												: selectedHook.enabled
													? t("Disable")
													: t("Enable")}
										</button>
										<button
											disabled={hookControlsDisabled}
											onClick={(event) =>
												openDialog(
													{ kind: "hook-editor", mode: "edit", initial: selectedHook },
													event.currentTarget,
												)
											}
											type="button"
										>
											<PencilSimple aria-hidden="true" size={17} />
											{t("Edit")}
										</button>
										<button
											className="plugins-danger-action"
											disabled={hookControlsDisabled}
											onClick={(event) =>
												openDialog({ kind: "hook-remove", hook: selectedHook }, event.currentTarget)
											}
											type="button"
										>
											<Trash aria-hidden="true" size={17} />
											{t("Delete")}
										</button>
									</>
								)}
							</div>
						</header>
						{hookActionError && (
							<p className="plugins-detail-error" role="alert">
								{hookActionError}
							</p>
						)}
						<div className="plugins-detail-grid">
							<article className="plugins-detail-document">
								<h3>{t("Command")}</h3>
								<pre className="plugins-hook-command-preview">
									<code>
										{selectedHook.command} {selectedHook.args?.join(" ")}
									</code>
								</pre>
								<h3>{t("Event effect")}</h3>
								<p>{t(eventEffectKey(selectedHook.event, selectedHook.protocol))}</p>
								<h3>{t("Execution timing")}</h3>
								<p>{t(eventTimingKey(selectedHook.event, selectedHook.protocol))}</p>
								{selectedHook.statusMessage && (
									<>
										<h3>{t("Status message")}</h3>
										<p>{selectedHook.statusMessage}</p>
									</>
								)}
								{selectedHook.matcher && (
									<>
										<h3>{t("Tool matcher")}</h3>
										<p>
											<code>{selectedHook.matcher}</code>
										</p>
									</>
								)}
								{selectedHook.metadata && Object.keys(selectedHook.metadata).length > 0 && (
									<>
										<h3>{t("Custom fields")}</h3>
										<pre className="plugins-hook-command-preview">
											<code>{JSON.stringify(selectedHook.metadata, null, 2)}</code>
										</pre>
									</>
								)}
							</article>
							<aside className="plugins-detail-meta">
								<dl>
									<dt>{t("Protocol")}</dt>
									<dd>{selectedHook.protocol ?? "legacy"}</dd>
									<dt>{t("Event")}</dt>
									<dd>{t(eventLabelKey(selectedHook.event))}</dd>
									{selectedHook.pluginOwner && (
										<>
											<dt>{t("Plugin")}</dt>
											<dd>
												<button
													className="plugins-link-btn"
													onClick={() => navigateToPlugin(selectedHook.pluginOwner!.pluginId)}
													type="button"
												>
													{selectedHook.pluginOwner.displayName}
												</button>
											</dd>
										</>
									)}
									<dt>{t("Run mode")}</dt>
									<dd>{selectedHook.runMode === "shell" ? t("Shell command") : t("Direct process")}</dd>
									<dt>{t("Timeout")}</dt>
									<dd>
										{selectedHook.timeoutSeconds ? `${selectedHook.timeoutSeconds}s` : t("Default (60s)")}
									</dd>
									<dt>{t("Status")}</dt>
									<dd>{selectedHook.enabled ? t("Active") : t("Disabled")}</dd>
								</dl>
							</aside>
						</div>
					</>
				) : (
					<output className="status-paragraph plugins-detail-loading">{t("Loading hook…")}</output>
				)}
			</section>
		);

	return (
		<section aria-labelledby="plugins-title" className="plugins-panel">
			{content}
			{dialog?.kind === "skill-create" && (
				<SkillCreationDialog
					initialCwd={dialog.initialCwd}
					onCancel={closeDialog}
					onChooseProject={() => api.selectProjectFolder()}
					onCreateWithMetis={onCreateSkillWithMetis}
					onCustom={(target) =>
						setDialog({ kind: "skill-editor", mode: "create", source: target.source, cwd: target.cwd })
					}
					onImported={async (target, input, inspection, candidateIds) => {
						const result = await api.importSkills({
							requestId: crypto.randomUUID(),
							...target,
							input,
							sourceRevision: inspection.revision,
							candidateIds: [...candidateIds],
						});
						setSkillsState({ status: "success", value: result.skills });
						setDialog(null);
						onSkillsChanged();
					}}
					onInspect={(target, input) => api.inspectSkillImport({ ...target, input })}
					onPickFiles={() => api.selectAttachmentFiles()}
					onResolveDroppedFiles={(files) => api.resolveDroppedFiles(files)}
					projects={projects}
					source={dialog.source}
				/>
			)}
			{dialog?.kind === "skill-editor" && (
				<SkillEditorDialog
					error={dialogError}
					initial={dialog.initial}
					key={`${dialog.mode}:${dialog.initial?.revision ?? dialog.source}`}
					mode={dialog.mode}
					onCancel={closeDialog}
					onSubmit={(name, skillContent) => void submitSkill(name, skillContent)}
					pending={pendingAction === "skill"}
					source={dialog.source}
				/>
			)}
			{dialog?.kind === "skill-remove" && (
				<RemoveSkillDialog
					error={dialogError}
					onCancel={closeDialog}
					onRemove={() => void removeSkill(dialog.skill, dialog.cwd)}
					pending={pendingAction === "skill-remove"}
					skill={dialog.skill}
				/>
			)}
			{dialog?.kind === "mcp-create" && (
				<McpCreationDialog
					initialCwd={dialog.initialCwd}
					onCancel={closeDialog}
					onChooseProject={() => api.selectProjectFolder()}
					onImport={importMcpCreation}
					onInspect={inspectMcpCreation}
					onSave={createMcpServer}
					projects={projects}
					scope={dialog.scope}
				/>
			)}
			{dialog?.kind === "server" && (
				<EditMcpServerDialog
					error={dialogError}
					key={`${dialog.mode}:${dialog.server.revision}`}
					onCancel={closeDialog}
					onSubmit={(draft) => void submitServer(draft)}
					pending={pendingAction === "server"}
					server={dialog.server}
				/>
			)}
			{dialog?.kind === "credential" && (
				<McpCredentialDialog
					error={dialogError}
					onCancel={closeDialog}
					onSubmit={(credential) => void setCredential(dialog.server, dialog.sessionId, credential)}
					pending={pendingAction === "credential"}
					server={dialog.server}
				/>
			)}
			{dialog?.kind === "remove" && (
				<RemoveMcpDialog
					error={dialogError}
					onCancel={closeDialog}
					onRemove={() => void removeServer(dialog.server, dialog.target)}
					pending={pendingAction === "remove"}
					server={dialog.server}
				/>
			)}
			{dialog?.kind === "hook-editor" && (
				<HookEditorDialog
					error={dialogError}
					initial={dialog.initial}
					key={`${dialog.mode}:${dialog.initial?.id ?? "new"}`}
					mode={dialog.mode}
					onCancel={closeDialog}
					onSubmit={(draft) => void submitHook(draft)}
					pending={pendingAction === "hook"}
				/>
			)}
			{dialog?.kind === "hook-remove" && (
				<RemoveHookDialog
					error={dialogError}
					hook={dialog.hook}
					onCancel={closeDialog}
					onRemove={() => void removeHook(dialog.hook)}
					pending={pendingAction === "hook-remove"}
				/>
			)}
		</section>
	);
}

function McpDetail({
	actionsEnabled,
	detail,
	detailError,
	headingRef,
	onCatalogItem,
	onClear,
	onCredential,
	onEdit,
	onManagePlugin,
	onRemove,
	onRestart,
	pendingAction,
	refreshedAt,
}: {
	readonly actionsEnabled: boolean;
	readonly detail: McpServerDetailView;
	readonly detailError: string | null;
	readonly headingRef: RefObject<HTMLHeadingElement | null>;
	readonly onCatalogItem: (kind: McpCatalogItemKindView, id: string) => Promise<McpCatalogItemDetailView>;
	readonly onClear: (server: McpServerSummaryView) => void;
	readonly onCredential: (server: McpServerSummaryView, trigger: HTMLButtonElement) => void;
	readonly onEdit: (server: McpServerSummaryView, trigger: HTMLButtonElement) => void;
	readonly onManagePlugin?: (pluginId: string) => void;
	readonly onRemove: (server: McpServerSummaryView, trigger: HTMLButtonElement) => void;
	readonly onRestart: (server: McpServerSummaryView) => void;
	readonly pendingAction: string | null;
	readonly refreshedAt: string | null;
}) {
	const { t } = useTranslation();
	const server = detail.server;
	const busy = pendingAction !== null;
	const [catalogItem, setCatalogItem] = useState<McpCatalogItemDetailView | null>(null);
	const [catalogBusy, setCatalogBusy] = useState(false);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const catalogGeneration = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies(server.revision): Server configuration changes invalidate the selected catalog item.
	// biome-ignore lint/correctness/useExhaustiveDependencies(server.name): Switching MCP servers invalidates the selected catalog item.
	useEffect(() => {
		catalogGeneration.current += 1;
		setCatalogItem(null);
		setCatalogBusy(false);
		setCatalogError(null);
		return () => {
			catalogGeneration.current += 1;
		};
	}, [server.name, server.revision]);
	const loadCatalogItem = async (kind: McpCatalogItemKindView, id: string) => {
		if (catalogBusy) return;
		if (catalogItem?.kind === kind && catalogItem.id === id) {
			catalogGeneration.current += 1;
			setCatalogItem(null);
			setCatalogError(null);
			return;
		}
		setCatalogBusy(true);
		setCatalogError(null);
		const generation = ++catalogGeneration.current;
		try {
			const item = await onCatalogItem(kind, id);
			if (generation === catalogGeneration.current) setCatalogItem(item);
		} catch (cause) {
			if (generation === catalogGeneration.current) {
				setCatalogItem(null);
				setCatalogError(message(cause));
			}
		} finally {
			if (generation === catalogGeneration.current) setCatalogBusy(false);
		}
	};
	return (
		<>
			<header className="plugins-detail-header">
				<div>
					<h1 id="plugins-title" ref={headingRef} tabIndex={-1}>
						{server.name}
					</h1>
					<p>{server.transport === "http" ? server.url : server.command}</p>
					<span>
						{t(server.scope === "plugin" ? "Plugin" : server.scope === "user" ? "User" : "Project")} ·{" "}
						{t(stateLabel(server.state))}
					</span>
				</div>
				<div className="plugins-detail-actions">
					{server.pluginOwner ? (
						<>
							{onManagePlugin && (
								<button onClick={() => onManagePlugin(server.pluginOwner!.pluginId)} type="button">
									{t("Manage Plugin")}
								</button>
							)}
							{actionsEnabled && server.effective && (
								<>
									<button disabled={busy} onClick={() => onRestart(server)} type="button">
										<ArrowsClockwise aria-hidden="true" size={17} />
										{t(pendingAction === "restart" ? "Restarting…" : "Restart")}
									</button>
									<button
										disabled={busy}
										onClick={(event) => onCredential(server, event.currentTarget)}
										type="button"
									>
										<Key aria-hidden="true" size={17} />
										{t("Authentication")}
									</button>
									{server.credentialConfigured && (
										<button disabled={busy} onClick={() => onClear(server)} type="button">
											{t(pendingAction === "clear" ? "Clearing…" : "Clear authentication")}
										</button>
									)}
								</>
							)}
						</>
					) : (
						<>
							<button
								aria-label={t("Edit MCP server")}
								disabled={busy}
								onClick={(event) => onEdit(server, event.currentTarget)}
								type="button"
							>
								<PencilSimple aria-hidden="true" size={17} />
								{t("Edit")}
							</button>
							{actionsEnabled && server.effective && (
								<>
									<button disabled={busy} onClick={() => onRestart(server)} type="button">
										<ArrowsClockwise aria-hidden="true" size={17} />
										{t(pendingAction === "restart" ? "Restarting…" : "Restart")}
									</button>
									<button
										disabled={busy}
										onClick={(event) => onCredential(server, event.currentTarget)}
										type="button"
									>
										<Key aria-hidden="true" size={17} />
										{t("Authentication")}
									</button>
									{server.credentialConfigured && (
										<button disabled={busy} onClick={() => onClear(server)} type="button">
											{t(pendingAction === "clear" ? "Clearing…" : "Clear authentication")}
										</button>
									)}
								</>
							)}
							<button
								className="plugins-danger-action"
								disabled={busy}
								onClick={(event) => onRemove(server, event.currentTarget)}
								type="button"
							>
								<Trash aria-hidden="true" size={17} />
								{t("Delete")}
							</button>
						</>
					)}
				</div>
			</header>
			{!actionsEnabled && (
				<p className="plugins-detail-note">
					{t("Open a task in this project to view live status, restart, or change authentication.")}
				</p>
			)}
			{detailError && (
				<p className="plugins-detail-error" role="alert">
					{detailError}
				</p>
			)}
			{server.lastError && (
				<p className="plugins-detail-error" role="alert">
					{server.lastError}
				</p>
			)}
			<div className="plugins-detail-grid">
				<article className="plugins-detail-document">
					<h2>{t("Connection configuration")}</h2>
					<McpConfiguration server={server} />
					{catalogError && (
						<p className="mcp-catalog-item-error" role="alert">
							{catalogError}
						</p>
					)}
					<DetailList
						active={catalogItem}
						busy={catalogBusy}
						kind="tool"
						label={t("Tools")}
						onSelect={(kind, id) => void loadCatalogItem(kind, id)}
						values={detail.tools}
					/>
					<DetailList
						active={catalogItem}
						busy={catalogBusy}
						kind="prompt"
						label={t("Prompts")}
						onSelect={(kind, id) => void loadCatalogItem(kind, id)}
						values={detail.prompts}
					/>
					{(detail.resources.length > 0 || detail.resourceTemplates.length > 0) && (
						<h2 className="plugins-secondary-heading">{t("Additional information")}</h2>
					)}
					<DetailList
						active={catalogItem}
						busy={catalogBusy}
						kind="resource"
						label={t("Resources")}
						onSelect={(kind, id) => void loadCatalogItem(kind, id)}
						values={detail.resources}
					/>
					<DetailList
						active={catalogItem}
						busy={catalogBusy}
						kind="resourceTemplate"
						label={t("Resource templates")}
						onSelect={(kind, id) => void loadCatalogItem(kind, id)}
						values={detail.resourceTemplates}
					/>
				</article>
				<aside className="plugins-detail-meta">
					<dl>
						<dt>{t("Scope")}</dt>
						<dd>{t(server.scope === "plugin" ? "Plugin" : server.scope === "user" ? "User" : "Project")}</dd>
						{server.pluginOwner && (
							<>
								<dt>{t("Plugin")}</dt>
								<dd>
									{onManagePlugin ? (
										<button
											className="plugins-link-btn"
											onClick={() => onManagePlugin(server.pluginOwner!.pluginId)}
											type="button"
										>
											{server.pluginOwner.displayName}
										</button>
									) : (
										server.pluginOwner.displayName
									)}
								</dd>
							</>
						)}
						<dt>{t("Status")}</dt>
						<dd>{t(stateLabel(server.state))}</dd>
						<dt>{t("Authentication")}</dt>
						<dd>{t(server.credentialConfigured ? "Configured" : "Not configured")}</dd>
						<dt>{t("Tools")}</dt>
						<dd>{server.toolCount}</dd>
						<dt>{t("Prompts")}</dt>
						<dd>{server.promptCount}</dd>
						<dt>{t("Resources")}</dt>
						<dd>{server.resourceCount}</dd>
						<dt>{t("Last refreshed")}</dt>
						<dd>{refreshedAt ? new Date(refreshedAt).toLocaleString(localeForIntl()) : "—"}</dd>
					</dl>
				</aside>
			</div>
		</>
	);
}
