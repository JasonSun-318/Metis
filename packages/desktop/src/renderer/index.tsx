import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary.tsx";
import "./i18n.ts";
import { AppStore } from "./store/app-store.ts";
import { applyThemeToDocument, loadTheme } from "./theme.ts";
import "./styles/tokens.css";
import "./styles/app.css";

// Apply the persisted theme before the first paint to avoid a flash.
applyThemeToDocument(loadTheme(localStorage));
document.documentElement.dataset.platform = window.metis.platform;

const root = document.getElementById("root");
if (!root) throw new Error("Metis renderer root is missing");

const store = new AppStore();

createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary>
			<App api={window.metis} store={store} />
		</AppErrorBoundary>
	</StrictMode>,
);
