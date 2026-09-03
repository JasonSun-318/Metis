import type { ClientParams, ClientResult } from "@metis/app-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

function normalizeCommand(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export function AutoCommandAllowlistPanel({
	api,
	serverReady,
}: {
	readonly api: Pick<MetisDesktopApi, "getPermissionAutoSettings" | "updatePermissionAutoSettings">;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [view, setView] = useState<ClientResult<"permission/auto/get"> | null>(null);
	const [command, setCommand] = useState("");
	const [allowNetwork, setAllowNetwork] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setError(null);
		void api.getPermissionAutoSettings().then(
			(result) => {
				if (current) setView(result);
			},
			(cause) => {
				if (current) setError(cause instanceof Error ? cause.message : t("Couldn’t load Auto command rules."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, serverReady, t]);

	const save = async (rules: ClientParams<"permission/auto/update">["rules"]) => {
		setSaving(true);
		setError(null);
		try {
			setView(await api.updatePermissionAutoSettings({ requestId: crypto.randomUUID(), rules }));
			setCommand("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Auto command rules could not be saved."));
		} finally {
			setSaving(false);
		}
	};

	const add = (rawCommand: string, network: boolean) => {
		if (!view || saving) return;
		const nextCommand = normalizeCommand(rawCommand);
		if (!nextCommand) return;
		if (view.rules.some((rule) => rule.command === nextCommand)) {
			setError(t("This command is already on the allowlist."));
			return;
		}
		void save([...view.rules, { command: nextCommand, allowNetwork: network }]);
	};

	if (!view && !error) {
		return <div aria-label={t("Loading Auto command rules")} className="settings-loading" role="status" />;
	}

	const present = new Set(view?.rules.map((rule) => rule.command) ?? []);
	const suggestions = (view?.suggestions ?? []).filter((suggestion) => !present.has(suggestion));
	const busy = saving || !serverReady;

	return (
		<section className="settings-page auto-command-allowlist-page">
			<div className="settings-section-heading">
				<div>
					<h2>{t("Command allowlist")}</h2>
					<p>{t("Simple commands listed here may run automatically outside the workspace in Auto mode.")}</p>
				</div>
			</div>
			{error ? (
				<p className="settings-inline-error" role="alert">
					{error}
				</p>
			) : null}
			{view ? (
				<>
					<form
						className="auto-command-allowlist-form"
						onSubmit={(event) => {
							event.preventDefault();
							add(command, allowNetwork);
						}}
					>
						<label>
							{t("Command")}
							<input
								disabled={busy}
								onChange={(event) => setCommand(event.target.value)}
								onKeyDown={(event) => {
									if (event.key !== "Enter") return;
									event.preventDefault();
									add(command, allowNetwork);
								}}
								placeholder={t("Add a command…")}
								type="text"
								value={command}
							/>
						</label>
						<label className="auto-command-allowlist-network-toggle">
							<input
								aria-label={t("Allow network access")}
								checked={allowNetwork}
								disabled={busy}
								onChange={(event) => setAllowNetwork(event.target.checked)}
								type="checkbox"
							/>
							{t("Allow network access")}
						</label>
						<button className="settings-primary-button" disabled={busy || !normalizeCommand(command)} type="submit">
							{t("Add command")}
						</button>
					</form>
					{view.rules.length === 0 ? <p>{t("No commands on the allowlist yet.")}</p> : null}
					{view.rules.length ? (
						<ul className="auto-command-allowlist-chips">
							{view.rules.map((rule) => (
								<li className="auto-command-allowlist-chip" key={rule.command}>
									<code>{rule.command}</code>
									{rule.allowNetwork ? <span className="auto-command-allowlist-network">{t("Network")}</span> : null}
									<button
										aria-label={t("Remove {{command}}", { command: rule.command })}
										disabled={busy}
										onClick={() => void save(view.rules.filter((candidate) => candidate.command !== rule.command))}
										type="button"
									>
										{t("Remove {{command}}", { command: rule.command })}
									</button>
								</li>
							))}
						</ul>
					) : null}
					{suggestions.length ? (
						<div className="auto-command-allowlist-suggestions">
							{suggestions.map((suggestion) => (
								<button
									aria-label={t("Add {{command}}", { command: suggestion })}
									className="auto-command-allowlist-suggestion"
									disabled={busy}
									key={suggestion}
									onClick={() => add(suggestion, false)}
									type="button"
								>
									{t("Add {{command}}", { command: suggestion })}
								</button>
							))}
						</div>
					) : null}
				</>
			) : null}
			<p>
				{t(
					"Complex shell syntax, sensitive files, destructive operations, and hard-denied commands still require review or remain blocked.",
				)}
			</p>
		</section>
	);
}
