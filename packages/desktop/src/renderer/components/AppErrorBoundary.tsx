import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "../i18n.ts";

interface AppErrorBoundaryProps {
	readonly children: ReactNode;
}

interface AppErrorBoundaryState {
	readonly failed: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
	state: AppErrorBoundaryState = { failed: false };

	static getDerivedStateFromError(): AppErrorBoundaryState {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("Metis renderer failed", error, info.componentStack);
	}

	render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		return (
			<main className="app-error-boundary" role="alert">
				<h1>{i18n.t("Metis encountered an unexpected error.")}</h1>
				<p>{i18n.t("Reload the app to continue. Your saved tasks are unchanged.")}</p>
				<button onClick={() => window.location.reload()} type="button">
					{i18n.t("Reload Metis")}
				</button>
			</main>
		);
	}
}
