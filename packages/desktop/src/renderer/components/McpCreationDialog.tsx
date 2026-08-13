import type { ClientResult } from "@metis/app-protocol";
import { ArrowLeft, BracketsCurly, CaretRight, FolderSimple, LinkSimple, SlidersHorizontal, X } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogFrame } from "./ProjectActions.tsx";
import { MenuSelect } from "./MenuSelect.tsx";
import { McpServerForm, type McpServerDraft } from "./McpServerDialog.tsx";

export type McpCreationTarget =
	| { readonly scope: "user"; readonly cwd: null }
	| { readonly scope: "project"; readonly cwd: string };

export interface McpProjectOption {
	readonly cwd: string;
	readonly name: string;
}

type Inspection = ClientResult<"mcp/import/inspect">;
type Step = "methods" | "url" | "custom" | "json";

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The MCP server could not be created.";
}

export function McpCreationDialog({ initialCwd, onCancel, onChooseProject, onImport, onInspect, onSave, projects, scope }: {
	readonly initialCwd: string | null;
	readonly onCancel: () => void;
	readonly onChooseProject: () => Promise<string | null>;
	readonly onImport: (target: McpCreationTarget, text: string, inspection: Inspection, candidateIds: readonly string[]) => Promise<void>;
	readonly onInspect: (target: McpCreationTarget, text: string) => Promise<Inspection>;
	readonly onSave: (target: McpCreationTarget, draft: McpServerDraft, expectedRevision: string | null) => Promise<void>;
	readonly projects: readonly McpProjectOption[];
	readonly scope: "user" | "project";
}) {
	const { t } = useTranslation();
	const first = useRef<HTMLButtonElement>(null);
	const jsonInput = useRef<HTMLTextAreaElement>(null);
	const [cwd, setCwd] = useState(scope === "project" ? initialCwd : null);
	const [step, setStep] = useState<Step>("methods");
	const [target, setTarget] = useState<McpCreationTarget | null>(null);
	const [text, setText] = useState("");
	const [inspection, setInspection] = useState<Inspection | null>(null);
	const [urlDraft, setUrlDraft] = useState<McpServerDraft | null>(null);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [replacements, setReplacements] = useState<ReadonlySet<string>>(new Set());
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const currentTarget = scope === "user" ? ({ scope, cwd: null } as const) : cwd ? ({ scope, cwd } as const) : null;
	const projectOptions = [
		...(cwd && !projects.some((project) => project.cwd === cwd) ? [{ value: cwd, label: cwd }] : []),
		...projects.map((project) => ({ value: project.cwd, label: `${project.name} — ${project.cwd}` })),
	];
	const enter = (next: Exclude<Step, "methods">) => {
		if (!currentTarget) return;
		setTarget(currentTarget);
		setStep(next);
		setError(null);
	};
	const back = () => {
		if (pending) return;
		setStep("methods");
		setTarget(null);
		setInspection(null);
		setUrlDraft(null);
		setText("");
		setSelected(new Set());
		setReplacements(new Set());
		setError(null);
	};
	const chooseProject = async () => {
		try {
			const next = await onChooseProject();
			if (next) setCwd(next);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	const save = async (draft: McpServerDraft, expectedRevision: string | null = null) => {
		if (!target) return;
		setPending(true);
		setError(null);
		try {
			await onSave(target, draft, expectedRevision);
		} catch (cause) {
			setError(errorMessage(cause));
			setPending(false);
		}
	};
	const inspectUrl = async (draft: McpServerDraft) => {
		if (!target) return;
		const source = JSON.stringify({ mcpServers: { [draft.name]: draft.server } });
		setPending(true);
		setError(null);
		setInspection(null);
		try {
			const result = await onInspect(target, source);
			setText(source);
			setUrlDraft(draft);
			setInspection(result);
			setSelected(new Set(result.candidates.filter((candidate) => candidate.existingRevision === null).map((candidate) => candidate.id)));
			setReplacements(new Set());
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setPending(false);
		}
	};
	const inspect = async (event?: { preventDefault(): void }) => {
		event?.preventDefault();
		if (!target || !text.trim()) return;
		setPending(true);
		setError(null);
		setInspection(null);
		try {
			const result = await onInspect(target, text);
			setInspection(result);
			setSelected(new Set(result.candidates.filter((candidate) => candidate.existingRevision === null).map((candidate) => candidate.id)));
			setReplacements(new Set());
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setPending(false);
		}
	};
	const install = async () => {
		if (!target || !inspection || selected.size === 0) return;
		const unresolved = inspection.candidates.some((candidate) => selected.has(candidate.id) && candidate.existingRevision && !replacements.has(candidate.id));
		if (unresolved) {
			setError(t("Confirm Replace for every existing server selected."));
			return;
		}
		setPending(true);
		setError(null);
		try {
			if (step === "url" && urlDraft) {
				const candidate = inspection.candidates.find((item) => item.id === urlDraft.name);
				await save(urlDraft, candidate?.existingRevision ?? null);
				return;
			}
			await onImport(target, text, inspection, [...selected]);
		} catch (cause) {
			setError(errorMessage(cause));
			setPending(false);
		}
	};
	const initialFocus = step === "json" ? jsonInput : first;
	return <DialogFrame cancellable={!pending} className="mcp-dialog mcp-create-dialog" descriptionId="mcp-create-description" initialFocus={initialFocus} onCancel={onCancel} titleId="mcp-create-title">
		<button aria-label={t("Close")} className="mcp-dialog-close" disabled={pending} onClick={onCancel} type="button"><X aria-hidden="true" size={17} /></button>
		<div className="skill-create-heading">{step !== "methods" && <button aria-label={t("Back")} className="skill-create-back" disabled={pending} onClick={back} type="button"><ArrowLeft aria-hidden="true" size={17} /></button>}<div><h2 id="mcp-create-title">{t(step === "custom" ? "MCP configuration" : scope === "project" ? "Create Project MCP" : "Create User MCP")}</h2><p className={step === "custom" ? "sr-only" : undefined} id="mcp-create-description">{t(step === "methods" ? "Choose how to configure the MCP server." : step === "custom" ? "Configure an HTTP or STDIO MCP server." : "The selected target stays fixed until this dialog closes.")}</p></div></div>
		{scope === "project" && <div className="skill-create-project"><span>{t("Create in")}</span><div><MenuSelect<string> ariaLabel={t("Create in")} className="skill-create-project-select" disabled={pending || step !== "methods"} onChange={setCwd} options={projectOptions} placeholder={t("Choose a project")} value={cwd ?? ""} /><button className="button-secondary skill-create-folder" disabled={pending || step !== "methods"} onClick={() => void chooseProject()} type="button"><FolderSimple aria-hidden="true" size={15} />{t("Choose folder…")}</button></div></div>}
		{step === "methods" && <div className="skill-create-methods">
			<button aria-label={t("Add by URL")} disabled={!currentTarget || pending} onClick={() => enter("url")} ref={first} type="button"><span><LinkSimple aria-hidden="true" size={20} /></span><span><strong>{t("Add by URL")}</strong><small>{t("Configure a Streamable HTTP server and optional credentials.")}</small></span><CaretRight aria-hidden="true" size={16} /></button>
			<button aria-label={t("Custom MCP")} disabled={!currentTarget || pending} onClick={() => enter("custom")} type="button"><span><SlidersHorizontal aria-hidden="true" size={20} /></span><span><strong>{t("Custom MCP")}</strong><small>{t("Configure a local command or advanced Streamable HTTP server.")}</small></span><CaretRight aria-hidden="true" size={16} /></button>
			<button aria-label={t("Import JSON")} disabled={!currentTarget || pending} onClick={() => enter("json")} type="button"><span><BracketsCurly aria-hidden="true" size={20} /></span><span><strong>{t("Import JSON")}</strong><small>{t("Inspect JSON or JSONC before importing selected servers.")}</small></span><CaretRight aria-hidden="true" size={16} /></button>
		</div>}
		{step === "url" && !inspection && <McpServerForm error={error} onCancel={onCancel} onSubmit={(draft) => void inspectUrl(draft)} pending={pending} variant="url" />}
		{step === "custom" && <McpServerForm error={error} onCancel={onCancel} onSubmit={(draft) => void save(draft)} pending={pending} variant="custom" />}
		{step === "json" && <form className="mcp-json-form" onSubmit={(event) => void inspect(event)}><label>{t("MCP JSON or JSONC")}<textarea aria-label={t("MCP JSON or JSONC")} disabled={pending} onChange={(event) => { setText(event.target.value); setInspection(null); }} placeholder={'{\n  "mcpServers": { ... }\n}'} ref={jsonInput} value={text} /></label></form>}
		{inspection && <div className="mcp-import-candidates"><h3>{t("MCP servers found")}</h3>{inspection.candidates.map((candidate) => <div className="mcp-import-candidate" key={candidate.id}><label><input checked={selected.has(candidate.id)} disabled={pending} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(candidate.id); else next.delete(candidate.id); return next; })} type="checkbox" /><span><strong>{candidate.name}</strong><small>{t(candidate.transport === "stdio" ? "Local command" : "Streamable HTTP")} · {t(candidate.existingRevision ? "Existing server" : "New server")}</small></span></label>{candidate.existingRevision && selected.has(candidate.id) && <label className="mcp-replace-confirm"><input checked={replacements.has(candidate.id)} disabled={pending} onChange={(event) => setReplacements((current) => { const next = new Set(current); if (event.target.checked) next.add(candidate.id); else next.delete(candidate.id); return next; })} type="checkbox" />{t("Replace")}</label>}</div>)}</div>}
		{error && step !== "custom" && !(step === "url" && !inspection) && <p className="mcp-dialog-error" role="alert">{error}</p>}
		{(step === "methods" || step === "json" || (step === "url" && inspection)) && <div className="mcp-dialog-actions"><button className="button-secondary" disabled={pending} onClick={onCancel} type="button">{t("Cancel")}</button>{step === "json" && !inspection && <button disabled={pending || !text.trim()} onClick={() => void inspect()} type="button">{t(pending ? "Inspecting…" : "Inspect")}</button>}{inspection && <button disabled={pending || selected.size === 0} onClick={() => void install()} type="button">{t(pending ? (step === "url" ? "Adding…" : "Importing…") : (step === "url" ? "Add selected" : "Import selected"))}</button>}</div>}
	</DialogFrame>;
}
