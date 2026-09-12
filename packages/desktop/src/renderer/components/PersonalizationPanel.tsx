import {
	ArrowClockwise,
	Code,
	GlobeHemisphereWest,
	Lightning,
	MagnifyingGlass,
	ShieldCheck,
	Sparkle,
	Trash,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

const MAX_INSTRUCTION_BYTES = 64 * 1024;

const PRESET_INSTRUCTIONS = [
	{
		icon: Lightning,
		label: "Concise and direct",
		text: "Keep responses concise and efficient, focusing on core conclusions and code changes without unnecessary pleasantries.",
	},
	{
		icon: MagnifyingGlass,
		label: "Explain reasoning",
		text: "Before changing code, explain the reasoning and assess edge cases and architectural impact.",
	},
	{
		icon: Code,
		label: "Test first",
		text: "After completing a task or logic change, add and run the relevant tests to verify it.",
	},
	{
		icon: GlobeHemisphereWest,
		label: "Always use Chinese",
		text: "Always use Chinese for reasoning, responses, and code comments.",
	},
	{
		icon: ShieldCheck,
		label: "Strict TypeScript",
		text: "Follow the TypeScript type system strictly; do not use any or implicit type escapes.",
	},
] as const;

export function PersonalizationPanel({ api, serverReady, onDirtyChange }: {
	readonly api: Pick<MetisDesktopApi, "getPersonalization" | "updatePersonalization">;
	readonly serverReady: boolean;
	readonly onDirtyChange?: (dirty: boolean) => void;
}) {
	const { t } = useTranslation();
	const [instructions, setInstructions] = useState("");
	const [savedInstructions, setSavedInstructions] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<"load" | "save" | null>(null);
	const [saved, setSaved] = useState(false);
	const [request, setRequest] = useState(0);
	const instructionBytes = useMemo(() => new TextEncoder().encode(instructions).byteLength, [instructions]);
	const dirty = savedInstructions !== null && instructions !== savedInstructions;
	useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
	const oversized = instructionBytes > MAX_INSTRUCTION_BYTES;

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setLoading(true);
		setError(null);
		void api.getPersonalization().then(
			(result) => {
				if (!current) return;
				setInstructions(result.instructions);
				setSavedInstructions(result.instructions);
				setLoading(false);
			},
			() => {
				if (!current) return;
				setError("load");
				setLoading(false);
			},
		);
		return () => {
			current = false;
		};
	}, [api, request, serverReady]);

	const save = async () => {
		if (!serverReady || loading || saving || oversized || instructions === savedInstructions) return;
		setSaving(true);
		setError(null);
		setSaved(false);
		try {
			const result = await api.updatePersonalization({ instructions });
			setInstructions(result.instructions);
			setSavedInstructions(result.instructions);
			setSaved(true);
		} catch {
			setError("save");
		} finally {
			setSaving(false);
		}
	};

	const applyPreset = (presetText: string) => {
		setInstructions((prev) => {
			const trimmed = prev.trim();
			if (!trimmed) return presetText;
			if (trimmed.includes(presetText)) return prev;
			return `${trimmed}\n\n${presetText}`;
		});
		setError(null);
		setSaved(false);
	};

	if (loading) {
		return <div aria-label={t("Global instructions")} className="settings-loading" role="status" />;
	}
	if (error === "load") {
		return (
			<div className="settings-page personalization-page">
				<div className="personalization-load-error settings-inline-error" role="alert">
					<p>{t("Couldn’t load global instructions.")}</p>
					<button className="settings-secondary-button" disabled={!serverReady} onClick={() => setRequest((value) => value + 1)} type="button">
						<ArrowClockwise aria-hidden="true" size={15} />{t("Retry")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="settings-page personalization-page">
			<section className="settings-section personalization-section">
				<div className="personalization-presets-block">
					<span className="personalization-presets-label">
						<Sparkle aria-hidden="true" size={14} />
						{t("Quick presets")}
					</span>
					<div className="personalization-presets-grid">
						{PRESET_INSTRUCTIONS.map((preset) => {
							const Icon = preset.icon;
							return (
								<button
									className="personalization-preset-chip"
									key={preset.label}
									onClick={() => applyPreset(t(preset.text))}
									type="button"
								>
									<Icon aria-hidden="true" size={14} />
									{t(preset.label)}
								</button>
							);
						})}
					</div>
				</div>

				<div className="settings-card personalization-card">
					<label className="personalization-input-label">
						<span className="sr-only">{t("Global instructions")}</span>
						<textarea
							aria-label={t("Global instructions")}
							disabled={!serverReady || saving}
							onChange={(event) => {
								setInstructions(event.target.value);
								setError(null);
								setSaved(false);
							}}
							placeholder={t("For example: Keep explanations brief and focus on actionable changes.")}
							rows={7}
							value={instructions}
						/>
					</label>
					<div className="personalization-footer">
						<div className="personalization-meta">
							<span className="personalization-bytes">{t("{{used}} / {{max}} bytes", { used: instructionBytes.toLocaleString(), max: MAX_INSTRUCTION_BYTES.toLocaleString() })}</span>
							{oversized ? <span className="personalization-error" role="alert">{t("Global instructions are too large.")}</span> : null}
							{dirty ? <span className="personalization-unsaved" role="status">{t("Unsaved changes")}</span> : null}
								{saved ? <span className="personalization-saved-badge" role="status">{t("Saved")}</span> : null}
							{error === "save" ? <span className="personalization-error" role="alert">{t("Couldn’t save global instructions.")}</span> : null}
						</div>
						<div className="personalization-actions">
							{instructions ? (
								<button
									aria-label={t("Clear instructions")}
									className="settings-secondary-button personalization-clear-button"
									disabled={!serverReady || saving}
									onClick={() => {
										setInstructions("");
										setError(null);
										setSaved(false);
									}}
									type="button"
								>
									<Trash aria-hidden="true" size={14} />
									{t("Clear")}
								</button>
							) : null}
							<button
								aria-label={t("Save instructions")}
								className="settings-primary-button"
								disabled={!serverReady || loading || saving || oversized || instructions === savedInstructions}
								onClick={() => void save()}
								type="button"
							>
								{saving ? t("Saving…") : t("Save instructions")}
							</button>
						</div>
					</div>
				</div>
				<p className="personalization-helper-note">{t("Changes apply to new or reloaded tasks. Running tasks are not interrupted.")}</p>
			</section>
		</div>
	);
}
