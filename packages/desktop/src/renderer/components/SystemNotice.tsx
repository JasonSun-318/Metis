import { CheckCircle, Info, Warning, X, XCircle } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export type SystemNoticeTone = "info" | "success" | "warning" | "error";

export interface SystemNoticeCopy {
	readonly title: string;
	readonly message?: string;
}

export interface SystemNoticeProps extends SystemNoticeCopy {
	readonly tone: SystemNoticeTone;
	readonly action?: { readonly label: string; readonly onClick: () => void };
	readonly onDismiss?: () => void;
}

const icons = {
	info: Info,
	success: CheckCircle,
	warning: Warning,
	error: XCircle,
} as const;

export function systemErrorNotice(message: string): SystemNoticeCopy {
	const detail = message.trim();
	if (/\b404\b|not found/iu.test(detail) && /api|endpoint|model|openai|provider/iu.test(detail)) {
		return {
			title: "Model configuration needs attention",
			message: "The model endpoint returned 404. Check the provider protocol, Base URL, and model ID in Model Settings.",
		};
	}
	if (/\b401\b|unauthorized|invalid api key|authentication/iu.test(detail)) {
		return {
			title: "API key was rejected",
			message: "Check the provider API key in Model Settings and try again.",
		};
	}
	if (/\b403\b|forbidden|permission denied|access denied/iu.test(detail)) {
		return {
			title: "Model access was denied",
			message: "This API key cannot use the selected model. Check the account plan and model access.",
		};
	}
	if (/\b429\b|rate.?limit|too many requests/iu.test(detail)) {
		return {
			title: "Model provider is busy",
			message: "The provider rate limit was reached. Wait briefly or choose another model, then try again.",
		};
	}
	if (/timed? out|timeout/iu.test(detail)) {
		return {
			title: "Model request timed out",
			message: "The provider did not respond in time. Check your connection and try again.",
		};
	}
	if (/network|offline|fetch failed|econn|enotfound|socket/iu.test(detail)) {
		return {
			title: "Connection failed",
			message: "Metis could not reach the service. Check your network or proxy and try again.",
		};
	}
	return {
		title: "Request failed",
		message: detail && detail !== "Metis could not complete the request."
			? detail
			: "The request did not complete. Try again; if it keeps failing, check the selected model and connection.",
	};
}

export function systemErrorNoticeForCode(code: string): SystemNoticeCopy {
	switch (code) {
		case "MODEL_ENDPOINT_NOT_FOUND":
			return systemErrorNotice("Model API error 404");
		case "MODEL_AUTHENTICATION_FAILED":
			return systemErrorNotice("Model API error 401");
		case "MODEL_ACCESS_DENIED":
			return systemErrorNotice("Model API error 403");
		case "MODEL_RATE_LIMITED":
			return systemErrorNotice("Model API error 429");
		case "MODEL_TIMEOUT":
			return systemErrorNotice("Model request timed out");
		case "MODEL_NETWORK_ERROR":
			return systemErrorNotice("Model network error");
		case "MODEL_REQUEST_FAILED":
			return {
				title: "Model request failed",
				message: "The provider could not complete the request. Try again or choose another configured model.",
			};
		default:
			return {
				title: "Task stopped",
				message: "The task stopped before it completed. Send a new message to continue.",
			};
	}
}

export function SystemNotice({ action, message, onDismiss, title, tone }: SystemNoticeProps) {
	const { t } = useTranslation();
	const Icon = icons[tone];
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;
	useEffect(() => {
		if (!onDismiss) return;
		const timer = setTimeout(() => onDismissRef.current?.(), 5_000);
		return () => clearTimeout(timer);
	}, [message, onDismiss !== undefined, title, tone]);
	return (
		<div className="system-notice" data-tone={tone} role={tone === "error" || tone === "warning" ? "alert" : "status"}>
			<Icon aria-hidden="true" className="system-notice-icon" size={18} weight="regular" />
			<div className="system-notice-copy">
				<strong>{t(title)}</strong>
				{message && <span>{t(message)}</span>}
			</div>
			{action && <button className="system-notice-action" onClick={action.onClick} type="button">{t(action.label)}</button>}
			{onDismiss && (
				<button aria-label={t("Dismiss notification")} className="system-notice-dismiss" onClick={onDismiss} type="button">
					<X aria-hidden="true" size={14} />
				</button>
			)}
		</div>
	);
}

export function FloatingSystemNotice(props: SystemNoticeProps) {
	return <div className="system-notice-stack is-global"><SystemNotice {...props} /></div>;
}
