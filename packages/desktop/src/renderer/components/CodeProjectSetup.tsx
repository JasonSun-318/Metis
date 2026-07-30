import { CaretLeft, CaretRight, FolderSimple, Plus, X } from "@phosphor-icons/react";
import { type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import codeProjectHand from "../assets/code-project-hand.png";
import type {
	DesktopAttachmentSelection,
	DesktopCreateProjectFolderInput,
} from "../../shared/desktop-api.ts";
import { DialogFrame } from "./ProjectActions.tsx";

type SetupStep = "choose" | "create" | "existing";

interface CodeProjectSetupProps {
	readonly busy: boolean;
	readonly onChooseExisting: () => Promise<string | null>;
	readonly onChooseLocation: () => Promise<string | null>;
	readonly onCancel: () => void;
	readonly onCreateProject: (input: DesktopCreateProjectFolderInput) => Promise<string>;
	readonly onGetDefaultLocation: () => Promise<string>;
	readonly onOpenProject: (cwd: string) => Promise<void>;
	readonly onPickFiles: () => Promise<readonly DesktopAttachmentSelection[]>;
	readonly onResolveDroppedFiles: (files: readonly File[]) => readonly DesktopAttachmentSelection[];
}

const LOCATION_KEY = "arcmind.codeProjectLocation";
const MAX_FILES = 16;

function mergeFiles(
	current: readonly DesktopAttachmentSelection[],
	incoming: readonly DesktopAttachmentSelection[],
): DesktopAttachmentSelection[] {
	const next = [...current];
	const names = new Set(current.map((file) => file.name.toLocaleLowerCase("en-US")));
	for (const file of incoming) {
		const key = file.name.toLocaleLowerCase("en-US");
		if (!file.path || names.has(key) || next.length >= MAX_FILES) continue;
		names.add(key);
		next.push(file);
	}
	return next;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The project could not be created.";
}

export function CodeProjectSetup({
	busy,
	onChooseExisting,
	onChooseLocation,
	onCancel,
	onCreateProject,
	onGetDefaultLocation,
	onOpenProject,
	onPickFiles,
	onResolveDroppedFiles,
}: CodeProjectSetupProps) {
	const [step, setStep] = useState<SetupStep>("choose");
	const [name, setName] = useState("");
	const [files, setFiles] = useState<readonly DesktopAttachmentSelection[]>([]);
	const [location, setLocation] = useState("");
	const [pending, setPending] = useState(false);
	const [dropActive, setDropActive] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [createdProject, setCreatedProject] = useState<string | null>(null);
	const startButton = useRef<HTMLButtonElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const chooseFolderButton = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let active = true;
		const saved = localStorage.getItem(LOCATION_KEY);
		if (saved) setLocation(saved);
		else void onGetDefaultLocation().then(
			(value) => {
				if (active) setLocation(value);
			},
			(cause) => {
				if (active) setError(errorMessage(cause));
			},
		);
		return () => {
			active = false;
		};
	}, [onGetDefaultLocation]);

	const goBack = () => {
		if (pending) return;
		setError(null);
		setStep("choose");
	};
	const addFiles = (incoming: readonly DesktopAttachmentSelection[]) => {
		setFiles((current) => mergeFiles(current, incoming));
		setError(null);
	};
	const pickFiles = async () => {
		try {
			addFiles(await onPickFiles());
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	const chooseLocation = async () => {
		try {
			const selected = await onChooseLocation();
			if (!selected) return;
			localStorage.setItem(LOCATION_KEY, selected);
			setLocation(selected);
			setError(null);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	const openExisting = async () => {
		setPending(true);
		setError(null);
		try {
			const cwd = await onChooseExisting();
			if (cwd) await onOpenProject(cwd);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setPending(false);
		}
	};
	const createProject = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim() || !location || pending) return;
		setPending(true);
		setError(null);
		try {
			const cwd = createdProject ?? await onCreateProject({
				parentDirectory: location,
				name: name.trim(),
				files,
			});
			setCreatedProject(cwd);
			await onOpenProject(cwd);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setPending(false);
		}
	};
	const dropFiles = (event: DragEvent<HTMLButtonElement>) => {
		event.preventDefault();
		setDropActive(false);
		try {
			addFiles(onResolveDroppedFiles(Array.from(event.dataTransfer.files)));
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	const initialFocus = step === "choose" ? startButton : step === "create" ? nameInput : chooseFolderButton;

	return (
		<div className="code-project-setup">
			<DialogFrame
				cancellable={!pending}
				className={`code-project-dialog code-project-dialog-${step}`}
				descriptionId={`code-project-${step}-description`}
				initialFocus={initialFocus}
				key={step}
				onCancel={step === "choose" ? onCancel : goBack}
				titleId={`code-project-${step}-title`}
			>
				{step === "choose" && (
					<div className="code-project-choice-layout">
						<div className="code-project-choice-copy">
							<h2 id="code-project-choose-title">Create a new project</h2>
							<p id="code-project-choose-description">
								A dedicated place for ongoing work. Files stay in a folder on your computer, and ArcMind keeps the project context together.
							</p>
							<div className="code-project-options">
								<button aria-label="Start from scratch" onClick={() => setStep("create")} ref={startButton} type="button">
									<span className="code-project-option-icon"><Plus aria-hidden="true" size={24} /></span>
									<span><strong>Start from scratch</strong><small>Create a new folder and add your files.</small></span>
									<CaretRight aria-hidden="true" size={17} />
								</button>
								<button aria-label="Use an existing folder" onClick={() => setStep("existing")} type="button">
									<span className="code-project-option-icon"><FolderSimple aria-hidden="true" size={22} /></span>
									<span><strong>Use an existing folder</strong><small>Give ArcMind a folder you already work from.</small></span>
									<CaretRight aria-hidden="true" size={17} />
								</button>
							</div>
						</div>
						<div className="code-project-illustration" aria-hidden="true">
							<img alt="" src={codeProjectHand} />
						</div>
					</div>
				)}

				{step === "create" && (
					<form className="code-project-form" onSubmit={(event) => void createProject(event)}>
						<button aria-label="Back" className="code-project-back" disabled={pending} onClick={goBack} type="button">
							<CaretLeft aria-hidden="true" size={21} />
						</button>
						<h2 id="code-project-create-title">Start a new project</h2>
						<p className="sr-only" id="code-project-create-description">Create a folder for a new ArcMind Code project.</p>
						<label htmlFor="code-project-name">Name <span aria-hidden="true">*</span></label>
						<input
							autoComplete="off"
							disabled={pending || createdProject !== null}
							id="code-project-name"
							maxLength={120}
							onChange={(event) => setName(event.target.value)}
							placeholder="Project name"
							ref={nameInput}
							value={name}
						/>
						<span className="code-project-field-label">Add files</span>
						<button
							aria-label="Add files"
							className="code-project-dropzone"
							data-active={dropActive}
							disabled={pending || createdProject !== null || files.length >= MAX_FILES}
							onClick={() => void pickFiles()}
							onDragEnter={(event) => {
								event.preventDefault();
								setDropActive(true);
							}}
							onDragLeave={() => setDropActive(false)}
							onDragOver={(event) => event.preventDefault()}
							onDrop={dropFiles}
							type="button"
						>
							<Plus aria-hidden="true" size={18} />
							<span>{files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"} selected` : "Drop files here or click to browse"}</span>
						</button>
						{files.length > 0 && (
							<ul className="code-project-files" aria-label="Files to add">
								{files.map((file) => (
									<li key={`${file.path}\u0000${file.name}`}>
										<span>{file.name}</span>
										<button aria-label={`Remove ${file.name}`} disabled={pending || createdProject !== null} onClick={() => setFiles((current) => current.filter((candidate) => candidate !== file))} type="button">
											<X aria-hidden="true" size={14} />
										</button>
									</li>
								))}
							</ul>
						)}
						<span className="code-project-field-label">Choose project location</span>
						<button aria-label={`Choose project location${location ? `, current ${location}` : ""}`} className="code-project-location" disabled={pending || createdProject !== null} onClick={() => void chooseLocation()} title={location} type="button">
							<FolderSimple aria-hidden="true" size={18} />
							<span>{location || "Loading location…"}</span>
						</button>
						{error && <p className="code-project-error" role="alert">{error}</p>}
						<div className="code-project-form-actions">
							<button className="button-secondary" disabled={pending} onClick={onCancel} type="button">Cancel</button>
							<button disabled={busy || pending || !name.trim() || !location} type="submit">
								{pending ? (createdProject ? "Opening…" : "Creating…") : createdProject ? "Retry" : "Create"}
							</button>
						</div>
					</form>
				)}

				{step === "existing" && (
					<div className="code-project-existing">
						<button aria-label="Back" className="code-project-back" disabled={pending} onClick={goBack} type="button">
							<CaretLeft aria-hidden="true" size={21} />
						</button>
						<h2 id="code-project-existing-title">Use an existing folder</h2>
						<p id="code-project-existing-description">
							Choose a folder and ArcMind will treat its files as project context. ArcMind will remember Code context across tasks in this project.
						</p>
						<button className="code-project-choose-folder" disabled={busy || pending} onClick={() => void openExisting()} ref={chooseFolderButton} type="button">
							{pending ? "Opening…" : "Choose folder"}
						</button>
						{error && <p className="code-project-error" role="alert">{error}</p>}
					</div>
				)}
			</DialogFrame>
		</div>
	);
}
