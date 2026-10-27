import type { CustomAgentTypeView } from "@metis/app-protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { localeForIntl } from "../i18n.ts";
import { ArrowLeft, CheckCircle, Copy, PencilSimple, Plus, Robot, Trash } from "../icons.tsx";
import { MenuSelect } from "./MenuSelect.tsx";

const AGENT_TYPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_SYSTEM_PROMPT_BYTES = 8 * 1024;

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

export function AgentTypesSettingsPanel({
	api,
	serverReady,
}: {
	readonly api: Pick<MetisDesktopApi, "listAgentTypes" | "upsertAgentType" | "removeAgentType">;
	readonly serverReady: boolean;
}) {
	const { t, i18n } = useTranslation();
	const locale = localeForIntl(i18n.resolvedLanguage);
	const [types, setTypes] = useState<readonly CustomAgentTypeView[]>([]);
	const [availableTools, setAvailableTools] = useState<readonly string[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [request, setRequest] = useState(0);
	const [draft, setDraft] = useState<AgentTypeDraft | null>(null);
	const [idLocked, setIdLocked] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [filter, setFilter] = useState("");

	const reload = useCallback(() => setRequest((value) => value + 1), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies(request): Retry requests explicitly reload the agent type catalog.
	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setLoading(true);
		setLoadError(false);
		void api.listAgentTypes().then(
			(result) => {
				if (!current) return;
				setTypes(result.types);
				setAvailableTools(result.availableTools ?? []);
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

	const builtIn = useMemo(() => types.filter((type) => type.builtIn && matchesFilter(type, filter)), [filter, types]);
	const custom = useMemo(() => types.filter((type) => !type.builtIn && matchesFilter(type, filter)), [filter, types]);
	const toolPalette = useMemo(
		() =>
			[
				...new Set([
					...availableTools,
					...types.flatMap((type) => type.allowedTools),
					...(draft?.allowedTools ?? []),
				]),
			].sort(),
		[availableTools, types, draft],
	);
	const promptBytes = useMemo(() => (draft ? new TextEncoder().encode(draft.systemPrompt).byteLength : 0), [draft]);

	const closeEditor = () => {
		setDraft(null);
		setFormError(null);
	};
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
		setFormError(null);
		if (!window.confirm(t("Delete agent type {{id}}? Existing agents keep their type name.", { id: view.id })))
			return;
		try {
			await api.removeAgentType({ requestId: crypto.randomUUID(), id: view.id });
			if (draft?.id === view.id) setDraft(null);
			reload();
		} catch {
			setFormError(t("Couldn’t delete the agent type."));
		}
	};

	if (loading) {
		return (
			<output aria-label={t("Agent types")} className="status-block settings-loading">
				{t("Loading agent types…")}
			</output>
		);
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
					<header className="settings-section-heading">
						<h3>{idLocked ? t("Edit agent type") : t("New agent type")}</h3>
						<button className="settings-secondary-button" disabled={saving} onClick={closeEditor} type="button">
							<ArrowLeft aria-hidden="true" size={13} />
							{t("Back to agent types")}
						</button>
					</header>
					{formError && (
						<p className="agent-types-form-error settings-inline-error" role="alert">
							{formError}
						</p>
					)}
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
						<strong className="agent-types-hint">
							{t(
								draft.allowedTools.length === 0
									? "Inherits all parent delegatable tools"
									: "Uses selected tools within parent permissions",
							)}
						</strong>
						<p className="agent-types-hint">
							{t("Effective tools are the intersection of this cap and the parent's delegatable tools.")}
						</p>
						<div className="agent-types-tools">
							{toolPalette.map((tool) => (
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
								onChange={(value) =>
									setDraft({ ...draft, writePolicy: value as AgentTypeDraft["writePolicy"] })
								}
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
						<p className="agent-types-hint">
							{t("Role instructions supplement Metis rules. Existing conversations keep their role snapshot.")}
						</p>
						<textarea
							disabled={!serverReady || saving}
							onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
							rows={6}
							value={draft.systemPrompt}
						/>
						<span className="agent-types-hint">
							{t("{{used}} / {{max}} UTF-8 bytes", {
								used: promptBytes.toLocaleString(locale),
								max: MAX_SYSTEM_PROMPT_BYTES.toLocaleString(locale),
							})}
						</span>
					</label>
					<div className="agent-types-actions">
						<button className="settings-secondary-button" disabled={saving} onClick={closeEditor} type="button">
							{t("Cancel")}
						</button>
						<button
							className="settings-primary-button"
							disabled={!serverReady || saving}
							onClick={() => void save()}
							type="button"
						>
							{t("Save")}
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
				{filter && (
					<button className="settings-secondary-button" onClick={() => setFilter("")} type="button">
						{t("Clear search")}
					</button>
				)}
				<button className="settings-primary-button" disabled={!serverReady} onClick={startCreate} type="button">
					<Plus aria-hidden="true" size={14} />
					{t("New agent type")}
				</button>
			</div>
			{formError && (
				<p className="agent-types-form-error settings-inline-error" role="alert">
					{formError}
				</p>
			)}
			<section aria-label={t("Built-in agent types")} className="settings-section">
				<h2 className="agent-types-heading">{t("Built-in agent types")}</h2>
				<div className="agent-types-list">
					{builtIn.map((view) => (
						<article className="agent-types-card" data-builtin="true" key={view.id}>
							<Robot aria-hidden="true" size={16} />
							<div className="agent-types-card-main">
								<strong>{view.displayName}</strong>
								<p>{t(view.description)}</p>
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
					<p className="agent-types-empty">
						{t(
							filter.trim()
								? "No matching custom agent types."
								: "No custom agent types yet. Duplicate a built-in or create a new one.",
						)}
						{!filter.trim() && (
							<button
								className="settings-secondary-button"
								disabled={!serverReady}
								onClick={startCreate}
								type="button"
							>
								{t("New agent type")}
							</button>
						)}
					</p>
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
									className="settings-danger-button"
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
