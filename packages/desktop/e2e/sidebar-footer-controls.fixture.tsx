import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { Folder as LibraryFolder } from "reicon-react/icons/Folder";
import { AccountMenu } from "../src/renderer/components/AccountMenu.tsx";
import { AnimatedNavIcon } from "../src/renderer/components/AnimatedNavIcon.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { saveProfileIdentity } from "../src/renderer/profile-identity.ts";
import type { DesktopChangelog, DesktopUpdateState } from "../src/shared/desktop-api.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

const params = new URLSearchParams(location.search);
const width = Number(params.get("width")) || 302;
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.motion = params.has("reduced") ? "reduced" : "full";
saveProfileIdentity({ displayName: "Fixture User", avatarDataUrl: null });
const states: Record<string, DesktopUpdateState> = {
	unavailable: { status: "unavailable" },
	checking: { status: "checking" },
	available: { status: "available", version: "0.2.0", releaseNotes: "" },
	downloading: { status: "downloading", version: "0.2.0", releaseNotes: "", progress: 42 },
	ready: { status: "ready", version: "0.2.0", releaseNotes: "" },
};
function Fixture() {
	const [expanded, setExpanded] = useState(false);
	const [settings, setSettings] = useState(0);
	const [checks, setChecks] = useState(0);
	const [updates, setUpdates] = useState(0);
	const [loads, setLoads] = useState(0);
	const [updateState, setUpdateState] = useState<DesktopUpdateState>(states[params.get("state") ?? "unavailable"]!);
	const loadChangelog = useCallback(async (): Promise<DesktopChangelog> => {
		setLoads((value) => value + 1);
		return {
			schemaVersion: 1,
			releases: [
				{
					version: "0.1.9",
					notes: "- Isolated release notes fixture.\n\n[Fixture details](https://example.test/release)",
				},
			],
		};
	}, []);
	return (
		<div className="app-shell" style={{ "--sidebar-width": `${width}px` } as React.CSSProperties}>
			<aside className="session-sidebar" style={{ width, minWidth: 0 }}>
				<button
					className="project-heading"
					style={{ margin: "70px 12px 0", padding: 6, justifyContent: "flex-start", gap: 6 }}
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					type="button"
					data-testid="folder-toggle"
				>
					<AnimatedNavIcon kind="folder" expanded={expanded} />
					<span>Fixture project</span>
				</button>
				<div style={{ flex: 1 }} />
				<footer className="sidebar-footer">
					<AccountMenu
						loadChangelog={loadChangelog}
						updateState={updateState}
						onSettings={() => setSettings((value) => value + 1)}
						onCheckUpdate={() => {
							setChecks((value) => value + 1);
							setUpdateState(states.checking!);
						}}
						onUpdate={() => setUpdates((value) => value + 1)}
					/>
				</footer>
			</aside>
			<main className="workspace">
				<button type="button" data-testid="outside" style={{ margin: 80, padding: 12 }}>
					Outside sidebar
				</button>
				<label>
					Update fixture state
					<select
						aria-label="Update fixture state"
						value={updateState.status}
						onChange={(event) => setUpdateState(states[event.target.value]!)}
					>
						{Object.keys(states).map((status) => (
							<option key={status}>{status}</option>
						))}
					</select>
				</label>
				<output data-testid="calls">{JSON.stringify({ settings, checks, updates, loads })}</output>
			</main>
			<div hidden>
				<span data-testid="reference-folder">
					<LibraryFolder weight="Outline" size={14} />
				</span>
			</div>
		</div>
	);
}
await setLocale("en");
createRoot(document.getElementById("root")!).render(<Fixture />);
