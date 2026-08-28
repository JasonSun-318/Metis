import { CheckCircle, Copy, PencilSimple, Plus, Robot, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CustomAgentTypeView } from "@metis/app-protocol";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { MenuSelect } from "./MenuSelect.tsx";

const AGENT_TYPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_SYSTEM_PROMPT_BYTES = 8 * 1024;

const TOOL_PALETTE = ["read", "grep", "find", "ls", "bash", "edit", "write", "web_fetch", "web_search"] as const;

interface AgentTypeDraft {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly allowedTools: readonly string[];
	readonly systemPrompt: string;
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
}

const EMPTY_DRAFT: AgentTypeDraft = {
	id: "",
	displayName: "",
	description: "",
	allowedTools: [],
	systemPrompt: "",
	writePolicy: "inherit",
	mayDelegate: false,
};

function draftFromType(view: CustomAgentTypeView): AgentTypeDraft {
	return {
		id: view.id,
		displayName: view.displayName,
		description: view.description,
		allowedTools: [...view.allowedTools],
		systemPrompt: view.systemPrompt,
		writePolicy: view.writePolicy,
		mayDelegate: view.mayDelegate,
	};
}

export function AgentTypesSettingsPanel({ api, serverReady }: {
	readonly api: Pick<MetisDesktopApi, "listAgentTypes" | "upsertAgentType" | "removeAgentType">;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [types, setTypes] = useState<readonly CustomAgentTypeView[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [request, setRequest] = useState(0);
	const [draft, setDraft] = useState<AgentTypeDraft | null>(null);
	const [idLocked, setIdLocked] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [filter, setFilter] = useState("");

	const reload = useCallback(() => setRequest((value) => value + 1), []);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setLoading(true);
		setLoadError(false);
		void api.listAgentTypes().then(
			(result) => {
				if (!current) return;
				setTypes(result.types);
				setLoading(false);
			},
			() => {
				if (!current) return;
				setLoadError(true);
				setLoading(false);
			},
		);
		return () => {
			current = false;
		};
	}, [api, request, serverReady]);

	const builtIn = useMemo(
		() => types.filter((type) => type.builtIn && matchesFilter(type, filter)),
		[filter, types],
	);
	const custom = useMemo(
		() => types.filter((type) => !type.builtIn && matchesFilter(type, filter)),
		[filter, types],
	);
	const promptBytes = useMemo(
		() => (draft ? new TextEncoder().encode(draft.systemPrompt).byteLength : 0),
		[draft],
	);

	const startCreate = () => {
		setDraft({ ...EMPTY_DRAFT });
		setIdLocked(false);
		setFormError(null);
	};
	const startDuplicate = (source: CustomAgentTypeView) => {
		setDraft({ ...draftFromType(source), id: "" });
		setIdLocked(false);
		setFormError(null);
	};
	const startEdit = (source: CustomAgentTypeView) => {
		setDraft(draftFromType(source));
		setIdLocked(true);
		setFormError(null);
	};

	const save = async () => {
		if (!draft || saving) return;
		if (!AGENT_TYPE_ID_PATTERN.test(draft.id)) {
			setFormError(t("Type id must be lowercase letters, digits, or dashes."));
			return;
		}
		if (draft.displayName.trim().length === 0) {
			setFormError(t("Display name is required."));
			return;
		}
		if (promptBytes > MAX_SYSTEM_PROMPT_BYTES) {
			setFormError(t("System prompt is too large."));
			return;
		}
		setSaving(true);
		setFormError(null);
		try {
			await api.upsertAgentType({
				requestId: crypto.randomUUID(),
				type: {
					id: draft.id,
					displayName: draft.displayName.trim(),
					description: draft.description.trim(),
					allowedTools: [...draft.allowedTools],
					systemPrompt: draft.systemPrompt,
					writePolicy: draft.writePolicy,
					mayDelegate: draft.mayDelegate,
				},
			});
			setDraft(null);
			reload();
		} catch {
			setFormError(t("Couldn’t save the agent type."));
		} finally {
			setSaving(false);
		}
	};

	const remove = async (view: CustomAgentTypeView) => {
		if (!window.confirm(t("Delete agent type {{id}}? Existing agents keep their type name.", { id: view.id }))) return;
		try {
			await api.removeAgentType({ requestId: crypto.randomUUID(), id: view.id });
			if (draft?.id === view.id) setDraft(null);
			reload();
		} catch {
			setFormError(t("Couldn’t delete the agent type."));
		}
	};

	if (loading) {
		return <div aria-label={t("Agent types")} className="settings-loading" role="status" />;
	}
	if (loadError) {
		return (
			<div className="settings-page agent-types-page">
				<div className="agent-types-load-error settings-inline-error" role="alert">
					<p>{t("Couldn’t load agent types.")}</p>
					<button className="settings-secondary-button" disabled={!serverReady} onClick={reload} type="button">
						{t("Retry")}
					</button>
				</div>
			</div>
		);
	}

	if (draft) {
		return (
			<div className="settings-page agent-types-page">
				<section aria-label={t("Agent types")} className="settings-section agent-types-editor">
					{formError && <p className="agent-types-form-error settings-inline-error" role="alert">{formError}</p>}
					<div className="agent-types-row">
						<label className="agent-types-field">
							<span>{t("Display name")}</span>
							<input
								disabled={!serverReady || saving}
								maxLength={128}
								onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
								value={draft.displayName}
							/>
						</label>
						<label className="agent-types-field">
							<span>{t("Type id")}</span>
							<input
								disabled={!serverReady || saving || idLocked}
								onChange={(event) => setDraft({ ...draft, id: event.target.value })}
								value={draft.id}
							/>
						</label>
					</div>
					<label className="agent-types-field">
						<span>{t("Description")}</span>
						<input
							disabled={!serverReady || saving}
							maxLength={512}
							onChange={(event) => setDraft({ ...draft, description: event.target.value })}
							value={draft.description}
						/>
					</label>
					<div className="agent-types-field">
						<span>{t("Allowed tools")}</span>
						<p className="agent-types-hint">{t("Effective tools are the intersection of this cap and the parent's delegatable tools.")}</p>
						<div className="agent-types-tools">
							{TOOL_PALETTE.map((tool) => (
								<label className="agent-types-tool" key={tool}>
									<input
										checked={draft.allowedTools.includes(tool)}
										disabled={!serverReady || saving}
										onChange={(event) => {
											setDraft({
												...draft,
												allowedTools: event.target.checked
													? [...draft.allowedTools, tool]
													: draft.allowedTools.filter((name) => name !== tool),
											});
										}}
										type="checkbox"
									/>
									{tool}
								</label>
							))}
						</div>
						<p className="agent-types-hint">{t("Leave every tool unchecked to inherit all parent tools.")}</p>
					</div>
					<div className="agent-types-row">
						<div className="agent-types-field">
							<span>{t("Write policy")}</span>
							<MenuSelect
								ariaLabel={t("Write policy")}
								disabled={!serverReady || saving}
								onChange={(value) => setDraft({ ...draft, writePolicy: value as AgentTypeDraft["writePolicy"] })}
								options={[
									{ label: t("Inherit"), value: "inherit" },
									{ label: t("Deny writes"), value: "deny" },
								]}
								value={draft.writePolicy}
							/>
						</div>
						<label className="agent-types-field agent-types-toggle">
							<span>{t("May delegate")}</span>
							<input
								checked={draft.mayDelegate}
								disabled={!serverReady || saving}
								onChange={(event) => setDraft({ ...draft, mayDelegate: event.target.checked })}
								type="checkbox"
							/>
						</label>
					</div>
					<label className="agent-types-field">
						<span>{t("System prompt")}</span>
						<textarea
							disabled={!serverReady || saving}
							onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
							rows={6}
							value={draft.systemPrompt}
						/>
						<span className="agent-types-hint">{promptBytes.toLocaleString()} / {MAX_SYSTEM_PROMPT_BYTES.toLocaleString()} UTF-8 bytes</span>
					</label>
					<div className="agent-types-actions">
						<button className="settings-primary-button" disabled={!serverReady || saving} onClick={() => void save()} type="button">
							{t("Save")}
						</button>
						<button className="settings-secondary-button" disabled={saving} onClick={() => setDraft(null)} type="button">
							{t("Cancel")}
						</button>
					</div>
				</section>
			</div>
		);
	}

	return (
		<div className="settings-page agent-types-page">
			<div className="agent-types-toolbar">
				<input
					aria-label={t("Search agent types")}
					className="agent-types-search"
					onChange={(event) => setFilter(event.target.value)}
					placeholder={t("Search agent types")}
					value={filter}
				/>
				<button className="settings-primary-button" disabled={!serverReady} onClick={startCreate} type="button">
					<Plus aria-hidden="true" size={14} />
					{t("New agent type")}
				</button>
			</div>
			<section aria-label={t("Built-in agent types")} className="settings-section">
				<h2 className="agent-types-heading">{t("Built-in agent types")}</h2>
				<div className="agent-types-list">
					{builtIn.map((view) => (
						<article className="agent-types-card" data-builtin="true" key={view.id}>
							<Robot aria-hidden="true" size={16} />
							<div className="agent-types-card-main">
								<strong>{view.displayName}</strong>
								<p>{view.description}</p>
							</div>
							<span className="agent-types-tools-badge">
								{view.allowedTools.length > 0
									? t("{{count}} tools", { count: view.allowedTools.length })
									: t("All tools")}
							</span>
							<button
								className="settings-secondary-button"
								disabled={!serverReady}
								aria-label={t("Duplicate {{name}}", { name: view.displayName })}
								onClick={() => startDuplicate(view)}
								type="button"
							>
								<Copy aria-hidden="true" size={13} />
								{t("Duplicate")}
							</button>
						</article>
					))}
				</div>
			</section>
			<section aria-label={t("Custom agent types")} className="settings-section">
				<h2 className="agent-types-heading">
					{t("Custom agent types")}
					<span className="agent-types-count">{custom.length}</span>
				</h2>
				{custom.length === 0 ? (
					<p className="agent-types-empty">{t("No custom agent types yet. Duplicate a built-in or create a new one.")}</p>
				) : (
					<div className="agent-types-list">
						{custom.map((view) => (
							<article className="agent-types-card" data-builtin="false" key={view.id}>
								<CheckCircle aria-hidden="true" size={16} />
								<div className="agent-types-card-main">
									<strong>{view.displayName}</strong>
									<p>{view.description || view.id}</p>
								</div>
								<span className="agent-types-tools-badge">
									{view.allowedTools.length > 0
										? t("{{count}} tools", { count: view.allowedTools.length })
										: t("All tools")}
								</span>
								<button
									aria-label={t("Edit {{name}}", { name: view.displayName })}
									className="settings-secondary-button"
									disabled={!serverReady}
									onClick={() => startEdit(view)}
									type="button"
								>
									<PencilSimple aria-hidden="true" size={13} />
									{t("Edit")}
								</button>
								<button
									aria-label={t("Delete {{name}}", { name: view.displayName })}
									className="settings-secondary-button"
									disabled={!serverReady}
									onClick={() => void remove(view)}
									type="button"
								>
									<Trash aria-hidden="true" size={13} />
									{t("Delete")}
								</button>
							</article>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function matchesFilter(view: CustomAgentTypeView, filter: string): boolean {
	const needle = filter.trim().toLowerCase();
	if (!needle) return true;
	return (
		view.id.toLowerCase().includes(needle) ||
		view.displayName.toLowerCase().includes(needle) ||
		view.description.toLowerCase().includes(needle)
	);
}
