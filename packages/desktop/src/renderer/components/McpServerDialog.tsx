import type { ClientParams, McpServerSummaryView } from "@metis/app-protocol";
import { Plus, Trash, X } from "@phosphor-icons/react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogFrame } from "./ProjectActions.tsx";
import { MenuSelect } from "./MenuSelect.tsx";

type McpServerInput = ClientParams<"mcp/upsert">["server"];
type McpCredentialInput = NonNullable<ClientParams<"mcp/upsert">["credential"]>;

export interface McpServerDraft {
	readonly name: string;
	readonly server: McpServerInput;
	readonly credential?: McpCredentialInput;
}

interface SecretRow {
	readonly id: string;
	readonly name: string;
	readonly value: string;
}

interface HeaderRow extends SecretRow {
	readonly header: string;
}

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function lines(value: string): string[] {
	return [...new Set(value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))];
}

function positive(value: string): number | undefined {
	if (!value.trim()) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Timeouts must be positive numbers.");
	return parsed;
}

function mappings(value: string): Record<string, string> | undefined {
	const entries = lines(value).map((line) => {
		const separator = line.indexOf("=");
		if (separator <= 0 || separator === line.length - 1) throw new Error("Use Header=ENV_VAR for HTTP headers.");
		const entry = [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
		if (!environmentName.test(entry[1])) throw new Error("Header environment names must be valid environment variable names.");
		return entry;
	});
	if (new Set(entries.map(([header]) => header.toLowerCase())).size !== entries.length) throw new Error("Header names must be unique.");
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function completeCredential(bearerToken: string, rows: readonly SecretRow[]): {
	readonly credential?: McpCredentialInput;
	readonly valid: boolean;
} {
	const populated = rows.filter((row) => row.value);
	const names = populated.map((row) => row.name.trim());
	if (names.some((name) => !environmentName.test(name)) || new Set(names).size !== names.length) return { valid: false };
	const environment = Object.fromEntries(populated.map((row) => [row.name.trim(), row.value]));
	if (!bearerToken && names.length === 0) return { valid: true };
	return {
		credential: { ...(bearerToken ? { bearerToken } : {}), ...(names.length ? { environment } : {}) },
		valid: true,
	};
}

export function McpCredentialFields({ disabled, onChange, onValidityChange, suggestedEnvironmentNames, transport }: {
	readonly disabled: boolean;
	readonly onChange: (value: McpCredentialInput | undefined) => void;
	readonly onValidityChange: (valid: boolean) => void;
	readonly suggestedEnvironmentNames: readonly string[];
	readonly transport: "stdio" | "http";
}) {
	const { t } = useTranslation();
	const [bearerToken, setBearerToken] = useState("");
	const [rows, setRows] = useState<SecretRow[]>(() =>
		[...new Set(suggestedEnvironmentNames)].map((name) => ({ id: crypto.randomUUID(), name, value: "" })),
	);
	const commit = (nextBearer: string, nextRows: SecretRow[]) => {
		const next = completeCredential(nextBearer, nextRows);
		onChange(next.credential);
		onValidityChange(next.valid);
	};
	const update = (id: string, patch: Partial<SecretRow>) => {
		const next = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
		setRows(next);
		commit(bearerToken, next);
	};
	return <fieldset className="mcp-secret-fields">
		<legend>{t("Credentials")}</legend>
		{transport === "http" && <label>{t("Bearer token (optional)")}<input autoComplete="off" disabled={disabled} onChange={(event) => { setBearerToken(event.target.value); commit(event.target.value, rows); }} type="password" value={bearerToken} /></label>}
		<div className="mcp-secret-list">
			{rows.map((row) => <div className="mcp-secret-row" key={row.id}>
				<label>{t("Variable name")}<input autoComplete="off" disabled={disabled} onChange={(event) => update(row.id, { name: event.target.value })} value={row.name} /></label>
				<label>{t("Secret value")}<input autoComplete="off" disabled={disabled} onChange={(event) => update(row.id, { value: event.target.value })} type="password" value={row.value} /></label>
				<button aria-label={t("Remove secret")} disabled={disabled} onClick={() => { const next = rows.filter((item) => item.id !== row.id); setRows(next); commit(bearerToken, next); }} type="button"><Trash aria-hidden="true" size={15} /></button>
			</div>)}
		</div>
		<button className="mcp-add-row" disabled={disabled || rows.length >= 128} onClick={() => setRows((current) => [...current, { id: crypto.randomUUID(), name: "", value: "" }])} type="button"><Plus aria-hidden="true" size={15} />{t("Add secret")}</button>
	</fieldset>;
}

async function derivedHeaderEnvironment(name: string, header: string): Promise<string> {
	const normalized = name.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").replace(/^[^A-Z_]+/u, "").slice(0, 200) || "SERVER";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(header.toLowerCase()));
	const hash = [...new Uint8Array(digest).slice(0, 4)].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
	return `METIS_MCP_${normalized}_${hash}`;
}

export function McpServerForm({ error, onCancel, onSubmit, pending, server, variant }: {
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onSubmit: (draft: McpServerDraft) => void;
	readonly pending: boolean;
	readonly server?: McpServerSummaryView;
	readonly variant: "url" | "custom" | "edit";
}) {
	const { t } = useTranslation();
	const [name, setName] = useState(server?.name ?? "");
	const [description, setDescription] = useState(server?.description ?? "");
	const nameEdited = useRef(Boolean(server?.name));
	const [transport, setTransport] = useState<"stdio" | "http">(variant === "edit" ? server?.transport ?? "stdio" : "http");
	const [command, setCommand] = useState(server?.command ?? "");
	const [args, setArgs] = useState(server?.args?.join("\n") ?? "");
	const [envVars, setEnvVars] = useState(server?.envVars?.join("\n") ?? "");
	const [cwd, setCwd] = useState(server?.cwd ?? "");
	const [url, setUrl] = useState(server?.url ?? "");
	const [bearerTokenEnvVar, setBearerTokenEnvVar] = useState(server?.bearerTokenEnvVar ?? "");
	const [headers, setHeaders] = useState(Object.entries(server?.envHttpHeaders ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"));
	const [quickHeaders, setQuickHeaders] = useState<HeaderRow[]>([]);
	const [credential, setCredential] = useState<McpCredentialInput>();
	const [credentialValid, setCredentialValid] = useState(true);
	const [enabled, setEnabled] = useState(server?.enabled ?? true);
	const [required, setRequired] = useState(server?.required ?? false);
	const [startupTimeout, setStartupTimeout] = useState(server?.startupTimeoutSec?.toString() ?? "");
	const [toolTimeout, setToolTimeout] = useState(server?.toolTimeoutSec?.toString() ?? "");
	const [localError, setLocalError] = useState<string | null>(null);
	const suggestedNames = useMemo(
		() => [...new Set([...(server?.envVars ?? []), ...(server?.bearerTokenEnvVar ? [server.bearerTokenEnvVar] : []), ...Object.values(server?.envHttpHeaders ?? {})])],
		[server],
	);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		try {
			if (!name.trim()) throw new Error("Name and transport settings are required.");
			if (!credentialValid) throw new Error("Credential variable names must be valid and unique.");
			const startupTimeoutSec = positive(startupTimeout);
			const toolTimeoutSec = positive(toolTimeout);
			const descriptionField = description.trim() ? { description: description.trim() } : {};
			const common = variant === "edit"
				? { ...descriptionField, enabled, required, ...(startupTimeoutSec ? { startupTimeoutSec } : {}), ...(toolTimeoutSec ? { toolTimeoutSec } : {}) }
				: descriptionField;
			let serverInput: McpServerInput;
			let nextCredential = credential;
			if (transport === "stdio") {
				if (!command.trim()) throw new Error("Name and transport settings are required.");
				serverInput = { ...common, transport, command: command.trim(), ...(lines(args).length ? { args: lines(args) } : {}), ...(lines(envVars).length ? { envVars: lines(envVars) } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) };
			} else {
				if (!url.trim()) throw new Error("Name and transport settings are required.");
				const parsedUrl = new URL(url.trim());
				if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error("MCP URL must use HTTP(S) and must not contain credentials.");
				const envHttpHeaders = { ...(mappings(headers) ?? {}) };
				const literalEnvironment = { ...(nextCredential?.environment ?? {}) };
				const quickHeaderNames = quickHeaders.filter((row) => row.header.trim()).map((row) => row.header.trim().toLowerCase());
				if (new Set(quickHeaderNames).size !== quickHeaderNames.length) throw new Error("Header names must be unique.");
				for (const row of quickHeaders) {
					if (!row.header.trim()) {
						if (row.name.trim() || row.value) throw new Error("Header name is required when a header credential is provided.");
						continue;
					}
					const environmentName = row.name.trim() || await derivedHeaderEnvironment(name.trim(), row.header.trim());
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environmentName)) throw new Error("Header environment names must be valid environment variable names.");
					envHttpHeaders[row.header.trim()] = environmentName;
					if (row.value) literalEnvironment[environmentName] = row.value;
				}
				nextCredential = nextCredential?.bearerToken || Object.keys(literalEnvironment).length ? { ...(nextCredential?.bearerToken ? { bearerToken: nextCredential.bearerToken } : {}), ...(Object.keys(literalEnvironment).length ? { environment: literalEnvironment } : {}) } : undefined;
				serverInput = { ...common, transport, url: url.trim(), ...(bearerTokenEnvVar.trim() ? { bearerTokenEnvVar: bearerTokenEnvVar.trim() } : {}), ...(Object.keys(envHttpHeaders).length ? { envHttpHeaders } : {}) };
			}
			setLocalError(null);
			onSubmit({ name: name.trim(), server: serverInput, ...(nextCredential ? { credential: nextCredential } : {}) });
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : "The MCP server could not be saved.");
		}
	};
	return <form className="mcp-server-form" onSubmit={(event) => void submit(event)}>
		<div className="mcp-dialog-grid">
			<label>{t(variant === "custom" ? "Server name" : "Name")}<input disabled={Boolean(server) || pending} onChange={(event) => { nameEdited.current = true; setName(event.target.value); }} value={name} /></label>
			{variant !== "url" && <label>{t("Transport")}<MenuSelect ariaLabel={t("Transport")} disabled={pending} onChange={setTransport} options={variant === "custom" ? [{ value: "http", label: "HTTP" }, { value: "stdio", label: "STDIO" }] : [{ value: "stdio", label: t("Local command") }, { value: "http", label: t("Streamable HTTP") }]} value={transport} /></label>}
			<label className="mcp-dialog-wide mcp-description-field">{t("Description (optional)")}<textarea disabled={pending} onChange={(event) => setDescription(event.target.value)} value={description} /></label>
			{transport === "stdio" ? <>
				<label className="mcp-dialog-wide">{t("Command")}<input disabled={pending} onChange={(event) => setCommand(event.target.value)} value={command} /></label>
				<label>{t("Arguments, one per line")}<textarea disabled={pending} onChange={(event) => setArgs(event.target.value)} value={args} /></label>
				<label>{t("Forwarded variable names, one per line")}<textarea disabled={pending} onChange={(event) => setEnvVars(event.target.value)} value={envVars} /></label>
				<label className="mcp-dialog-wide">{t("Working directory")}<input disabled={pending} onChange={(event) => setCwd(event.target.value)} value={cwd} /></label>
			</> : <>
				<label className="mcp-dialog-wide">{t("Server URL")}<input disabled={pending} onBlur={() => { if (nameEdited.current) return; try { setName(new URL(url).hostname); } catch { /* keep blank */ } }} onChange={(event) => setUrl(event.target.value)} type="url" value={url} /></label>
				{variant === "edit" && <><label>{t("Bearer token environment variable")}<input disabled={pending} onChange={(event) => setBearerTokenEnvVar(event.target.value)} value={bearerTokenEnvVar} /></label><label>{t("HTTP headers")}<textarea disabled={pending} onChange={(event) => setHeaders(event.target.value)} placeholder="X-Tenant=MCP_TENANT" value={headers} /></label></>}
			</>}
			{variant === "edit" && <><label>{t("Startup timeout (seconds)")}<input disabled={pending} min="0.001" onChange={(event) => setStartupTimeout(event.target.value)} step="any" type="number" value={startupTimeout} /></label><label>{t("Tool timeout (seconds)")}<input disabled={pending} min="0.001" onChange={(event) => setToolTimeout(event.target.value)} step="any" type="number" value={toolTimeout} /></label></>}
		</div>
		{variant !== "edit" && transport === "http" && <fieldset className="mcp-quick-headers"><legend>{t("Custom headers (optional)")}</legend>{quickHeaders.map((row) => <div className="mcp-quick-header-row" key={row.id}><label>{t("Header name")}<input disabled={pending} onChange={(event) => setQuickHeaders((current) => current.map((item) => item.id === row.id ? { ...item, header: event.target.value } : item))} value={row.header} /></label><label>{t("Environment name (optional)")}<input disabled={pending} onChange={(event) => setQuickHeaders((current) => current.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} value={row.name} /></label><label>{t("Secret value")}<input autoComplete="off" disabled={pending} onChange={(event) => setQuickHeaders((current) => current.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} type="password" value={row.value} /></label><button aria-label={t("Remove header")} disabled={pending} onClick={() => setQuickHeaders((current) => current.filter((item) => item.id !== row.id))} type="button"><Trash aria-hidden="true" size={15} /></button></div>)}<button className="mcp-add-row" disabled={pending || quickHeaders.length >= 128} onClick={() => setQuickHeaders((current) => [...current, { id: crypto.randomUUID(), header: "", name: "", value: "" }])} type="button"><Plus aria-hidden="true" size={15} />{t("Add header")}</button></fieldset>}
		{(variant !== "custom" || transport === "stdio") && <McpCredentialFields disabled={pending} onChange={setCredential} onValidityChange={setCredentialValid} suggestedEnvironmentNames={suggestedNames} transport={transport} />}
		{variant === "edit" && <div className="mcp-dialog-checks"><label><input checked={enabled} disabled={pending} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />{t("Enabled")}</label><label><input checked={required} disabled={pending} onChange={(event) => setRequired(event.target.checked)} type="checkbox" />{t("Required")}</label></div>}
		{(localError || error) && <p className="mcp-dialog-error" role="alert">{t(localError || error || "")}</p>}
		<div className="mcp-dialog-actions"><button className="button-secondary" disabled={pending} onClick={onCancel} type="button">{t("Cancel")}</button><button disabled={pending} type="submit">{t(pending ? (variant === "url" ? "Inspecting…" : "Saving…") : (variant === "url" ? "Inspect" : "Save"))}</button></div>
	</form>;
}

export function McpServerDialog({ error, onCancel, onSubmit, pending, server }: {
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onSubmit: (draft: McpServerDraft) => void;
	readonly pending: boolean;
	readonly server: McpServerSummaryView;
}) {
	const { t } = useTranslation();
	const close = useRef<HTMLButtonElement>(null);
	return <DialogFrame cancellable={!pending} className="mcp-dialog" descriptionId="mcp-server-description" initialFocus={close} onCancel={onCancel} titleId="mcp-server-title"><button aria-label={t("Close")} className="mcp-dialog-close" disabled={pending} onClick={onCancel} ref={close} type="button"><X aria-hidden="true" size={17} /></button><h2 id="mcp-server-title">{t("Edit MCP server")}</h2><p id="mcp-server-description">{t("Configure a local command or remote HTTP MCP server.")}</p><McpServerForm error={error} onCancel={onCancel} onSubmit={onSubmit} pending={pending} server={server} variant="edit" /></DialogFrame>;
}

export function McpCredentialDialog({ error, onCancel, onSubmit, pending, server }: {
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onSubmit: (credential: McpCredentialInput) => void;
	readonly pending: boolean;
	readonly server: McpServerSummaryView;
}) {
	const { t } = useTranslation();
	const close = useRef<HTMLButtonElement>(null);
	const [credential, setCredential] = useState<McpCredentialInput>();
	const [credentialValid, setCredentialValid] = useState(true);
	const suggested = [...new Set([...(server.envVars ?? []), ...(server.bearerTokenEnvVar ? [server.bearerTokenEnvVar] : []), ...Object.values(server.envHttpHeaders ?? {})])];
	return <DialogFrame cancellable={!pending} className="mcp-dialog mcp-credential-dialog" descriptionId="mcp-credential-description" initialFocus={close} onCancel={onCancel} titleId="mcp-credential-title"><button aria-label={t("Close")} className="mcp-dialog-close" disabled={pending} onClick={onCancel} ref={close} type="button"><X aria-hidden="true" size={17} /></button><h2 id="mcp-credential-title">{t("Set authentication")}</h2><p id="mcp-credential-description">{t("Saving replaces the stored credentials. Secret values are never returned to this page.")}</p><div className="mcp-credential-form"><McpCredentialFields disabled={pending} onChange={setCredential} onValidityChange={setCredentialValid} suggestedEnvironmentNames={suggested} transport={server.transport} />{!credentialValid && <p className="mcp-dialog-error" role="alert">{t("Credential variable names must be valid and unique.")}</p>}{error && <p className="mcp-dialog-error" role="alert">{error}</p>}<div className="mcp-dialog-actions"><button className="button-secondary" disabled={pending} onClick={onCancel} type="button">{t("Cancel")}</button><button disabled={pending || !credential || !credentialValid} onClick={() => credential && onSubmit(credential)} type="button">{t(pending ? "Saving…" : "Save")}</button></div></div></DialogFrame>;
}
