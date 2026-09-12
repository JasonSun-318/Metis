import React from "react";
import { createRoot } from "react-dom/client";
import { NewTaskHome } from "../src/renderer/components/NewTaskHome.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { saveProfileIdentity } from "../src/renderer/profile-identity.ts";
import "../src/renderer/styles/tokens.css";
import "../src/renderer/styles/app.css";

const mode = new URLSearchParams(window.location.search).get("mode") === "code" ? "code" : "chat";
const reducedMotion = new URLSearchParams(window.location.search).get("motion") === "reduced";
const baseline = new URLSearchParams(window.location.search).get("baseline") === "old";

document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.motion = reducedMotion ? "reduced" : "full";
document.documentElement.style.setProperty("--chat-prose-font", "ui-sans-serif, sans-serif");
document.documentElement.style.setProperty("--code-prose-font", "ui-sans-serif, sans-serif");
document.documentElement.style.setProperty("--content-font-size", "15px");
if (baseline) {
	const style = document.createElement("style");
	style.textContent = ".new-task-home-hero-main{position:static!important;}";
	document.head.append(style);
}

const root = document.querySelector("#root");
if (!root) throw new Error("Fixture root is missing");

Math.random = () => 0;
saveProfileIdentity({ displayName: "QA User", avatarDataUrl: null });

async function mount(): Promise<void> {
	await setLocale("zh-CN");
	createRoot(root).render(
		<NewTaskHome
			busy={false}
			folder={mode === "code" ? "/tmp/metis-home-qa" : null}
			folderLocked={false}
			mode={mode}
			onChooseFolder={async () => undefined}
			onManageMcp={() => undefined}
			onManageSkills={() => undefined}
			onPickFiles={async () => []}
			onSubmit={async () => undefined}
			projectControl={
				<div className="home-project-picker" data-fixture-project="true">
					<span>QA project</span>
				</div>
			}
			reducedMotion={reducedMotion}
			skills={[]}
		/>,
	);
}

void mount();
