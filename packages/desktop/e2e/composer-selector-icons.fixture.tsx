import type { ModelOptionView, PermissionPresetView } from "@metis/app-protocol";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelSelector } from "../src/renderer/components/ModelSelector.tsx";
import { PermissionSelector } from "../src/renderer/components/PermissionSelector.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { Trash } from "../src/renderer/icons.tsx";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

const params = new URLSearchParams(location.search);
const pane = params.has("pane");
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
if (params.has("reduced")) document.documentElement.dataset.motion = "reduced";
const models: ModelOptionView[] = [
	...Array.from({ length: 30 }, (_, index) => ({
		provider: "openai",
		modelId: `fixture-${index + 1}`,
		name: `Fixture Model ${String(index + 1).padStart(2, "0")}`,
	})),
	...Array.from({ length: 18 }, (_, index) => ({
		provider: `fixture-provider-${String(index + 1).padStart(2, "0")}`,
		modelId: "fixture-model",
		name: `Provider ${index + 1} model`,
	})),
];
function Fixture() {
	const [available, setAvailable] = useState(models);
	const [model, setModel] = useState(models[1]!);
	const [modelRequests, setModelRequests] = useState(0);
	const [permission, setPermission] = useState<PermissionPresetView>(params.has("parent") ? "full" : "auto");
	const [permissionRequests, setPermissionRequests] = useState(0);
	const [commandRequest, setCommandRequest] = useState({ id: 0, open: false });
	const pendingModel = useRef<{ model: ModelOptionView; resolve: () => void } | null>(null);
	useEffect(() => {
		const refresh = () => setAvailable((current) => [...current]);
		window.addEventListener("fixture-model-refresh", refresh);
		return () => window.removeEventListener("fixture-model-refresh", refresh);
	}, []);
	return (
		<main style={{ minHeight: "100vh", background: "var(--bg)", padding: 24 }}>
			<h1>Composer selectors fixture</h1>
			<button type="button" data-testid="outside">
				Outside control
			</button>
			<button
				type="button"
				data-testid="external-open"
				onClick={() => setCommandRequest((current) => ({ id: current.id + 1, open: true }))}
			>
				Request model menu
			</button>
			<button
				type="button"
				data-testid="external-close"
				onClick={() => setCommandRequest((current) => ({ id: current.id + 1, open: false }))}
			>
				Close requested menu
			</button>
			<button
				type="button"
				data-testid="finish-model"
				onClick={() => {
					const pending = pendingModel.current;
					if (!pending) return;
					pendingModel.current = null;
					setModel(pending.model);
					pending.resolve();
				}}
			>
				Finish model change
			</button>
			<output data-testid="calls">
				{JSON.stringify({ modelRequests, permissionRequests, selectedModel: model.modelId, permission })}
			</output>
			<div
				className={pane ? "workspace-pane" : undefined}
				data-testid="fixture-pane"
				style={
					pane
						? { position: "fixed", left: 280, top: 200, bottom: 0, width: 420, flex: "none" }
						: { display: "contents" }
				}
			>
				<section
					className="composer"
					style={{
						position: pane ? "absolute" : "fixed",
						bottom: 24,
						left: 24,
						right: 24,
						width: "auto",
						maxWidth: 720,
						margin: "0 auto",
						minHeight: 130,
						overflow: "visible",
					}}
				>
					<textarea
						aria-label="Fixture editor"
						placeholder="Local draft"
						style={{ width: "100%", minHeight: 60, background: "transparent", color: "inherit" }}
					/>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
						<PermissionSelector
							disabled={false}
							value={permission}
							constrainedByParent={params.has("parent")}
							sandboxHealth={params.has("missing-sandbox") ? "unavailable" : "healthy"}
							onChange={(next) => {
								setPermissionRequests((count) => count + 1);
								setPermission(next);
							}}
						/>
						<button aria-label="Fixture trash preview" type="button">
							<Trash aria-hidden="true" size={16} />
						</button>
						<ModelSelector
							available={available}
							commandRequest={commandRequest}
							disabled={false}
							value={model}
							onChange={(next) => {
								setModelRequests((count) => count + 1);
								return new Promise<void>((resolve) => {
									pendingModel.current = { model: next, resolve };
								});
							}}
						/>
					</div>
					<button type="button" data-testid="after-model" style={{ position: "absolute", right: 0, bottom: -20 }}>
						After selector
					</button>
				</section>
			</div>
		</main>
	);
}
await setLocale("en");
createRoot(document.getElementById("root")!).render(<Fixture />);
