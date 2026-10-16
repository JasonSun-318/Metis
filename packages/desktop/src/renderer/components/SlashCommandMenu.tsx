import type { SkillSummaryView } from "@metis/app-protocol";
import { ArrowsIn, Brain, Cube, Gauge, ListChecks, Plugs, Scroll, Target } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type ComposerSlashCommand = "compact" | "goal" | "plan" | "model" | "thinking" | "status" | "mcp";

export const composerSlashCommands: readonly ComposerSlashCommand[] = [
	"compact",
	"goal",
	"plan",
	"model",
	"thinking",
	"status",
	"mcp",
];

const commandCopy: Record<ComposerSlashCommand, { readonly label: string; readonly description: string }> = {
	compact: { label: "/compact", description: "Compact conversation" },
	goal: { label: "/goal", description: "Set or control the session goal" },
	plan: { label: "/plan", description: "Enter Plan mode" },
	model: { label: "/model", description: "Choose model" },
	thinking: { label: "/thinking", description: "Choose reasoning effort" },
	status: { label: "/status", description: "Show session status" },
	mcp: { label: "/mcp", description: "Show MCP servers" },
};

const commandIcons = {
	compact: ArrowsIn,
	goal: Target,
	plan: ListChecks,
	model: Cube,
	thinking: Brain,
	status: Gauge,
	mcp: Plugs,
} as const;

type MenuOption =
	| { readonly kind: "command"; readonly key: string; readonly command: ComposerSlashCommand }
	| { readonly kind: "skill"; readonly key: string; readonly skill: SkillSummaryView };

interface SlashCommandMenuProps {
	readonly disabledCommands: ReadonlySet<ComposerSlashCommand>;
	readonly disabledReasons?: Partial<Record<ComposerSlashCommand, string>>;
	readonly onDismiss: () => void;
	readonly onSelectCommand: (command: ComposerSlashCommand) => void;
	readonly onSelectSkill: (skill: SkillSummaryView) => void;
	readonly query: string;
	readonly skills: readonly SkillSummaryView[];
}

export function SlashCommandMenu({
	disabledCommands,
	disabledReasons = {},
	onDismiss,
	onSelectCommand,
	onSelectSkill,
	query,
	skills,
}: SlashCommandMenuProps) {
	const { t } = useTranslation();
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const options = useMemo<MenuOption[]>(
		() => [
			...composerSlashCommands
				.filter((command) => command.includes(normalizedQuery))
				.map((command) => ({ kind: "command" as const, key: command, command })),
			...skills
				.filter((skill) => `skill:${skill.name}`.toLocaleLowerCase().includes(normalizedQuery))
				.map((skill) => ({ kind: "skill" as const, key: `skill:${skill.name}`, skill })),
		],
		[normalizedQuery, skills],
	);
	const [activeIndex, setActiveIndex] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies(options.length): Changing the query or option count resets keyboard selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies(normalizedQuery): Changing the query or option count resets keyboard selection.
	useEffect(() => setActiveIndex(0), [normalizedQuery, options.length]);
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) onDismiss();
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [onDismiss]);
	useEffect(() => {
		if (options.length === 0) return;
		const select = (option: MenuOption | undefined) => {
			if (!option || (option.kind === "command" && disabledCommands.has(option.command))) return;
			option.kind === "command" ? onSelectCommand(option.command) : onSelectSkill(option.skill);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onDismiss();
				return;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				event.stopPropagation();
				setActiveIndex(
					(current) => (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length,
				);
				return;
			}
			if (event.key !== "Enter" && event.key !== "Tab") return;
			event.preventDefault();
			event.stopPropagation();
			select(options[activeIndex]);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [activeIndex, disabledCommands, onDismiss, onSelectCommand, onSelectSkill, options]);

	if (options.length === 0) return null;
	const firstSkillIndex = options.findIndex((option) => option.kind === "skill");
	return (
		<div
			aria-activedescendant={`slash-option-${activeIndex}`}
			aria-label={t("Slash commands")}
			className="slash-command-menu"
			ref={rootRef}
			role="listbox"
			tabIndex={0}
		>
			{options.map((option, index) => {
				if (option.kind === "skill") {
					return (
						<div className="slash-command-option-wrap" key={option.key}>
							{index === firstSkillIndex && <p className="slash-command-section">{t("Skills")}</p>}
							<button
								aria-selected={index === activeIndex}
								className={index === activeIndex ? "is-active" : undefined}
								id={`slash-option-${index}`}
								onClick={() => onSelectSkill(option.skill)}
								onPointerMove={() => setActiveIndex(index)}
								role="option"
								type="button"
							>
								<Scroll aria-hidden="true" size={16} />
								<span>
									<strong>{`skill:${option.skill.name}`}</strong>
									<small>{option.skill.description}</small>
								</span>
							</button>
						</div>
					);
				}
				const disabled = disabledCommands.has(option.command);
				const Icon = commandIcons[option.command];
				return (
					<button
						aria-disabled={disabled || undefined}
						aria-selected={index === activeIndex}
						className={index === activeIndex ? "is-active" : undefined}
						id={`slash-option-${index}`}
						key={option.key}
						onClick={() => {
							if (!disabled) onSelectCommand(option.command);
						}}
						onPointerMove={() => setActiveIndex(index)}
						role="option"
						type="button"
					>
						<Icon aria-hidden="true" size={16} />
						<span>
							<strong>{commandCopy[option.command].label}</strong>
							<small>{t(disabledReasons[option.command] ?? commandCopy[option.command].description)}</small>
						</span>
					</button>
				);
			})}
		</div>
	);
}
