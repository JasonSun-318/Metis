import { ArrowClockwise } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

const MAX_INSTRUCTION_BYTES = 64 * 1024;

export function PersonalizationPanel({ api, serverReady }: {
	readonly api: Pick<MetisDesktopApi, "getPersonalization" | "updatePersonalization">;
	readonly serverReady: boolean;
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
			<section className="personalization-section">
				<header className="general-section-heading">
					<h2>{t("Global instructions")}</h2>
					<p>{t("Metis keeps these instructions in mind across new Chat and Code tasks.")}</p>
				</header>
				<div className="settings-card personalization-card">
				<label>
					<span>{t("Global instructions")}</span>
					<textarea
						aria-label={t("Global instructions")}
						disabled={!serverReady || saving}
						onChange={(event) => {
							setInstructions(event.target.value);
							setError(null);
							setSaved(false);
						}}
						placeholder={t("For example: Keep explanations brief and focus on actionable changes.")}
						value={instructions}
					/>
				</label>
				<p className="personalization-helper">{t("Changes apply to new or reloaded tasks. Running tasks are not interrupted.")}</p>
				<div className="personalization-meta">
					<span>{instructionBytes.toLocaleString()} / {MAX_INSTRUCTION_BYTES.toLocaleString()} UTF-8 bytes</span>
					{oversized ? <span className="personalization-error" role="alert">{t("Global instructions are too large.")}</span> : null}
				</div>
				<div className="personalization-actions">
					<div>
						{saved ? <span role="status">{t("Saved")}</span> : null}
						{error === "save" ? <span className="personalization-error" role="alert">{t("Couldn’t save global instructions.")}</span> : null}
					</div>
					<button
						aria-label={t("Save instructions")}
						className="settings-primary-button"
						disabled={!serverReady || loading || saving || oversized || instructions === savedInstructions}
						onClick={() => void save()}
						type="button"
					>
						{t("Save instructions")}
					</button>
				</div>
				</div>
			</section>
		</div>
	);
}
