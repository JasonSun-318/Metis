import type {
	ClientResult,
	ModelSettingsView,
	PermissionPresetView,
	PermissionReviewerDedicatedConfigView,
	PermissionReviewerProviderConfigView,
	SessionSnapshot,
} from "@metis/app-protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { Browser, Info } from "../icons.tsx";
import { AutoCommandAllowlistPanel } from "./AutoCommandAllowlistPanel.tsx";
import {
	type RememberedFocus,
	type RememberedGroup,
	RememberedPermissionsDialog,
	type RememberedRule,
} from "./RememberedPermissionsDialog.tsx";
import { ReviewerModelSettingsPanel } from "./ReviewerModelSettingsPanel.tsx";
import { SandboxEnvironmentCard } from "./SandboxEnvironmentCard.tsx";

type Catalog = ClientResult<"permission/rules/catalog">;

function reviewerSummaryLabel(
	settings: ModelSettingsView | null,
	t: (key: string) => string,
): { readonly text: string; readonly tone: "ok" | "unset" | "invalid" } {
	if (!settings) return { text: t("Couldn’t load model settings."), tone: "invalid" };
	const reviewer = settings.permissionReviewer;
	if (reviewer.status === "invalid") {
		return {
			text: t(
				"The saved approval model configuration is invalid. Choose a supported provider, model, and reasoning level.",
			),
			tone: "invalid",
		};
	}
	const config = reviewer.config;
	if (!config) {
		return { text: t("No approval model configured"), tone: "unset" };
	}
	if ((config as { readonly source?: unknown }).source === "dedicated") {
		const dedicated = config as PermissionReviewerDedicatedConfigView;
		if (reviewer.authConfigured === false) {
			return { text: t("The saved approval model is missing its API key."), tone: "invalid" };
		}
		return {
			text: `${t("Approval model configured")}: ${dedicated.name} · ${dedicated.modelId}`,
			tone: "ok",
		};
	}
	const shared = config as PermissionReviewerProviderConfigView;
	const provider = settings.providers.find((candidate) => candidate.provider === shared.provider);
	const model = provider?.models.find((candidate) => candidate.modelId === shared.modelId);
	return {
		text: `${t("Approval model configured")}: ${provider?.name ?? shared.provider} · ${model?.name ?? shared.modelId}`,
		tone: "ok",
	};
}

function sameGroup(left: RememberedGroup, right: RememberedGroup): boolean {
	return (
		left.scope === right.scope &&
		left.projectPath === right.projectPath &&
		(left.sessionId ?? null) === (right.sessionId ?? null)
	);
}

function groupHasRule(group: RememberedGroup, ruleId: string): boolean {
	return group.rules.some((rule) => rule.id === ruleId);
}

/** 权限设置页：全局命令规则、Auto 审批、执行环境与全局记住的授权。 */
export function PermissionSettingsPanel({
	api,
	focusRuleId,
	focusRuleScope,
	onOpenBrowserSettings,
	serverReady,
}: {
	readonly api: MetisDesktopApi;
	readonly focusRuleId?: string;
	readonly focusRuleScope?: string;
	readonly onOpenBrowserSettings?: () => void;
	readonly serverReady: boolean;
	/** Reserved for the parent shell; the global page renders no conversation context. */
	readonly permissionPreset?: PermissionPresetView;
	readonly sessionCwd?: string | null;
	readonly sessionId?: string;
	readonly sessionTitle?: string;
	readonly sandboxHealth?: SessionSnapshot["sandboxHealth"];
}) {
	const { t } = useTranslation();

	const [autoView, setAutoView] = useState<ClientResult<"permission/auto/get"> | null>(null);
	const [autoError, setAutoError] = useState<string | null>(null);
	const [autoLoadRequest, setAutoLoadRequest] = useState(0);
	const [switchSaving, setSwitchSaving] = useState(false);
	const [reviewerOpen, setReviewerOpen] = useState(false);

	const [modelSettings, setModelSettings] = useState<ModelSettingsView | null>(null);
	const [modelError, setModelError] = useState<string | null>(null);
	const [modelLoadRequest, setModelLoadRequest] = useState(0);

	const [catalog, setCatalog] = useState<Catalog | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [catalogRequest, setCatalogRequest] = useState(0);
	const [managerOpen, setManagerOpen] = useState(false);
	const [managerFocus, setManagerFocus] = useState<RememberedFocus | null>(null);
	const [revokeBusy, setRevokeBusy] = useState<string | null>(null);
	const [revokeError, setRevokeError] = useState<string | null>(null);
	const appliedFocusRef = useRef<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies(autoLoadRequest): Retry explicitly reloads Auto settings.
	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setAutoError(null);
		void api.getPermissionAutoSettings().then(
			(result) => {
				if (current) setAutoView(result);
			},
			(cause) => {
				if (current) setAutoError(cause instanceof Error ? cause.message : t("Couldn’t load permission settings."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, autoLoadRequest, serverReady, t]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(modelLoadRequest): Retry explicitly reloads model settings.
	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setModelError(null);
		void api.getModelSettings().then(
			(result) => {
				if (current) setModelSettings(result);
			},
			(cause) => {
				if (current) setModelError(cause instanceof Error ? cause.message : t("Couldn’t load model settings."));
			},
		);
		return () => {
			current = false;
		};
	}, [api, modelLoadRequest, serverReady, t]);

	// Global grants do not depend on a selected conversation.
	// biome-ignore lint/correctness/useExhaustiveDependencies(catalogRequest): Retry explicitly reloads remembered permissions.
	useEffect(() => {
		if (!serverReady) return;
		let current = true;
		setCatalogError(null);
		void api.listRememberedPermissionRules().then(
			(result) => {
				if (current) setCatalog(result);
			},
			(cause) => {
				if (current) {
					setCatalogError(
						cause instanceof Error ? cause.message : t("Remembered permissions could not be loaded."),
					);
				}
			},
		);
		return () => {
			current = false;
		};
	}, [api, catalogRequest, serverReady, t]);

	// An audit "View rule" link opens the manager at the owning project/session group.
	useEffect(() => {
		if (!focusRuleId || !catalog || appliedFocusRef.current === focusRuleId) return;
		const group = catalog.groups.find(
			(candidate) =>
				((focusRuleScope !== "project" && focusRuleScope !== "session") || candidate.scope === focusRuleScope) &&
				groupHasRule(candidate, focusRuleId),
		);
		if (!group) return;
		appliedFocusRef.current = focusRuleId;
		setRevokeError(null);
		setManagerFocus({ id: focusRuleId, scope: focusRuleScope });
		setManagerOpen(true);
	}, [catalog, focusRuleId, focusRuleScope]);

	const reviewerEnabled = autoView?.reviewerEnabled ?? false;

	const toggleReviewer = async () => {
		if (!autoView || switchSaving) return;
		const next = !autoView.reviewerEnabled;
		setSwitchSaving(true);
		setAutoError(null);
		try {
			// 只 patch reviewerEnabled，不携带并覆盖旧命令规则。
			setAutoView(await api.updatePermissionAutoSettings({ requestId: crypto.randomUUID(), reviewerEnabled: next }));
		} catch (cause) {
			setAutoError(cause instanceof Error ? cause.message : t("Permission settings could not be saved."));
		} finally {
			setSwitchSaving(false);
		}
	};

	const revokeRule = async (group: RememberedGroup, rule: RememberedRule) => {
		if (revokeBusy || !serverReady) return;
		setRevokeBusy(rule.id);
		setRevokeError(null);
		try {
			const requestId = crypto.randomUUID();
			if (group.scope === "session") {
				if (!group.sessionId) throw new Error("The live session grant is missing its owner.");
				await api.revokeRememberedPermissionRule({
					requestId,
					scope: "session",
					sessionId: group.sessionId,
					ruleId: rule.id,
				});
			} else {
				await api.revokeRememberedPermissionRule({
					requestId,
					scope: "project",
					projectPath: group.projectPath,
					ruleId: rule.id,
				});
			}
			setCatalog((previous) =>
				previous
					? {
							groups: previous.groups
								.map((candidate) =>
									sameGroup(candidate, group)
										? { ...candidate, rules: candidate.rules.filter((entry) => entry.id !== rule.id) }
										: candidate,
								)
								.filter((candidate) => candidate.rules.length > 0),
						}
					: previous,
			);
		} catch (cause) {
			setRevokeError(cause instanceof Error ? cause.message : t("The permission could not be revoked."));
		} finally {
			setRevokeBusy(null);
		}
	};

	const reviewerSummary = reviewerSummaryLabel(modelSettings, t);
	const groups = catalog?.groups ?? [];
	const rememberedTotal = groups.reduce((total, group) => total + group.rules.length, 0);
	const dialogError = revokeError ?? catalogError;

	return (
		<div className="settings-page permission-settings-page">
			<AutoCommandAllowlistPanel api={api} embedded focusRuleId={focusRuleId} serverReady={serverReady} />

			<section className="settings-section permission-auto-approval">
				<div className="settings-section-heading">
					<div>
						<h3>{t("Auto model approvals")}</h3>
						<p>{t("Use the approval model for actions that no enabled rule matches.")}</p>
					</div>
				</div>
				{!autoView && !autoError ? (
					<output aria-label={t("Loading permission settings")} className="status-block settings-loading" />
				) : null}
				{autoError ? (
					<>
						<p className="settings-inline-error" role="alert">
							{autoError}
						</p>
						<button
							className="settings-secondary-button"
							disabled={!serverReady}
							onClick={() => {
								setAutoError(null);
								setAutoLoadRequest((request) => request + 1);
							}}
							type="button"
						>
							{t("Retry")}
						</button>
					</>
				) : null}
				{autoView ? (
					<article className="settings-card permission-approval-card">
						<div className="permission-approval-header">
							<label className="auto-command-allowlist-toggle permission-approval-toggle">
								<input
									aria-label={t("Use the approval model in Auto mode")}
									checked={reviewerEnabled}
									disabled={switchSaving}
									onChange={() => void toggleReviewer()}
									type="checkbox"
								/>
								<span aria-hidden="true" className="auto-command-allowlist-toggle-track" />
								<span className="auto-command-allowlist-toggle-text">
									{t("Use the approval model in Auto mode")}
								</span>
							</label>
							<button
								className="settings-secondary-button"
								disabled={!serverReady || !modelSettings}
								onClick={() => setReviewerOpen(true)}
								type="button"
							>
								{reviewerSummary.tone === "ok" ? t("Edit approval model") : t("Configure approval model")}
							</button>
						</div>
						<p className={`permission-approval-summary ${reviewerSummary.tone}`}>{reviewerSummary.text}</p>
						{reviewerSummary.tone === "unset" ? (
							<p className="permission-approval-summary unset">
								{t("Pending Auto actions will be confirmed by you.")}
							</p>
						) : null}
						<p className="permission-approval-boundary">
							{t(
								"Ordinary writes, network access, and complex commands can be reviewed automatically. Sensitive or destructive actions still need your approval.",
							)}
						</p>
						{modelError ? (
							<>
								<p className="settings-inline-error" role="alert">
									{modelError}
								</p>
								<button
									className="settings-secondary-button"
									disabled={!serverReady}
									onClick={() => {
										setModelError(null);
										setModelLoadRequest((request) => request + 1);
									}}
									type="button"
								>
									{t("Retry")}
								</button>
							</>
						) : null}
						{modelSettings ? (
							<ReviewerModelSettingsPanel
								api={api}
								busy={switchSaving}
								onOpenChange={setReviewerOpen}
								onRequestClose={() => setReviewerOpen(false)}
								onSaved={setModelSettings}
								open={reviewerOpen}
								renderCard={false}
								serverReady={serverReady}
								settings={modelSettings}
							/>
						) : null}
					</article>
				) : null}
			</section>

			<section className="settings-section permission-execution-environment">
				<SandboxEnvironmentCard api={api} serverReady={serverReady} />
				<div className="permission-browser-link">
					<Info aria-hidden="true" size={15} />
					<span>{t("Browser actions are managed by the browser confirmation flow.")}</span>
					{onOpenBrowserSettings ? (
						<button className="permission-browser-link-button" onClick={onOpenBrowserSettings} type="button">
							<Browser aria-hidden="true" size={14} />
							{t("Manage browser settings")}
						</button>
					) : null}
				</div>
			</section>

			<section className="settings-section permission-remembered">
				<div className="settings-section-heading">
					<div>
						<h3>{t("Remembered permissions")}</h3>
						<p>
							{t(
								"Exact allow and deny grants from your approvals, grouped by their original project or live session.",
							)}
						</p>
					</div>
				</div>
				{!catalog && !catalogError ? (
					<output aria-label={t("Loading remembered permissions")} className="status-block settings-loading" />
				) : null}
				{catalogError && !catalog ? (
					<>
						<p className="settings-inline-error" role="alert">
							{catalogError}
						</p>
						<button
							className="settings-secondary-button"
							disabled={!serverReady}
							onClick={() => {
								setCatalogError(null);
								setCatalogRequest((request) => request + 1);
							}}
							type="button"
						>
							{t("Retry")}
						</button>
					</>
				) : null}
				{catalog ? (
					<article className="settings-card permission-remembered-summary">
						<div className="permission-remembered-row">
							<span className="permission-remembered-total">
								{t("Remembered: {{count}}", { count: rememberedTotal })}
							</span>
							<button
								className="settings-secondary-button"
								disabled={!serverReady}
								onClick={() => {
									setRevokeError(null);
									setManagerFocus(null);
									setManagerOpen(true);
								}}
								type="button"
							>
								{t("Manage remembered permissions")}
							</button>
						</div>
						{catalogError ? (
							<p className="settings-inline-error" role="alert">
								{catalogError}
							</p>
						) : null}
					</article>
				) : null}
			</section>

			{managerOpen && catalog ? (
				<RememberedPermissionsDialog
					busyRuleId={revokeBusy}
					error={dialogError}
					focus={managerFocus ?? undefined}
					groups={catalog.groups}
					loading={false}
					onClose={() => {
						if (revokeBusy === null) setManagerOpen(false);
					}}
					onRetry={() => {
						setCatalogError(null);
						setRevokeError(null);
						setCatalogRequest((request) => request + 1);
					}}
					onRevoke={(group, rule) => void revokeRule(group, rule)}
				/>
			) : null}
		</div>
	);
}
