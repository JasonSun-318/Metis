import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

type DiscoveryInput = Parameters<MetisDesktopApi["discoverModels"]>[0];
export type DiscoveredModel = Awaited<ReturnType<MetisDesktopApi["discoverModels"]>>["models"][number];

export function ModelDiscovery({
	api,
	connection,
	configured,
	existingIds,
	disabled,
	onAdd,
}: {
	readonly api: Pick<MetisDesktopApi, "discoverModels">;
	readonly connection: DiscoveryInput;
	readonly configured: boolean;
	readonly existingIds: readonly string[];
	readonly disabled: boolean;
	readonly onAdd: (models: readonly DiscoveredModel[]) => void;
}) {
	const { t } = useTranslation();
	const [models, setModels] = useState<readonly DiscoveredModel[] | null>(null);
	const [selected, setSelected] = useState<readonly string[]>([]);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<readonly string[]>([]);
	const [loading, setLoading] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const generation = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Connection changes invalidate pending requests and their result selection.
	useEffect(() => {
		generation.current++;
		setModels(null);
		setSelected([]);
		setError(null);
		setWarnings([]);
		setLoading(false);
		setExpanded(false);
		return () => {
			generation.current++;
		};
	}, [connection.provider, connection.baseUrl, connection.api, connection.apiKey]);
	const canFetch =
		/^https?:\/\//iu.test(connection.baseUrl.trim()) && (Boolean(connection.apiKey?.trim()) || configured);
	const fetchModels = async () => {
		const current = ++generation.current;
		setLoading(true);
		setError(null);
		setModels(null);
		setSelected([]);
		setWarnings([]);
		try {
			const result = await api.discoverModels(connection);
			if (current !== generation.current) return;
			if (result.models.length === 0 && result.warnings?.length) {
				setError(result.warnings.join(" "));
				return;
			}
			setModels([...new Map(result.models.map((model) => [model.modelId, model])).values()]);
			setExpanded(true);
			setWarnings(result.warnings ?? []);
		} catch (cause) {
			if (current === generation.current)
				setError(
					cause instanceof Error
						? cause.message
						: t("Models could not be fetched. You can still add a model manually."),
				);
		} finally {
			if (current === generation.current) setLoading(false);
		}
	};
	const filtered = models?.filter((model) =>
		`${model.modelId} ${model.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
	);
	const selectedModels =
		models?.filter((model) => selected.includes(model.modelId) && !existingIds.includes(model.modelId)) ?? [];
	return (
		<section className="model-discovery" aria-label={t("Discover models")} aria-busy={loading}>
			<div className="model-discovery-heading">
				<div>
					<strong>{t("Get models from this provider")}</strong>
					<p>{t("Fetch a list, then choose which models to add. This does not test model responses.")}</p>
				</div>
				<button
					type="button"
					className="settings-secondary-button"
					disabled={disabled || loading || !canFetch}
					onClick={() => void fetchModels()}
				>
					{loading ? t("Fetching models…") : t("Fetch model list")}
				</button>
			</div>
			{!canFetch ? <p>{t("Enter a base URL and API key first, or use the saved credentials.")}</p> : null}
			{configured && !connection.apiKey ? <p>{t("The saved API key will be used for this endpoint.")}</p> : null}
			{loading ? (
				<button
					type="button"
					className="settings-secondary-button"
					onClick={() => {
						generation.current++;
						setLoading(false);
					}}
				>
					{t("Cancel")}
				</button>
			) : null}
			{error ? (
				<p role="alert" className="settings-inline-error">
					{error} {t("You can still add a model manually.")}
				</p>
			) : null}
			{warnings.map((warning) => (
				<output key={warning}>{warning}</output>
			))}
			{models && !expanded ? (
				<div className="model-discovery-collapsed">
					<output>{t("{{count}} models fetched", { count: models.length })}</output>
					<button type="button" className="settings-secondary-button" onClick={() => setExpanded(true)}>
						{t("Show fetched models")}
					</button>
				</div>
			) : null}
			{models && expanded ? (
				<>
					<input
						type="search"
						onKeyDown={(event) => {
							if (event.key === "Enter") event.preventDefault();
						}}
						aria-label={t("Search discovered models")}
						placeholder={t("Search models…")}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					{models.length === 0 ? (
						<output>{t("No models were returned. You can add a model manually.")}</output>
					) : null}
					<div className="model-discovery-results">
						{filtered?.map((model) => {
							const added = existingIds.includes(model.modelId);
							return (
								<label className="model-discovery-option" key={model.modelId}>
									<input
										type="checkbox"
										aria-label={t("Select model {{model}}", { model: model.modelId })}
										disabled={disabled || added}
										checked={added || selected.includes(model.modelId)}
										onChange={(event) =>
											setSelected(
												event.target.checked
													? [...selected, model.modelId]
													: selected.filter((id) => id !== model.modelId),
											)
										}
									/>
									<span>
										<strong>{model.name}</strong>
										<code>{model.modelId}</code>
									</span>
									<small>{added ? t("Already added") : t("Not tested")}</small>
								</label>
							);
						})}
					</div>
					{models.length > 0 && filtered?.length === 0 ? (
						<output>{t("No models match your search.")}</output>
					) : null}
					{models.length > 0 ? (
						<>
							<p>
								{t("Missing capability values use editable defaults. Configure reasoning mappings yourself.")}
							</p>
							<button
								type="button"
								className="settings-secondary-button"
								disabled={disabled || selectedModels.length === 0}
								onClick={() => {
									onAdd(selectedModels);
									setSelected([]);
									setExpanded(false);
								}}
							>
								{t("Add selected models ({{count}})", { count: selectedModels.length })}
							</button>
						</>
					) : null}
				</>
			) : null}
		</section>
	);
}
