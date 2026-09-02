import type { ClientResult } from "@metis/app-protocol";
import { Trash, Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

interface PermissionRulesPanelProps {
	readonly api: MetisDesktopApi;
	readonly serverReady: boolean;
	readonly sessionId: string | null;
}

export function PermissionRulesPanel({ api, serverReady, sessionId }: PermissionRulesPanelProps) {
	const { t } = useTranslation();
	const [result, setResult] = useState<ClientResult<"permission/rules/list"> | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmClear, setConfirmClear] = useState(false);
	const confirmRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		if (!confirmClear) return;
		confirmRef.current?.showModal?.();
	}, [confirmClear]);

	useEffect(() => {
		let current = true;
		setResult(null);
		setError(null);
		if (!sessionId || !serverReady) return () => { current = false; };
		void api.listPermissionRules({ sessionId }).then((next) => {
			if (current) setResult(next);
		}).catch((cause) => {
			if (current) setError(cause instanceof Error ? cause.message : "Permission rules could not be loaded.");
		});
		return () => { current = false; };
	}, [api, serverReady, sessionId]);

	const remove = async (ruleId: string) => {
		if (!sessionId) return;
		setBusy(ruleId);
		setError(null);
		try {
			setResult(await api.deletePermissionRule({ sessionId, ruleId, requestId: crypto.randomUUID() }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Permission rule could not be removed.");
		} finally {
			setBusy(null);
		}
	};

	const clear = async () => {
		if (!sessionId) return;
		setBusy("clear");
		setError(null);
		try {
			setResult(await api.clearPermissionRules({ sessionId, requestId: crypto.randomUUID() }));
			setConfirmClear(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Permission rules could not be cleared.");
		} finally {
			setBusy(null);
		}
	};

	if (!sessionId) {
		return <section className="settings-page permission-rules-page"><p>{t("Open a project to manage its remembered permission decisions.")}</p></section>;
	}
	return (
		<section className="settings-page permission-rules-page">
		<div className="settings-section-heading">
			<div><h2>{t("Remembered permissions for this project")}</h2><p>{t("Only exact actions you chose to always allow or deny are listed here.")}</p></div>
			{result?.rules.length ? <button className="settings-danger-button" disabled={busy !== null} onClick={() => setConfirmClear(true)} type="button">{t("Clear all")}</button> : null}
		</div>
		{result ? <p className="permission-rules-project"><code>{result.projectPath}</code></p> : null}
		{!result && !error ? <div aria-label={t("Loading permissions")} className="settings-loading" /> : null}
		{result?.rules.length === 0 ? <p>{t("No remembered permission decisions for this project.")}</p> : null}
		{result?.rules.length ? <ul className="permission-rule-list">
			{result.rules.map((rule) => <li key={rule.id}>
				<div className="permission-rule-heading"><strong>{rule.toolName}</strong><span>{t(rule.decision === "allow" ? "Always allow" : "Always deny")}</span><span className={`permission-target-${rule.executionTarget}`}>{t(rule.executionTarget === "sandbox" ? "Sandbox" : rule.executionTarget === "external" ? "External" : "Host")}</span></div>
				<div className="permission-rule-details">
					{rule.details.map((detail, index) => <div key={`${detail.label}:${index}`}><span>{t(detail.label)}</span><code>{detail.value}</code></div>)}
					<div><span>{t("Rule fingerprint")}</span><code>{rule.id.slice(0, 12)}</code></div>
					{rule.omittedDetails > 0 ? <p>{t("{{count}} additional details omitted", { count: rule.omittedDetails })}</p> : null}
				</div>
				<div className="permission-rule-meta"><span>{rule.risks.map((risk) => t(risk)).join(", ")}</span><time dateTime={rule.createdAt}>{new Date(rule.createdAt).toLocaleString()}</time></div>
				<button aria-label={t("Remove {{tool}} permission", { tool: rule.toolName })} disabled={busy !== null} onClick={() => void remove(rule.id)} type="button"><Trash aria-hidden="true" size={16} /></button>
			</li>)}
		</ul> : null}
		{error ? <p className="settings-inline-error" role="alert">{t(error)}</p> : null}
		{confirmClear ? <dialog aria-labelledby="clear-permissions-title" className="permission-rules-confirm" onCancel={(event) => { event.preventDefault(); setConfirmClear(false); }} ref={confirmRef}>
			<div><Warning aria-hidden="true" size={20} /><h2 id="clear-permissions-title">{t("Clear all remembered permission decisions?")}</h2><p>{t("Metis will review or ask again before these exact actions run.")}</p><footer><button className="settings-secondary-button" disabled={busy !== null} onClick={() => setConfirmClear(false)} type="button">{t("Cancel")}</button><button className="settings-danger-button" disabled={busy !== null} onClick={() => void clear()} type="button">{t("Clear all")}</button></footer></div>
		</dialog> : null}
		</section>
	);
}
