import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { NewTaskHome } from "../src/renderer/components/NewTaskHome.tsx";
import { HomeProjectPicker } from "../src/renderer/components/HomeProjectPicker.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { saveProfileIdentity } from "../src/renderer/profile-identity.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "code" ? "code" : "chat";
const reducedMotion = params.get("motion") === "reduced";
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.motion = reducedMotion ? "reduced" : "full";
document.documentElement.style.setProperty("--chat-prose-font", "ui-sans-serif, sans-serif");
document.documentElement.style.setProperty("--code-prose-font", "ui-sans-serif, sans-serif");
document.documentElement.style.setProperty("--content-font-size", "15px");

const root = document.querySelector("#root");
if (!root) throw new Error("Fixture root is missing");

Math.random = () => 0;
saveProfileIdentity({ displayName: "QA User", avatarDataUrl: null });

function HomeFixture() {
	const [folder, setFolder] = useState<string | null>(mode === "code" && params.get("folder") !== "none" ? "/tmp/metis-home-qa" : null);
	const [submissions, setSubmissions] = useState(0);
	return <>
		<NewTaskHome
			busy={false} folder={folder} folderLocked={false} mode={mode}
			modelControl={<button className="composer-selector-trigger" type="button">Fixture Model</button>}
			permissionControl={<button className="composer-plain-button" type="button">Auto</button>}
			thinkingControl={<button className="composer-selector-trigger" type="button">High</button>}
			onChooseFolder={async () => setFolder("/tmp/metis-home-qa")}
			onManageMcp={() => undefined} onManageSkills={() => undefined}
			onPickFiles={async () => []} onSelectRecentProject={setFolder}
			onSubmit={async () => setSubmissions((count) => count + 1)}
			projectControl={<HomeProjectPicker busy={false} folder={folder} folderLocked={false} mode={mode}
				onChooseFolder={async () => setFolder("/tmp/metis-home-qa")}
				onClearFolder={() => setFolder(null)} onCreateProject={() => setFolder("/tmp/metis-new-project")} />}
			reducedMotion={reducedMotion}
			recentProjects={mode === "code" ? [
				{ cwd: "/tmp/metis-home-qa", name: "Metis", updatedAt: "2026-09-12T09:00:00.000Z" },
				{ cwd: "/tmp/website", name: "Website", updatedAt: "2026-09-11T09:00:00.000Z" },
				{ cwd: "/tmp/demo", name: "Demo", updatedAt: "2026-09-10T09:00:00.000Z" },
			] : []} skills={[]}
		/>
		<output hidden data-submission-count={submissions} data-workspace-folder={folder ?? ""} />
	</>;
}

async function mount(): Promise<void> {
	await setLocale(params.get("locale") === "en" ? "en" : "zh-CN");
	createRoot(root!).render(<HomeFixture />);
}
void mount();
