import type {
	ClientParams,
	ModelOptionView,
	ScheduleInputSpecView,
	ScheduleTaskView,
	SessionSummary,
} from "@metis/app-protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { FolderSimple, X } from "../icons.tsx";
import { trapDialogTab } from "./dialog-focus.ts";
import { MenuSelect } from "./MenuSelect.tsx";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function localDate(value = new Date()): string {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function localTime(value = new Date()): string {
	return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function inputSchedule(task?: ScheduleTaskView): ScheduleInputSpecView {
	if (!task) return { kind: "daily", time: "09:00" };
	if (task.schedule.kind !== "interval") return task.schedule;
	const start = new Date(task.schedule.startAt);
	return {
		kind: "interval",
		every: task.schedule.every,
		unit: task.schedule.unit,
		startDate: localDate(start),
		startTime: localTime(start),
	};
}

function projectSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
	const byCwd = new Map<string, SessionSummary>();
	for (const session of sessions) {
		if (
			session.mode !== "chat" ||
			session.archived ||
			session.scheduled ||
			session.cwdOrigin !== "user-selected" ||
			!session.cwd ||
			byCwd.has(session.cwd)
		) {
			continue;
		}
		byCwd.set(session.cwd, session);
	}
	return [...byCwd.values()].sort((left, right) => left.cwd!.localeCompare(right.cwd!));
}

function projectName(path: string): string {
	return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function modelKey(model: { provider: string; modelId: string }): string {
	return JSON.stringify([model.provider, model.modelId]);
}

function parseModelKey(value: string): { provider: string; modelId: string } | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) && parsed.length === 2 && parsed.every((item) => typeof item === "string")
			? { provider: parsed[0], modelId: parsed[1] }
			: undefined;
	} catch {
		return undefined;
	}
}

export interface ScheduledTaskDialogProps {
	readonly api: MetisDesktopApi;
	readonly models: readonly ModelOptionView[];
	readonly sessions: readonly SessionSummary[];
	readonly task?: ScheduleTaskView;
	readonly onClose: () => void;
	readonly onSaved: (task: ScheduleTaskView) => void;
}

export function ScheduledTaskDialog({ api, models, sessions, task, onClose, onSaved }: ScheduledTaskDialogProps) {
	const { t, i18n } = useTranslation();
	const dialog = useRef<HTMLDialogElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const keepEditingButton = useRef<HTMLButtonElement>(null);
	const initialSchedule = useMemo(() => inputSchedule(task), [task]);
	const initial = useRef({
		name: task?.name ?? "",
		description: task?.description ?? "",
		instruction: task?.instruction ?? "",
		model: task ? modelKey(task.model) : "",
		target: task?.target.workspace === "task" ? "task" : task ? "unchanged" : "task",
		additionalWorkspaceCwd: task?.target.workspace === "task" ? (task.target.additionalWorkspaceCwd ?? "") : "",
		schedule: JSON.stringify(initialSchedule),
	}).current;
	const projects = useMemo(() => projectSessions(sessions), [sessions]);
	const currentModelKey = task ? modelKey(task.model) : "";
	const currentModelAvailable = models.some((model) => modelKey(model) === currentModelKey);
	// biome-ignore lint/correctness/useExhaustiveDependencies(i18n.resolvedLanguage): Locale changes refresh translated select options.
	const targetOptions = useMemo(
		() => [
			...(task?.target.workspace === "fixed"
				? [
						{
							value: "unchanged",
							label: task.target.cwd,
						},
					]
				: []),
			{ value: "task", label: t("Dedicated task workspace") },
			...projects.map((session) => ({
				value: `session:${session.sessionId}`,
				label: `${projectName(session.cwd!)} — ${session.cwd}`,
			})),
		],
		[i18n.resolvedLanguage, projects, task, t],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies(i18n.resolvedLanguage): Locale changes refresh translated select options.
	const modelOptions = useMemo(
		() => [
			...(task && !currentModelAvailable
				? [
						{
							value: currentModelKey,
							label: t("{{model}} (unavailable)", { model: `${task.model.provider}/${task.model.modelId}` }),
							disabled: true,
						},
					]
				: []),
			...models.map((model) => ({
				value: modelKey(model),
				label: `${model.name} · ${model.provider}`,
			})),
		],
		[currentModelAvailable, currentModelKey, i18n.resolvedLanguage, models, task, t],
	);
	const [name, setName] = useState(initial.name);
	const [description, setDescription] = useState(initial.description);
	const [instruction, setInstruction] = useState(initial.instruction);
	const [selectedModel, setSelectedModel] = useState(initial.model);
	const [target, setTarget] = useState(initial.target);
	const [additionalWorkspaceCwd, setAdditionalWorkspaceCwd] = useState(initial.additionalWorkspaceCwd);
	const [schedule, setSchedule] = useState<ScheduleInputSpecView>(initialSchedule);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const request = useRef<{ key: string; id: string } | null>(null);
	const dirty =
		name !== initial.name ||
		description !== initial.description ||
		instruction !== initial.instruction ||
		selectedModel !== initial.model ||
		target !== initial.target ||
		additionalWorkspaceCwd !== initial.additionalWorkspaceCwd ||
		JSON.stringify(schedule) !== initial.schedule;
	const focusEditor = () => nameInput.current?.focus();
	const close = () => {
		if (busy) return;
		if (confirmDiscard) {
			setConfirmDiscard(false);
			focusEditor();
			return;
		}
		if (dirty) setConfirmDiscard(true);
		else onClose();
	};
	const keepEditing = () => {
		setConfirmDiscard(false);
		focusEditor();
	};
	const discard = () => {
		if (busy) return;
		setConfirmDiscard(false);
		onClose();
	};

	useEffect(() => {
		const node = dialog.current;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		node?.showModal?.();
		nameInput.current?.focus();
		return () => {
			if (node?.open) node.close?.();
			if (previous?.isConnected) previous.focus();
		};
	}, []);

	useLayoutEffect(() => {
		if (confirmDiscard) keepEditingButton.current?.focus();
	}, [confirmDiscard]);

	const setKind = (kind: ScheduleInputSpecView["kind"]) => {
		if (busy) return;
		if (kind === "once") setSchedule({ kind, date: localDate(new Date(Date.now() + 86_400_000)), time: "09:00" });
		else if (kind === "daily") setSchedule({ kind, time: "09:00" });
		else if (kind === "weekly") setSchedule({ kind, weekdays: [1], time: "09:00" });
		else if (kind === "monthly") setSchedule({ kind, day: 1, time: "09:00" });
		else setSchedule({ kind, every: 1, unit: "hour", startDate: localDate(), startTime: localTime() });
	};

	const chooseAdditionalFolder = async () => {
		if (busy) return;
		try {
			const selected = await api.selectProjectFolder();
			if (selected) setAdditionalWorkspaceCwd(selected);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The folder could not be selected.");
		}
	};

	const save = async () => {
		if (busy || confirmDiscard) return;
		const model = models.some((candidate) => modelKey(candidate) === selectedModel)
			? parseModelKey(selectedModel)
			: undefined;
		if (!name.trim() || !instruction.trim() || !model) {
			setError("Name, instructions, and an available model are required.");
			return;
		}
		if (schedule.kind === "weekly" && schedule.weekdays.length === 0) {
			setError("Choose at least one weekday.");
			return;
		}
		if (schedule.kind === "once" && new Date(`${schedule.date}T${schedule.time}`).getTime() <= Date.now()) {
			setError("The one-time run must be in the future.");
			return;
		}
		const serialized = JSON.stringify({
			name: name.trim(),
			description,
			instruction,
			model,
			target,
			additionalWorkspaceCwd,
			schedule,
		});
		if (request.current?.key !== serialized) request.current = { key: serialized, id: crypto.randomUUID() };
		setBusy(true);
		setError(null);
		try {
			let saved: ScheduleTaskView;
			if (!task) {
				const sourceSessionId = target.startsWith("session:") ? target.slice("session:".length) : undefined;
				saved = (
					await api.createSchedule({
						requestId: request.current.id,
						name: name.trim(),
						...(description ? { description } : {}),
						instruction,
						model,
						schedule,
						...(sourceSessionId ? { sourceSessionId } : {}),
						...(target === "task" && additionalWorkspaceCwd ? { additionalWorkspaceCwd } : {}),
					})
				).task;
			} else {
				const taskAccessCwd = task.target.workspace === "task" ? (task.target.additionalWorkspaceCwd ?? "") : "";
				const targetFields: Pick<
					ClientParams<"schedule/update">,
					"sourceSessionId" | "additionalWorkspaceCwd"
				> = target === "unchanged"
					? {}
					: target === "task"
						? task.target.workspace !== "task" || additionalWorkspaceCwd !== taskAccessCwd
							? {
									sourceSessionId: null,
									additionalWorkspaceCwd: additionalWorkspaceCwd || null,
								}
							: {}
						: { sourceSessionId: target.slice("session:".length) };
				const input: ClientParams<"schedule/update"> = {
					requestId: request.current.id,
					taskId: task.id,
					...(name.trim() === task.name ? {} : { name: name.trim() }),
					...(description === (task.description ?? "") ? {} : { description: description || null }),
					...(instruction === task.instruction ? {} : { instruction }),
					...(modelKey(model) === currentModelKey ? {} : { model }),
					...(JSON.stringify(schedule) === JSON.stringify(initialSchedule) ? {} : { schedule }),
					...targetFields,
				};
				if (Object.keys(input).length === 2) {
					onClose();
					return;
				}
				saved = (await api.updateSchedule(input)).task;
			}
			request.current = null;
			onSaved(saved);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The scheduled task could not be saved.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<dialog
			aria-labelledby="scheduled-task-dialog-title"
			className="scheduled-task-dialog"
			onKeyDown={(event) => {
				trapDialogTab(event, event.currentTarget);
				if (
					event.key !== "Escape" ||
					event.defaultPrevented ||
					event.currentTarget.querySelector('[aria-haspopup][aria-expanded="true"]')
				)
					return;
				event.preventDefault();
				event.stopPropagation();
				close();
			}}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}
			ref={dialog}
		>
			<form
				method="dialog"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<header>
					<h2 id="scheduled-task-dialog-title">{t(task ? "Edit scheduled task" : "Create scheduled task")}</h2>
					<button aria-label={t("Close")} disabled={busy} onClick={close} type="button">
						<X aria-hidden="true" size={17} />
					</button>
				</header>
				<div className="scheduled-task-dialog-fields">
					<label>
						{t("Name")}
						<input
							ref={nameInput}
							disabled={busy}
							maxLength={120}
							onChange={(event) => setName(event.target.value)}
							required
							value={name}
						/>
					</label>
					<label>
						{t("Description")}
						<input
							disabled={busy}
							maxLength={512}
							onChange={(event) => setDescription(event.target.value)}
							placeholder={t("Optional display description")}
							value={description}
						/>
					</label>
					<label>
						{t("Instructions")}
						<textarea
							disabled={busy}
							onChange={(event) => setInstruction(event.target.value)}
							required
							rows={5}
							value={instruction}
						/>
					</label>
					<div className="scheduled-task-dialog-row">
						<div className="scheduled-task-field">
							<span>{t("Work in")}</span>
							<MenuSelect
								ariaLabel={t("Work in")}
								disabled={busy}
								onChange={setTarget}
								options={targetOptions}
								value={target}
							/>
						</div>
						<div className="scheduled-task-field">
							<span>{t("Model")}</span>
							<MenuSelect
								ariaLabel={t("Model")}
								disabled={busy}
								onChange={setSelectedModel}
								options={modelOptions}
								placeholder={t("Choose a configured model")}
								value={selectedModel}
							/>
						</div>
					</div>
					{target === "task" && (
						<div className="scheduled-task-access-folder">
							<span>{t("Additional folder access")}</span>
							<div>
								<button
									aria-label={t("Choose additional folder access")}
									disabled={busy}
									onClick={() => void chooseAdditionalFolder()}
									title={additionalWorkspaceCwd || undefined}
									type="button"
								>
									<FolderSimple aria-hidden="true" size={17} />
									<span>{additionalWorkspaceCwd || t("Choose folder (optional)")}</span>
								</button>
								{additionalWorkspaceCwd && (
									<button
										aria-label={t("Remove additional folder access")}
										disabled={busy}
										onClick={() => setAdditionalWorkspaceCwd("")}
										type="button"
									>
										<X aria-hidden="true" size={15} />
									</button>
								)}
							</div>
							<small>
								{t(
									"Metis can modify this folder and all of its subfolders. It is not copied or deleted with the task.",
								)}
							</small>
						</div>
					)}
					<fieldset>
						<legend>{t("Repeat")}</legend>
						<MenuSelect
							ariaLabel={t("Repeat")}
							disabled={busy}
							onChange={setKind}
							options={[
								{ value: "once", label: t("Once") },
								{ value: "daily", label: t("Daily") },
								{ value: "weekly", label: t("Weekly") },
								{ value: "monthly", label: t("Monthly") },
								{ value: "interval", label: t("Interval") },
							]}
							value={schedule.kind}
						/>
						{schedule.kind === "once" && (
							<div className="scheduled-task-recurrence-fields">
								<label>
									{t("Date")}
									<input
										disabled={busy}
										min={localDate()}
										onChange={(event) => setSchedule({ ...schedule, date: event.target.value })}
										required
										type="date"
										value={schedule.date}
									/>
								</label>
								<label>
									{t("Time")}
									<input
										onChange={(event) => setSchedule({ ...schedule, time: event.target.value })}
										required
										type="time"
										value={schedule.time}
									/>
								</label>
							</div>
						)}
						{schedule.kind === "daily" && (
							<label>
								{t("Time")}
								<input
									disabled={busy}
									onChange={(event) => setSchedule({ ...schedule, time: event.target.value })}
									required
									type="time"
									value={schedule.time}
								/>
							</label>
						)}
						{schedule.kind === "weekly" && (
							<>
								<fieldset aria-label={t("Weekdays")} className="control-group scheduled-task-weekdays">
									{WEEKDAYS.map((label, index) => {
										const day = index + 1;
										const selected = schedule.weekdays.includes(day);
										return (
											<button
												aria-pressed={selected}
												disabled={busy}
												key={label}
												onClick={() =>
													setSchedule({
														...schedule,
														weekdays: selected
															? schedule.weekdays.filter((item) => item !== day)
															: [...schedule.weekdays, day].sort(),
													})
												}
												type="button"
											>
												{t(label)}
											</button>
										);
									})}
								</fieldset>
								<label>
									{t("Time")}
									<input
										onChange={(event) => setSchedule({ ...schedule, time: event.target.value })}
										required
										type="time"
										value={schedule.time}
									/>
								</label>
							</>
						)}
						{schedule.kind === "monthly" && (
							<div className="scheduled-task-recurrence-fields">
								<label>
									{t("Day")}
									<input
										disabled={busy}
										max={31}
										min={1}
										onChange={(event) => setSchedule({ ...schedule, day: Number(event.target.value) })}
										required
										type="number"
										value={schedule.day}
									/>
								</label>
								<label>
									{t("Time")}
									<input
										onChange={(event) => setSchedule({ ...schedule, time: event.target.value })}
										required
										type="time"
										value={schedule.time}
									/>
								</label>
							</div>
						)}
						{schedule.kind === "interval" && (
							<>
								<div className="scheduled-task-recurrence-fields">
									<label>
										{t("Every")}
										<input
											disabled={busy}
											max={10000}
											min={1}
											onChange={(event) => setSchedule({ ...schedule, every: Number(event.target.value) })}
											required
											type="number"
											value={schedule.every}
										/>
									</label>
									<div className="scheduled-task-field">
										<span>{t("Unit")}</span>
										<MenuSelect
											ariaLabel={t("Unit")}
											disabled={busy}
											onChange={(unit) => setSchedule({ ...schedule, unit })}
											options={[
												{ value: "minute", label: t("Minutes") },
												{ value: "hour", label: t("Hours") },
											]}
											value={schedule.unit}
										/>
									</div>
								</div>
								<div className="scheduled-task-recurrence-fields">
									<label>
										{t("Start date")}
										<input
											disabled={busy}
											onChange={(event) => setSchedule({ ...schedule, startDate: event.target.value })}
											required
											type="date"
											value={schedule.startDate}
										/>
									</label>
									<label>
										{t("Start time")}
										<input
											disabled={busy}
											onChange={(event) => setSchedule({ ...schedule, startTime: event.target.value })}
											required
											type="time"
											value={schedule.startTime}
										/>
									</label>
								</div>
							</>
						)}
					</fieldset>
					{error && (
						<p className="scheduled-task-form-error" role="alert">
							{t(error)}
						</p>
					)}
				</div>
				{confirmDiscard ? (
					<footer className="scheduled-task-discard">
						<p role="alert">
							{t("Your changes have not been saved. Keep editing to save them, or discard them to leave.")}
						</p>
						<button className="button-secondary" onClick={keepEditing} ref={keepEditingButton} type="button">
							{t("Keep editing")}
						</button>
						<button className="scheduled-task-danger" disabled={busy} onClick={discard} type="button">
							{t("Discard changes")}
						</button>
					</footer>
				) : (
					<footer>
						<button className="button-secondary" disabled={busy} onClick={close} type="button">
							{t("Cancel")}
						</button>
						<button disabled={busy || models.length === 0} type="submit">
							{t(busy ? "Saving…" : "Save")}
						</button>
					</footer>
				)}
			</form>
		</dialog>
	);
}
