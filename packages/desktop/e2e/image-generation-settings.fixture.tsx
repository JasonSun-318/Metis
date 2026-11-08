import type { ModelSettingsView } from "@metis/app-protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ModelSettingsPanel } from "../src/renderer/components/ModelSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
void setLocale(params.get("locale") === "en" ? "en" : "zh-CN");
let settings: ModelSettingsView = {
	defaultModel: null,
	defaultThinkingSelection: "medium",
	autoSessionTitle: true,
	loadError: null,
	permissionReviewer: { config: null, status: "unconfigured" },
	imageGeneration: { config: null, status: "unconfigured", authConfigured: false },
	providers: [
		{
			provider: "studio",
			name: "Studio API",
			builtin: false,
			api: "openai-completions",
			baseUrl: "https://images.example/v1",
			auth: { configured: true, source: "stored" },
			storedApiKey: true,
			models: [],
		},
	],
};
if (["configured", "invalid"].includes(params.get("state") ?? "")) {
	const status = params.get("state") === "invalid" ? "invalid" : "configured";
	settings = {
		...settings,
		imageGeneration: {
			status,
			authConfigured: status === "configured",
			config: {
				name: "创作工作室的专用生图模型（用于测试很长的名称与模型 ID）",
				api: "openrouter-images",
				baseUrl: "https://openrouter.ai/api/v1",
				modelId: "google/gemini-3.1-flash-image",
			},
		},
		permissionReviewer: {
			status,
			authConfigured: status === "configured",
			config: {
				source: "dedicated",
				name: "工作室的专用审批模型（reviewer）",
				api: "openai-completions",
				baseUrl: "https://reviewer.example/v1",
				modelId: "reviewer-model",
				thinkingLevel: "off",
				reasoningMode: "off",
				timeoutMs: 8000,
				maxOutputTokens: 512,
			},
		},
	};
}
const api: Parameters<typeof ModelSettingsPanel>[0]["api"] = {
	getModelSettings: async () => settings,
	updateModelSettings: async ({ mutation }) => {
		if (params.get("error") === "1") throw new Error("无法保存设置，请稍后重试。表单内容已保留。");
		if (mutation.type === "set_image_generation")
			settings = {
				...settings,
				imageGeneration: {
					config: mutation.config,
					status: mutation.config ? "configured" : "unconfigured",
					authConfigured: mutation.config !== null,
				},
			};
		else if (mutation.type === "set_permission_reviewer")
			settings = {
				...settings,
				permissionReviewer: {
					config: mutation.config,
					status: mutation.config ? "configured" : "unconfigured",
					authConfigured: mutation.config !== null,
				},
			};
		else throw new Error("Unexpected fixture mutation");
		return settings;
	},
	testModelConnection: async () => {
		throw new Error("Live model calls are not part of this fixture");
	},
	discoverModels: async () => {
		throw new Error("Live model calls are not part of this fixture");
	},
};
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<main className="settings-page fixture-settings">
			<header>
				<h1>模型设置</h1>
			</header>
			<ModelSettingsPanel api={api} initialSettings={settings} serverReady />
		</main>
	</StrictMode>,
);
