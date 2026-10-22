import type { ClientParams, ClientResult } from "@metis/app-protocol";
import { Info, Terminal } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { FloatingSystemNotice } from "./SystemNotice.tsx";

const MAX_AUTO_COMMAND_RULES = 64;

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
	const [loadRequest, setLoadRequest] = useState(0);
	const [command, setCommand] = useState("");
	const [allowNetwork, setAllowNetwork] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies(loadRequest): Retry explicitly reloads Auto command rules.
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
	}, [api, loadRequest, serverReady, t]);

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), 2_500);
		return () => clearTimeout(timer);
	}, [notice]);

	const save = async (rules: ClientParams<"permission/auto/update">["rules"]): Promise<boolean> => {
		setSaving(true);
		setError(null);
		try {
			setView(await api.updatePermissionAutoSettings({ requestId: crypto.randomUUID(), rules }));
			setNotice(t("Auto command rules updated."));
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("Auto command rules could not be saved."));
			return false;
		} finally {
			setSaving(false);
		}
	};

	const add = async (rawCommand: string, network: boolean) => {
		if (!view || saving) return;
		const nextCommand = normalizeCommand(rawCommand);
		if (!nextCommand) return;
		if (view.rules.some((rule) => rule.command === nextCommand)) {
			setError(t("This command is already on the allowlist."));
			return;
		}
		if (view.rules.length >= MAX_AUTO_COMMAND_RULES) {
			setError(t("The allowlist can hold at most {{max}} commands.", { max: MAX_AUTO_COMMAND_RULES }));
			return;
		}
		if (await save([...view.rules, { command: nextCommand, allowNetwork: network }])) {
			setCommand("");
			setAllowNetwork(false);
		}
	};

	const addSuggestions = async () => {
		if (!view || saving || !suggestions.length) return;
		if (view.rules.length + suggestions.length > MAX_AUTO_COMMAND_RULES) {
			setError(t("The allowlist can hold at most {{max}} commands.", { max: MAX_AUTO_COMMAND_RULES }));
			return;
		}
		await save([...view.rules, ...suggestions.map((suggestion) => ({ command: suggestion, allowNetwork: false }))]);
	};

	if (!view && !error) {
		return <output aria-label={t("Loading Auto command rules")} className="status-block settings-loading" />;
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
				{view ? (
					<span className="auto-command-allowlist-count">
						{view.rules.length} / {MAX_AUTO_COMMAND_RULES}
					</span>
				) : null}
			</div>
			{error ? (
				<p className="settings-inline-error" role="alert">
					{error}
				</p>
			) : null}
			{!view && error ? (
				<button
					className="settings-secondary-button"
					disabled={!serverReady}
					onClick={() => {
						setError(null);
						setLoadRequest((request) => request + 1);
					}}
					type="button"
				>
					{t("Retry")}
				</button>
			) : null}
			{view ? (
				<div className="settings-card auto-command-allowlist-card">
					<form
						className="auto-command-allowlist-form"
						onSubmit={(event) => {
							event.preventDefault();
							void add(command, allowNetwork);
						}}
					>
						<input
							aria-label={t("Command")}
							disabled={busy}
							onChange={(event) => setCommand(event.target.value)}
							onKeyDown={(event) => {
								if (event.key !== "Enter") return;
								event.preventDefault();
								void add(command, allowNetwork);
							}}
							placeholder={t("Add a command…")}
							type="text"
							value={command}
						/>
						<label className="auto-command-allowlist-toggle">
							<input
								aria-label={t("Allow network access")}
								checked={allowNetwork}
								disabled={busy}
								onChange={(event) => setAllowNetwork(event.target.checked)}
								type="checkbox"
							/>
							<span aria-hidden="true" className="auto-command-allowlist-toggle-track" />
							<span className="auto-command-allowlist-toggle-text">{t("Allow network access")}</span>
						</label>
						<button
							className="settings-primary-button"
							disabled={busy || !normalizeCommand(command)}
							type="submit"
						>
							{t("Add command")}
						</button>
					</form>
					{view.rules.length === 0 ? (
						<div className="auto-command-allowlist-empty">
							<Terminal aria-hidden="true" size={20} />
							<p>{t("No commands on the allowlist yet.")}</p>
							<span>{t("Add a simple command above, or pick one of the suggestions below.")}</span>
						</div>
					) : (
						<div className="auto-command-allowlist-rules">
							{view.rules.map((rule) => (
								<span className="auto-command-allowlist-chip" key={rule.command}>
									<code>{rule.command}</code>
									{rule.allowNetwork ? (
										<span className="auto-command-allowlist-network">{t("Network")}</span>
									) : null}
									<button
										aria-label={t("Remove {{command}}", { command: rule.command })}
										disabled={busy}
										onClick={() =>
											void save(view.rules.filter((candidate) => candidate.command !== rule.command))
										}
										type="button"
									>
										{t("Remove {{command}}", { command: rule.command })}
									</button>
								</span>
							))}
						</div>
					)}
					{suggestions.length ? (
						<div className="auto-command-allowlist-footer">
							<div className="auto-command-allowlist-footer-header">
								<span className="auto-command-allowlist-footer-label">{t("Suggestions")}</span>
								<div className="auto-command-allowlist-suggestions">
									{suggestions.map((suggestion) => (
										<button
											aria-label={t("Add {{command}}", { command: suggestion })}
											className="auto-command-allowlist-suggestion"
											disabled={busy}
											key={suggestion}
											onClick={() => void add(suggestion, false)}
											type="button"
										>
											{`+ ${suggestion}`}
										</button>
									))}
								</div>
							</div>
							<button
								className="settings-secondary-button auto-command-allowlist-add-all"
								disabled={busy || view.rules.length + suggestions.length > MAX_AUTO_COMMAND_RULES}
								onClick={() => void addSuggestions()}
								type="button"
							>
								{t("Add Suggestions")}
							</button>
						</div>
					) : null}
					<div className="auto-command-allowlist-info">
						<Info aria-hidden="true" size={15} />
						<span>
							{t(
								"Complex shell syntax, sensitive files, destructive operations, and hard-denied commands still require review or remain blocked.",
							)}
						</span>
					</div>
				</div>
			) : null}
			{notice ? <FloatingSystemNotice title={notice} tone="success" /> : null}
		</section>
	);
}
