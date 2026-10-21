import type { ModelSettingsModelView } from "@metis/app-protocol";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

export function ModelCatalog({ models }: { readonly models: readonly ModelSettingsModelView[] }) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [limit, setLimit] = useState(20);
	const filtered = useMemo(() => {
		const search = query.trim().toLocaleLowerCase();
		return models.filter((model) => `${model.name} ${model.modelId}`.toLocaleLowerCase().includes(search));
	}, [models, query]);
	return (
		<section className="model-catalog-section" aria-label={t("Provider models")}>
			<div className="model-catalog-heading">
				<h3>{t("Provider models")}</h3>
				<span>{t("{{count}} models", { count: models.length })}</span>
			</div>
			<input
				type="search"
				onKeyDown={(event) => {
					if (event.key === "Enter") event.preventDefault();
				}}
				aria-label={t("Search models")}
				placeholder={t("Search models…")}
				value={query}
				onChange={(event) => {
					setQuery(event.target.value);
					setLimit(20);
				}}
			/>
			<ul className="model-catalog-list">
				{filtered.slice(0, limit).map((model) => (
					<li key={model.modelId}>
						<div>
							<strong>{model.name}</strong>
							<code>{model.modelId}</code>
						</div>
						<p>
							{t("Context: {{count}} tokens", { count: model.contextWindow })} ·{" "}
							{t("Output: {{count}} tokens", { count: model.maxOutputTokens })}
						</p>
						<p>
							{model.imageInput ? t("Text and image input") : t("Text input")} ·{" "}
							{t("Reasoning levels: {{levels}}", {
								levels: model.thinkingLevels.map((level) => t(level === "off" ? "Off" : level)).join(" / "),
							})}
						</p>
					</li>
				))}
			</ul>
			{filtered.length === 0 ? <output>{t("No models match your search.")}</output> : null}
			{filtered.length > limit ? (
				<button type="button" className="settings-secondary-button" onClick={() => setLimit(limit + 20)}>
					{t("Show more models")}
				</button>
			) : null}
		</section>
	);
}
