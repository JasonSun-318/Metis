import type { SkillSummaryView } from "@metis/app-protocol";
import { Briefcase, CaretRight, Paperclip, Plus, Scroll } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface ComposerAddMenuProps {
	readonly disabled: boolean;
	readonly skills: readonly SkillSummaryView[];
	readonly onAddFiles: () => void;
	readonly onManageSkills: () => void;
	readonly onSelectSkill: (skill: SkillSummaryView) => void;
}

export function ComposerAddMenu({ disabled, skills, onAddFiles, onManageSkills, onSelectSkill }: ComposerAddMenuProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const close = (restoreFocus = false) => {
		setOpen(false);
		setSkillsOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	};

	useEffect(() => {
		if (!disabled) return;
		setOpen(false);
		setSkillsOpen(false);
	}, [disabled]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close(true);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	useEffect(() => {
		if (disabled) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!event.metaKey || event.code !== "KeyU") return;
			event.preventDefault();
			close();
			onAddFiles();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [disabled, onAddFiles]);

	return (
		<div className="composer-add" ref={rootRef}>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={t("Add to message")}
				className="composer-plain-button"
				disabled={disabled}
				onClick={() => {
					setOpen((value) => !value);
					setSkillsOpen(false);
				}}
				ref={triggerRef}
				type="button"
			>
				<Plus aria-hidden="true" size={20} />
			</button>
			{open && (
				<div className="composer-add-popover">
					<div className="composer-add-menu" role="menu">
						<button aria-label={t("Add files or photos")} onClick={() => { close(); onAddFiles(); }} role="menuitem" type="button">
							<Paperclip aria-hidden="true" size={16} />
							<span>{t("Add files or photos")}</span>
							<span aria-hidden="true" className="composer-menu-shortcut">⌘U</span>
						</button>
						<div className="composer-menu-separator" role="separator" />
						<button
							aria-expanded={skillsOpen}
							className={skillsOpen ? "is-active" : undefined}
							onClick={() => setSkillsOpen((value) => !value)}
							role="menuitem"
							type="button"
						>
							<Scroll aria-hidden="true" size={16} />
							<span>{t("Skills")}</span>
							<CaretRight aria-hidden="true" className="composer-menu-caret" size={14} />
						</button>
						{skillsOpen && (
							<div className="composer-skill-menu" role="menu">
								{skills.map((skill) => (
									<button key={skill.name} onClick={() => { close(); onSelectSkill(skill); }} role="menuitem" type="button">
										<Scroll aria-hidden="true" size={16} />
										<span>{skill.name}</span>
									</button>
								))}
								<div className="composer-menu-separator" role="separator" />
								<button onClick={() => { close(); onManageSkills(); }} role="menuitem" type="button">
									<Briefcase aria-hidden="true" size={16} />
									<span>{t("Manage skills")}</span>
								</button>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
