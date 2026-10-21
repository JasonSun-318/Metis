import type { ThinkingSelectionView } from "@metis/app-protocol";
import { Plus, Trash } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { MenuSelect } from "./MenuSelect.tsx";

export const MODEL_THINKING_LEVELS: readonly ThinkingSelectionView[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
export interface ReasoningRow {
	readonly key: string;
	readonly level: ThinkingSelectionView;
	readonly value: string;
}
export type ReasoningMap = Partial<Record<ThinkingSelectionView, string | null>>;
export interface ReasoningDraft {
	readonly reasoningMode: "auto" | "off" | "generic" | "manual";
	readonly reasoningRows: readonly ReasoningRow[];
	readonly thinkingLevels?: readonly ThinkingSelectionView[];
}

export function reasoningRows(map: ReasoningMap | undefined): ReasoningRow[] {
	return MODEL_THINKING_LEVELS.flatMap((level) =>
		typeof map?.[level] === "string" ? [{ key: crypto.randomUUID(), level, value: map[level] as string }] : [],
	);
}

export function reasoningMutation(model: ReasoningDraft) {
	return {
		reasoningMode: model.reasoningMode,
		...(model.reasoningMode === "manual"
			? {
					thinkingLevelMap: Object.fromEntries(
						model.reasoningRows.map((row) => [row.level, row.value.trim()]),
					) as ReasoningMap,
				}
			: {}),
	};
}

export function reasoningError(model: ReasoningDraft): string | null {
	if (model.reasoningMode !== "manual") return null;
	if (model.reasoningRows.length === 0) return "Add at least one reasoning level or turn off reasoning.";
	if (new Set(model.reasoningRows.map((row) => row.level)).size !== model.reasoningRows.length)
		return "Reasoning levels must be unique.";
	if (model.reasoningRows.some((row) => !row.value.trim())) return "Enter the API value for every reasoning level.";
	return null;
}

export function ModelReasoningEditor({
	id,
	model,
	api,
	disabled,
	onChange,
}: {
	readonly id: string;
	readonly model: ReasoningDraft;
	readonly api: string;
	readonly disabled: boolean;
	readonly onChange: (patch: ReasoningDraft) => void;
}) {
	const { t } = useTranslation();
	const legacy = model.reasoningMode === "auto" || model.reasoningMode === "generic";
	const enabled = legacy
		? Boolean(model.thinkingLevels?.some((level) => level !== "off"))
		: model.reasoningMode === "manual";
	const available = MODEL_THINKING_LEVELS.filter((level) => !model.reasoningRows.some((row) => row.level === level));
	return (
		<section className="model-reasoning-editor" aria-label={t("Reasoning levels")}>
			<label className="model-reasoning-toggle">
				<span>{t("Reasoning levels")}</span>
				<input
					type="checkbox"
					role="switch"
					aria-checked={enabled}
					aria-label={t("Enable reasoning levels")}
					checked={enabled}
					disabled={disabled}
					onChange={(event) => onChange({ ...model, reasoningMode: event.target.checked ? "manual" : "off" })}
				/>
			</label>
			{legacy ? (
				<div className="model-legacy-reasoning">
					<p>{t("Existing reasoning settings are preserved until you edit the mapping.")}</p>
					<button
						type="button"
						className="settings-secondary-button"
						disabled={disabled}
						onClick={() => onChange({ ...model, reasoningMode: "manual" })}
					>
						{t("Edit reasoning mapping")}
					</button>
				</div>
			) : null}
			{model.reasoningMode === "manual" ? (
				<>
					<p>{t("Only added levels are offered. API values are sent using the selected API format.")}</p>
					{model.reasoningRows.map((row, index) => (
						<div className="model-reasoning-row" key={row.key}>
							<label htmlFor={`${id}-${row.key}`}>
								<span>{t("Level")}</span>
								<MenuSelect
									id={`${id}-${row.key}`}
									ariaLabel={t("Reasoning level {{index}}", { index: index + 1 })}
									value={row.level}
									disabled={disabled}
									options={MODEL_THINKING_LEVELS.filter(
										(level) => level === row.level || available.includes(level),
									).map((level) => ({ value: level, label: level }))}
									onChange={(level) =>
										onChange({
											...model,
											reasoningRows: model.reasoningRows.map((item) =>
												item.key === row.key ? { ...item, level } : item,
											),
										})
									}
								/>
							</label>
							<label>
								<span>{t("API parameter value")}</span>
								<input
									aria-label={t("API value {{index}}", { index: index + 1 })}
									value={row.value}
									maxLength={128}
									disabled={disabled}
									placeholder={
										row.level === "off"
											? api === "anthropic-messages"
												? "disabled"
												: "none"
											: t("Value from the API documentation")
									}
									onChange={(event) =>
										onChange({
											...model,
											reasoningRows: model.reasoningRows.map((item) =>
												item.key === row.key ? { ...item, value: event.target.value } : item,
											),
										})
									}
								/>
							</label>
							<button
								type="button"
								className="model-mapping-remove"
								aria-label={t("Remove reasoning level {{level}}", { level: row.level })}
								disabled={disabled}
								onClick={() =>
									onChange({
										...model,
										reasoningRows: model.reasoningRows.filter((item) => item.key !== row.key),
									})
								}
							>
								<Trash aria-hidden="true" size={15} />
							</button>
						</div>
					))}
					<button
						type="button"
						className="settings-secondary-button"
						disabled={disabled || available.length === 0}
						onClick={() => {
							const level = ["low", "medium", "high", "minimal", "xhigh", "max", "off"].find((item) =>
								available.includes(item as ThinkingSelectionView),
							) as ThinkingSelectionView | undefined;
							if (level)
								onChange({
									...model,
									reasoningRows: [...model.reasoningRows, { key: crypto.randomUUID(), level, value: "" }],
								});
						}}
					>
						<Plus aria-hidden="true" size={14} />
						{t("Add reasoning level")}
					</button>
					{model.reasoningRows.some((row) => row.level === "off") ? (
						<p>
							{api === "anthropic-messages"
								? t("For off, enter disabled to explicitly disable Anthropic thinking.")
								: t("For off, enter the explicit disable value accepted by your endpoint.")}
						</p>
					) : null}
				</>
			) : null}
		</section>
	);
}
