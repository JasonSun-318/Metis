import type { ClientResult } from "@metis/app-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopUpdateState, MetisDesktopApi } from "../../shared/desktop-api.ts";
import { DownloadSimple, ShieldCheck, Warning } from "../icons.tsx";
import "../styles/sandbox-environment.css";

type SandboxReport = ClientResult<"permission/sandbox/health">;
type SandboxCheck = NonNullable<SandboxReport["checks"]>[number];
type SandboxCheckId = SandboxCheck["id"];

const CHECK_LABEL_KEYS: Record<SandboxCheckId, string> = {
	platform: "Platform support",
	package: "Bundled sandbox package",
	dependencies: "System dependencies",
	"sandbox-startup": "Sandbox startup",
	"filesystem-permitted": "Permitted workspace access",
	"filesystem-denied": "Blocked outside access",
	"network-denied": "Blocked network access",
};

function reasonLabel(t: (key: string) => string, reason: string | undefined): string | null {
	switch (reason) {
		case "not-applicable":
			return t("This check does not apply on this platform.");
		case "not-run":
			return t("Not run yet.");
		case "readiness-failed":
			return t("Readiness checks have not passed.");
		case "unsupported-platform":
			return t("The platform is not supported.");
		case "unsupported-architecture":
			return t("The architecture is not supported.");
		case "helper-missing":
			return t("The sandbox helper is missing.");
		case "helper-invalid":
			return t("The sandbox helper failed verification.");
		case "dependency-unavailable":
			return t("A required system dependency is missing.");
		case "probe-failed":
			return t("The diagnostic probe failed.");
		case "sandbox-start-failed":
			return t("The sandbox could not start.");
		case "workspace-write-failed":
			return t("Writing inside the temporary workspace failed.");
		case "outside-read-not-denied":
			return t("Reading outside the temporary workspace was not blocked.");
		case "network-probe-unavailable":
			return t("No local network probe was available.");
		case "network-not-denied":
			return t("Network access was not blocked.");
		default:
			return null;
	}
}

/** 权限设置页：沙箱就绪状态、显式自检结果与受支持的具体修复操作。 */
export function SandboxEnvironmentCard({
	api,
	serverReady,
}: {
	readonly api: MetisDesktopApi;
	readonly serverReady: boolean;
}) {
	const { t } = useTranslation();
	const [report, setReport] = useState<SandboxReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [selfTesting, setSelfTesting] = useState(false);
	const [repairing, setRepairing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [checkingUpdate, setCheckingUpdate] = useState(false);
	const [updating, setUpdating] = useState(false);
	const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
	const requestRef = useRef(0);

	const loadReadiness = useCallback(async () => {
		const request = ++requestRef.current;
		setLoading(true);
		setError(null);
		try {
			const result = await api.getPermissionSandboxHealth();
			if (request === requestRef.current) setReport(result);
		} catch {
			if (request === requestRef.current) setError(t("The sandbox check could not be completed."));
		} finally {
			if (request === requestRef.current) setLoading(false);
		}
	}, [api, t]);

	useEffect(() => {
		if (!serverReady) return;
		void loadReadiness();
		return () => {
			requestRef.current += 1;
		};
	}, [loadReadiness, serverReady]);

	const runSelfTest = useCallback(async () => {
		if (!serverReady) return;
		const request = ++requestRef.current;
		setSelfTesting(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.runPermissionSandboxSelfTest();
			if (request !== requestRef.current) return;
			setReport(result);
		} catch {
			if (request === requestRef.current) setError(t("The sandbox self-test could not be completed."));
		} finally {
			if (request === requestRef.current) setSelfTesting(false);
		}
	}, [api, serverReady, t]);

	const repairWindowsSandbox = useCallback(async () => {
		if (!serverReady) return;
		setRepairing(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.installWorkspaceSandbox();
			if (result === "cancelled") setNotice(t("Windows sandbox setup was cancelled."));
			else if (result === "unsupported") setNotice(t("Windows sandbox setup is not supported on this device."));
			else {
				setNotice(t("Windows sandbox is ready."));
				await loadReadiness();
			}
		} catch {
			setError(t("The Windows sandbox could not be repaired."));
		} finally {
			setRepairing(false);
		}
	}, [api, loadReadiness, serverReady, t]);

	const checkForUpdate = useCallback(async () => {
		if (!serverReady) return;
		setCheckingUpdate(true);
		setError(null);
		setNotice(null);
		try {
			const next = await api.checkForUpdate();
			setUpdateState(next);
			if (next.status === "unavailable") {
				setNotice(t("Metis is up to date. Reinstall the app from the source you used to install it."));
			}
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : "";
			if (message.includes("unavailable in this build") || message.includes("not supported in this build")) {
				setNotice(t("Update checks are not available in this build. Reinstall Metis from the source you used."));
			} else {
				setError(t("Could not check for updates. Check your connection and try again."));
			}
		} finally {
			setCheckingUpdate(false);
		}
	}, [api, serverReady, t]);

	const startUpdate = useCallback(async () => {
		if (!serverReady) return;
		setUpdating(true);
		setError(null);
		setNotice(null);
		let unsubscribe = () => {};
		try {
			unsubscribe = api.subscribeUpdate((state) => setUpdateState(state));
			await api.startUpdate();
			setNotice(t("The update installer was opened."));
		} catch {
			setError(t("The update could not be downloaded or opened."));
		} finally {
			unsubscribe();
			setUpdating(false);
		}
	}, [api, serverReady, t]);

	const issues = (report?.checks ?? []).filter(
		(check) =>
			check.status === "failed" ||
			(check.status === "skipped" &&
				!["not-applicable", "not-run", "readiness-failed", "sandbox-unavailable"].includes(check.reason ?? "")),
	);
	const dependentChecksSkipped = report?.checks?.some(
		(check) => check.status === "skipped" && ["readiness-failed", "sandbox-unavailable"].includes(check.reason ?? ""),
	);
	const recoveryActions = report?.recoveryActions ?? [];
	const verified =
		report?.mode === "self-test" && report.status === "healthy" && report.code === "ready" && issues.length === 0;
	const needsAttention =
		issues.length > 0 || (report && report.status !== "healthy") || report?.code === "self-test-incomplete";
	const tone = verified ? "ok" : needsAttention ? "warn" : "idle";
	const label =
		selfTesting || loading
			? t("Checking…")
			: error
				? t("Needs attention")
				: verified
					? t("Available")
					: report?.code === "self-test-incomplete"
						? t("Check incomplete")
						: needsAttention
							? t("Unavailable")
							: t("Not checked");
	const busy = loading || selfTesting || repairing || checkingUpdate || updating;
	const updateProgress = updateState?.status === "downloading" ? updateState.progress : null;

	return (
		<article aria-busy={selfTesting || loading} className="settings-card sandbox-environment-card">
			<header className="sandbox-environment-header">
				<div className="sandbox-environment-heading">
					<ShieldCheck aria-hidden="true" size={18} />
					<h4>{t("Sandbox environment")}</h4>
				</div>
				<span aria-live="polite" className={`sandbox-environment-status ${busy ? "idle" : error ? "warn" : tone}`}>
					{label}
				</span>
				<button
					aria-label={t("Run sandbox self-test")}
					className="settings-secondary-button"
					disabled={!serverReady || busy}
					onClick={() => void runSelfTest()}
					type="button"
				>
					{selfTesting ? t("Checking…") : report?.mode === "self-test" ? t("Check again") : t("Check sandbox")}
				</button>
			</header>
			{!selfTesting && issues.length > 0 ? (
				<ul className="sandbox-environment-issues">
					{issues.map((check) => {
						const repair =
							(check.id === "dependencies" || (report?.mode === "self-test" && check.status === "failed")) &&
							recoveryActions.includes("install-windows-sandbox");
						const update =
							(check.id === "package" || (report?.mode === "self-test" && check.status === "failed")) &&
							recoveryActions.includes("check-app-update");
						return (
							<li className="sandbox-environment-issue" key={check.id}>
								<Warning aria-hidden="true" size={16} />
								<div>
									<strong>{reasonLabel(t, check.reason) ?? t(CHECK_LABEL_KEYS[check.id])}</strong>
									{check.id === "dependencies" && !repair ? (
										<p>
											{t(
												"Install the missing system sandbox components with your operating system's package manager, then retry.",
											)}
										</p>
									) : null}
								</div>
								{check.id !== "platform" ? (
									<button
										className="settings-secondary-button"
										disabled={!serverReady || busy}
										onClick={() =>
											void (repair ? repairWindowsSandbox() : update ? checkForUpdate() : runSelfTest())
										}
										type="button"
									>
										{repair
											? t(repairing ? "Repairing Windows sandbox…" : "Repair Windows sandbox")
											: update
												? t(checkingUpdate ? "Checking for updates…" : "Check for app update")
												: t("Retry")}
									</button>
								) : null}
							</li>
						);
					})}
				</ul>
			) : null}
			{!selfTesting && dependentChecksSkipped ? (
				<p className="sandbox-environment-notice">
					{t("Remaining checks were not run. Resolve the issue above and check again.")}
				</p>
			) : null}
			{!selfTesting && needsAttention && issues.length === 0 && !dependentChecksSkipped ? (
				<p className="sandbox-environment-notice">{t("The sandbox is unavailable.")}</p>
			) : null}
			{error ? (
				<div className="sandbox-environment-error">
					<p className="settings-inline-error" role="alert">
						{error}
					</p>
					<button
						className="settings-secondary-button"
						disabled={!serverReady || busy}
						onClick={() => void loadReadiness()}
						type="button"
					>
						{t("Retry")}
					</button>
				</div>
			) : null}
			{notice ? (
				<p aria-live="polite" className="sandbox-environment-notice">
					{notice}
				</p>
			) : null}

			{updateState?.status === "available" || updateState?.status === "ready" ? (
				<div className="sandbox-environment-update">
					<p>
						{updateState.status === "ready"
							? t("Update {{version}} is ready to open.", { version: updateState.version })
							: t("Version {{version}} is available.", { version: updateState.version })}
					</p>
					<button
						className="settings-secondary-button"
						disabled={!serverReady || busy}
						onClick={() => void startUpdate()}
						type="button"
					>
						<DownloadSimple aria-hidden="true" size={15} />
						{updating
							? t("Opening update…")
							: updateState.status === "ready"
								? t("Open downloaded update")
								: t("Download and open update")}
					</button>
				</div>
			) : null}
			{updateProgress !== null ? (
				<div className="sandbox-environment-update-progress">
					<progress aria-label={t("Update download progress")} max={100} value={updateProgress} />
					<span>{t("Downloading update… {{progress}}%", { progress: updateProgress })}</span>
				</div>
			) : null}
		</article>
	);
}
