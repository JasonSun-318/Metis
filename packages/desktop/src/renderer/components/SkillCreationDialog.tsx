import type { ClientParams, ClientResult, WritableSkillSourceView } from "@metis/app-protocol";
import { ArrowLeft, CaretRight, Code, FolderSimple, GithubLogo, Robot, UploadSimple, X } from "@phosphor-icons/react";
import { type DragEvent, type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAttachmentSelection } from "../../shared/desktop-api.ts";
import { DialogFrame } from "./DialogFrame.tsx";
import { MenuSelect } from "./MenuSelect.tsx";

export type SkillCreationTarget =
	| { readonly source: "user"; readonly cwd: null }
	| { readonly source: "project"; readonly cwd: string };

export interface SkillProjectOption {
	readonly cwd: string;
	readonly name: string;
}

type ImportInput = ClientParams<"skill/import/inspect">["input"];
type Inspection = ClientResult<"skill/import/inspect">;
type Step = "methods" | "upload" | "github";

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The Skill could not be imported.";
}

function archive(selection: DesktopAttachmentSelection): ImportInput | null {
	return /\.(?:zip|skill)$/iu.test(selection.name) && selection.path
		? { kind: "archive", path: selection.path }
		: null;
}

export function SkillCreationDialog({
	initialCwd,
	onCancel,
	onChooseProject,
	onCreateWithMetis,
	onCustom,
	onImported,
	onInspect,
	onPickFiles,
	onResolveDroppedFiles,
	projects,
	source,
}: {
	readonly source: WritableSkillSourceView;
	readonly initialCwd: string | null;
	readonly projects: readonly SkillProjectOption[];
	readonly onCancel: () => void;
	readonly onChooseProject: () => Promise<string | null>;
	readonly onPickFiles: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onResolveDroppedFiles: (files: readonly File[]) => readonly DesktopAttachmentSelection[];
	readonly onInspect: (target: SkillCreationTarget, input: ImportInput) => Promise<Inspection>;
	readonly onImported: (
		target: SkillCreationTarget,
		input: ImportInput,
		inspection: Inspection,
		candidateIds: readonly string[],
	) => Promise<void>;
	readonly onCreateWithMetis: (target: SkillCreationTarget) => Promise<void>;
	readonly onCustom: (target: SkillCreationTarget) => void;
}) {
	const { t } = useTranslation();
	const firstMethod = useRef<HTMLButtonElement>(null);
	const githubInput = useRef<HTMLInputElement>(null);
	const uploadButton = useRef<HTMLButtonElement>(null);
	const [cwd, setCwd] = useState(source === "project" ? initialCwd : null);
	const [step, setStep] = useState<Step>("methods");
	const [input, setInput] = useState<ImportInput | null>(null);
	const [inspection, setInspection] = useState<Inspection | null>(null);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [githubUrl, setGithubUrl] = useState("");
	const [pending, setPending] = useState(false);
	const [dropActive, setDropActive] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const target =
		source === "project" && cwd
			? ({ source, cwd } as const)
			: source === "user"
				? ({ source, cwd: null } as const)
				: null;
	const inspect = async (next: ImportInput) => {
		if (!target) return;
		setPending(true);
		setError(null);
		setInspection(null);
		try {
			const result = await onInspect(target, next);
			setInput(next);
			setInspection(result);
			setSelected(new Set(result.candidates.map((candidate) => candidate.id)));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setPending(false);
		}
	};
	const pickArchive = async () => {
		try {
			const file = (await onPickFiles())[0];
			const next = file ? archive(file) : null;
			if (!file) return;
			if (!next) {
				setError(t("Choose a .zip or .skill file."));
				return;
			}
			await inspect(next);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	const dropArchive = (event: DragEvent<HTMLButtonElement>) => {
		event.preventDefault();
		setDropActive(false);
		try {
			const file = onResolveDroppedFiles(Array.from(event.dataTransfer.files))[0];
			const next = file ? archive(file) : null;
			if (!next) {
				setError(t("Choose a .zip or .skill file."));
				return;
			}
			void inspect(next);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	const chooseProject = async () => {
		try {
			const selectedCwd = await onChooseProject();
			if (selectedCwd) setCwd(selectedCwd);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	const install = async () => {
		if (!target || !input || !inspection || selected.size === 0) return;
		setPending(true);
		setError(null);
		try {
			await onImported(target, input, inspection, [...selected]);
		} catch (cause) {
			setError(errorMessage(cause));
			setPending(false);
		}
	};
	const run = async (action: () => Promise<void>) => {
		if (!target) return;
		setPending(true);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(errorMessage(cause));
			setPending(false);
		}
	};
	const back = () => {
		if (pending) return;
		setStep("methods");
		setInput(null);
		setInspection(null);
		setSelected(new Set());
		setError(null);
	};
	const initialFocus = step === "methods" ? firstMethod : step === "github" ? githubInput : uploadButton;
	const projectOptions = [
		...(cwd && !projects.some((project) => project.cwd === cwd) ? [{ value: cwd, label: cwd }] : []),
		...projects.map((project) => ({ value: project.cwd, label: `${project.name} — ${project.cwd}` })),
	];

	return (
		<DialogFrame
			cancellable={!pending}
			className="mcp-dialog skill-create-dialog"
			descriptionId="skill-create-description"
			initialFocus={initialFocus}
			onCancel={onCancel}
			titleId="skill-create-title"
		>
			<button
				aria-label={t("Close")}
				className="mcp-dialog-close"
				disabled={pending}
				onClick={onCancel}
				type="button"
			>
				<X aria-hidden="true" size={17} />
			</button>
			<div className="skill-create-heading">
				{step !== "methods" && (
					<button
						aria-label={t("Back")}
						className="skill-create-back"
						disabled={pending}
						onClick={back}
						type="button"
					>
						<ArrowLeft aria-hidden="true" size={17} />
					</button>
				)}
				<div>
					<h2 id="skill-create-title">{t(source === "project" ? "Create Project Skill" : "Create User Skill")}</h2>
					<p id="skill-create-description">
						{t(
							source === "project"
								? "Choose where to create the Skill, then how to create it."
								: "Choose how you want to create this user-wide Skill.",
						)}
					</p>
				</div>
			</div>
			{source === "project" && (
				<div className="skill-create-project">
					<span>{t("Create in")}</span>
					<div>
						<MenuSelect<string>
							ariaLabel={t("Create in")}
							className="skill-create-project-select"
							disabled={pending}
							onChange={setCwd}
							options={projectOptions}
							placeholder={t("Choose a project")}
							value={cwd ?? ""}
						/>
						<button
							className="button-secondary skill-create-folder"
							disabled={pending}
							onClick={() => void chooseProject()}
							type="button"
						>
							<FolderSimple aria-hidden="true" size={15} />
							{t("Choose folder…")}
						</button>
					</div>
				</div>
			)}
			{step === "methods" && (
				<div className="skill-create-methods">
					<button
						aria-label={t("Create with Metis")}
						disabled={!target || pending}
						onClick={() => void run(() => onCreateWithMetis(target!))}
						ref={firstMethod}
						type="button"
					>
						<span>
							<Robot aria-hidden="true" size={20} />
						</span>
						<span>
							<strong>{t("Create with Metis")}</strong>
							<small>{t("Start a Chat that helps define and build the Skill.")}</small>
						</span>
						<CaretRight aria-hidden="true" size={16} />
					</button>
					<button
						aria-label={t("Upload Skill")}
						disabled={!target || pending}
						onClick={() => setStep("upload")}
						type="button"
					>
						<span>
							<UploadSimple aria-hidden="true" size={20} />
						</span>
						<span>
							<strong>{t("Upload Skill")}</strong>
							<small>{t("Import a .zip or .skill file from this computer.")}</small>
						</span>
						<CaretRight aria-hidden="true" size={16} />
					</button>
					<button
						aria-label={t("Import from GitHub")}
						disabled={!target || pending}
						onClick={() => setStep("github")}
						type="button"
					>
						<span>
							<GithubLogo aria-hidden="true" size={20} />
						</span>
						<span>
							<strong>{t("Import from GitHub")}</strong>
							<small>{t("Inspect and import Skills from a public GitHub link.")}</small>
						</span>
						<CaretRight aria-hidden="true" size={16} />
					</button>
					<button
						aria-label={t("Custom")}
						disabled={!target || pending}
						onClick={() => onCustom(target!)}
						type="button"
					>
						<span>
							<Code aria-hidden="true" size={20} />
						</span>
						<span>
							<strong>{t("Custom")}</strong>
							<small>{t("Enter a name, description, and instructions.")}</small>
						</span>
						<CaretRight aria-hidden="true" size={16} />
					</button>
				</div>
			)}
			{step === "upload" && (
				<div className="skill-create-import">
					<button
						className="skill-upload-dropzone"
						data-active={dropActive}
						disabled={pending}
						onClick={() => void pickArchive()}
						onDragEnter={(event) => {
							event.preventDefault();
							setDropActive(true);
						}}
						onDragLeave={() => setDropActive(false)}
						onDragOver={(event) => event.preventDefault()}
						onDrop={dropArchive}
						ref={uploadButton}
						type="button"
					>
						<UploadSimple aria-hidden="true" size={24} />
						<strong>{t(pending ? "Inspecting Skill…" : "Drop or click to upload")}</strong>
						<small>{t("The archive must contain at least one SKILL.md file.")}</small>
					</button>
				</div>
			)}
			{step === "github" && (
				<form
					className="skill-create-github"
					id="skill-create-github-form"
					onSubmit={(event: FormEvent) => {
						event.preventDefault();
						if (githubUrl.trim()) void inspect({ kind: "github", url: githubUrl.trim() });
					}}
				>
					<label>
						{t("GitHub link")}
						<input
							disabled={pending}
							onChange={(event) => setGithubUrl(event.target.value)}
							placeholder="https://github.com/owner/repository"
							ref={githubInput}
							type="url"
							value={githubUrl}
						/>
					</label>
				</form>
			)}
			{inspection && (
				<div className="skill-import-candidates">
					<h3>{t("Skills found")}</h3>
					{inspection.candidates.map((candidate) => (
						<label key={candidate.id}>
							<input
								checked={selected.has(candidate.id)}
								disabled={pending}
								onChange={(event) =>
									setSelected((current) => {
										const next = new Set(current);
										if (event.target.checked) next.add(candidate.id);
										else next.delete(candidate.id);
										return next;
									})
								}
								type="checkbox"
							/>
							<span>
								<strong>{candidate.name}</strong>
								<small>
									{candidate.description} · {t("{{count}} files", { count: candidate.fileCount })}
								</small>
							</span>
						</label>
					))}
				</div>
			)}
			{error && (
				<p className="mcp-dialog-error" role="alert">
					{t(error)}
				</p>
			)}
			<div className="mcp-dialog-actions">
				<button className="button-secondary" disabled={pending} onClick={onCancel} type="button">
					{t("Cancel")}
				</button>
				{step === "github" && !inspection && (
					<button disabled={pending || !githubUrl.trim()} form="skill-create-github-form" type="submit">
						{t(pending ? "Inspecting Skill…" : "Inspect")}
					</button>
				)}
				{inspection && (
					<button disabled={pending || selected.size === 0} onClick={() => void install()} type="button">
						{t(pending ? "Importing…" : "Import selected")}
					</button>
				)}
			</div>
		</DialogFrame>
	);
}
