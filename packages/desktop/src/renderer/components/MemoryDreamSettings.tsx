import { useTranslation } from "react-i18next";
import type { DreamSettingsDraft } from "./memory-dream-settings.ts";

const fields = [
	{ key: "minHours", label: "Minimum interval (hours)", max: 8760 },
	{ key: "minSessions", label: "Minimum eligible sessions", max: 100000 },
	{ key: "maxUnusedDays", label: "Unused-note age (days)", max: 3650 },
] as const;

/** Controlled Dream-parameter controls; load/save/notice stay in the parent panel. */
export function MemoryDreamSettings({
	draft,
	modelOptions,
	disabled,
	onChange,
}: {
	readonly draft: DreamSettingsDraft;
	readonly modelOptions: readonly { value: string; label: string }[];
	readonly disabled: boolean;
	readonly onChange: (draft: DreamSettingsDraft) => void;
}) {
	const { t } = useTranslation();
	return (
		<>
			<label>
				<span>{t("Memory model")}</span>
				<select
					aria-label={t("Memory model")}
					disabled={disabled}
					onChange={(event) => onChange({ ...draft, modelKey: event.currentTarget.value })}
					value={draft.modelKey}
				>
					<option value="">{t("Automatic (lowest input cost)")}</option>
					{modelOptions.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</label>
			{fields.map((field) => (
				<label key={field.key}>
					<span>{t(field.label)}</span>
					<input
						aria-label={t(field.label)}
						disabled={disabled}
						max={field.max}
						min={1}
						onChange={(event) => onChange({ ...draft, [field.key]: event.currentTarget.value })}
						step={1}
						type="number"
						value={draft[field.key]}
					/>
				</label>
			))}
		</>
	);
}
