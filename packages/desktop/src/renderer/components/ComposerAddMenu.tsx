import type { McpServerSummaryView, SkillSummaryView } from "@metis/app-protocol";
import { Books, Briefcase, CaretRight, Paperclip, Plug, Plus, Scroll } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KnowledgeLinkMenu, type KnowledgeLinkMenuProps } from "./KnowledgeLinkMenu.tsx";

interface ComposerAddMenuProps {
	readonly commandRequest?: { readonly id: number; readonly open: boolean };
	readonly disabled: boolean;
	readonly iconSize?: number;
	readonly knowledge?: KnowledgeLinkMenuProps;
	readonly mcpServers: readonly McpServerSummaryView[];
	readonly skills: readonly SkillSummaryView[];
	readonly onAddFiles: () => void;
	readonly onManageMcp: () => void;
	readonly onManageSkills: () => void;
	readonly onSelectSkill: (skill: SkillSummaryView) => void;
}

export function ComposerAddMenu({
	commandRequest,
	disabled,
	iconSize = 18,
	knowledge,
	mcpServers,
	skills,
	onAddFiles,
	onManageMcp,
	onManageSkills,
	onSelectSkill,
}: ComposerAddMenuProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [mcpOpen, setMcpOpen] = useState(false);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [knowledgeOpen, setKnowledgeOpen] = useState(false);
	const knowledgeTrigger = useRef<HTMLButtonElement>(null);
	const knowledgeMenu = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [popoverAlign, setPopoverAlign] = useState<"left" | "right">("left");
	const [popoverVertical, setPopoverVertical] = useState<"above" | "below">("above");
	const [popoverOffsetX, setPopoverOffsetX] = useState(0);
	const [popoverOffsetY, setPopoverOffsetY] = useState(0);
	const [submenuAlign, setSubmenuAlign] = useState<"right" | "left" | "stacked">("right");
	const [submenuVertical, setSubmenuVertical] = useState<"bottom" | "top">("bottom");
	const [submenuMaxHeight, setSubmenuMaxHeight] = useState(340);
	const [submenuWidth, setSubmenuWidth] = useState(280);
	const [submenuOffsetX, setSubmenuOffsetX] = useState(0);
	const [submenuOffsetY, setSubmenuOffsetY] = useState(0);
	const lastCommandRequest = useRef<number | undefined>(undefined);

	const close = useCallback((restoreFocus = false) => {
		setOpen(false);
		setMcpOpen(false);
		setSkillsOpen(false);
		setKnowledgeOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!disabled) return;
		setOpen(false);
		setMcpOpen(false);
		setSkillsOpen(false);
		setKnowledgeOpen(false);
	}, [disabled]);

	useEffect(() => {
		if (commandRequest === undefined || commandRequest.id === lastCommandRequest.current) return;
		lastCommandRequest.current = commandRequest.id;
		setOpen(commandRequest.open && !disabled);
		setMcpOpen(commandRequest.open && !disabled);
		setSkillsOpen(false);
		setKnowledgeOpen(false);
	}, [commandRequest, disabled]);

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
	}, [close, open]);

	useLayoutEffect(() => {
		if (!open) return;
		const updatePositions = () => {
			const trigger = triggerRef.current;
			if (!trigger) return;
			const triggerRect = trigger.getBoundingClientRect();
			const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
			const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
			const MARGIN = 8;
			const minX = MARGIN;
			const minY = MARGIN;
			const MAIN_MENU_WIDTH = 200;
			const menu = menuRef.current;
			const menuHeight = menu ? menu.offsetHeight : 120;
			const SUBMENU_WIDTH = Math.min(knowledgeOpen ? 280 : 180, Math.max(0, viewportWidth - MARGIN - minX));
			setSubmenuWidth(SUBMENU_WIDTH);
			const SUBMENU_PREFERRED_HEIGHT = 340;

			// 1. Popover alignment
			const fitsRight = triggerRect.left + MAIN_MENU_WIDTH + MARGIN <= viewportWidth;
			const fitsLeft = triggerRect.right - MAIN_MENU_WIDTH >= minX;
			const pAlign = !fitsRight && fitsLeft ? "right" : "left";

			const spaceAboveTrigger = triggerRect.top - minY;
			const spaceBelowTrigger = viewportHeight - triggerRect.bottom - MARGIN;
			const neededSpaceAbove = menuHeight + 4;
			const pVertical =
				spaceAboveTrigger < neededSpaceAbove && spaceBelowTrigger > spaceAboveTrigger ? "below" : "above";

			let pOffsetX = 0;
			if (pAlign === "left") {
				if (triggerRect.left + MAIN_MENU_WIDTH > viewportWidth - MARGIN) {
					pOffsetX = viewportWidth - MARGIN - (triggerRect.left + MAIN_MENU_WIDTH);
				}
				if (triggerRect.left + pOffsetX < minX) {
					pOffsetX = minX - triggerRect.left;
				}
			} else {
				if (triggerRect.right - MAIN_MENU_WIDTH < minX) {
					pOffsetX = minX - (triggerRect.right - MAIN_MENU_WIDTH);
				}
				if (triggerRect.right + pOffsetX > viewportWidth - MARGIN) {
					pOffsetX = viewportWidth - MARGIN - triggerRect.right;
				}
			}

			let pOffsetY = 0;
			if (pVertical === "above") {
				const unshiftedTop = triggerRect.top - 4 - menuHeight;
				if (unshiftedTop < minY) {
					pOffsetY = minY - unshiftedTop;
				} else if (triggerRect.top - 4 + pOffsetY > viewportHeight - MARGIN) {
					pOffsetY = viewportHeight - MARGIN - (triggerRect.top - 4);
				}
			} else {
				const unshiftedBottom = triggerRect.bottom + 4 + menuHeight;
				if (unshiftedBottom > viewportHeight - MARGIN) {
					pOffsetY = viewportHeight - MARGIN - unshiftedBottom;
				}
				if (triggerRect.bottom + 4 + pOffsetY < minY) {
					pOffsetY = minY - (triggerRect.bottom + 4);
				}
			}

			setPopoverAlign(pAlign);
			setPopoverVertical(pVertical);
			setPopoverOffsetX(pOffsetX);
			setPopoverOffsetY(pOffsetY);

			// 2. Submenu alignment
			if (skillsOpen || mcpOpen || knowledgeOpen) {
				const popoverLeft = (pAlign === "left" ? triggerRect.left : triggerRect.right - MAIN_MENU_WIDTH) + pOffsetX;
				const popoverRight = popoverLeft + MAIN_MENU_WIDTH;
				const popoverTop =
					(pVertical === "above" ? triggerRect.top - 4 - menuHeight : triggerRect.bottom + 4) + pOffsetY;
				const popoverBottom = popoverTop + menuHeight;

				let subH: "right" | "left" | "stacked" = "right";
				if (popoverRight + 3 + SUBMENU_WIDTH + MARGIN <= viewportWidth) {
					subH = "right";
				} else if (popoverLeft - 3 - SUBMENU_WIDTH >= minX) {
					subH = "left";
				} else {
					subH = "stacked";
				}

				let subV: "bottom" | "top" = "bottom";
				let maxH = SUBMENU_PREFERRED_HEIGHT;

				if (subH !== "stacked") {
					const spaceAboveMenu = popoverBottom - minY;
					const spaceBelowMenu = viewportHeight - popoverTop - MARGIN;
					if (spaceAboveMenu >= SUBMENU_PREFERRED_HEIGHT) {
						subV = "bottom";
						maxH = SUBMENU_PREFERRED_HEIGHT;
					} else if (spaceBelowMenu >= spaceAboveMenu) {
						subV = "top";
						maxH = Math.max(120, Math.min(SUBMENU_PREFERRED_HEIGHT, spaceBelowMenu));
					} else {
						subV = "bottom";
						maxH = Math.max(120, Math.min(SUBMENU_PREFERRED_HEIGHT, spaceAboveMenu));
					}
				} else {
					const spaceAbove = popoverTop - 4 - minY;
					const spaceBelow = viewportHeight - popoverBottom - 4 - MARGIN;
					if (spaceAbove >= spaceBelow) {
						subV = "bottom";
						maxH = Math.max(120, Math.min(SUBMENU_PREFERRED_HEIGHT, spaceAbove));
					} else {
						subV = "top";
						maxH = Math.max(120, Math.min(SUBMENU_PREFERRED_HEIGHT, spaceBelow));
					}
				}

				let subOffsetX = 0;
				let subOffsetY = 0;
				if (subH === "right") {
					const naturalSubRight = popoverRight + 3 + SUBMENU_WIDTH;
					if (naturalSubRight > viewportWidth - MARGIN) {
						subOffsetX = viewportWidth - MARGIN - naturalSubRight;
					}
				} else if (subH === "left") {
					const naturalSubLeft = popoverLeft - 3 - SUBMENU_WIDTH;
					if (naturalSubLeft < minX) {
						subOffsetX = minX - naturalSubLeft;
					}
				} else {
					const naturalSubRight = popoverLeft + SUBMENU_WIDTH;
					if (naturalSubRight > viewportWidth - MARGIN) {
						subOffsetX = viewportWidth - MARGIN - naturalSubRight;
					}
					if (popoverLeft + subOffsetX < minX) {
						subOffsetX = minX - popoverLeft;
					}
				}

				if (subH !== "stacked") {
					if (subV === "bottom") {
						const naturalSubTop = popoverBottom - maxH;
						if (naturalSubTop < minY) {
							subOffsetY = minY - naturalSubTop;
						}
					} else {
						const naturalSubBottom = popoverTop + maxH;
						if (naturalSubBottom > viewportHeight - MARGIN) {
							subOffsetY = viewportHeight - MARGIN - naturalSubBottom;
						}
						if (popoverTop + subOffsetY < minY) {
							subOffsetY = minY - popoverTop;
						}
					}
				} else {
					if (subV === "bottom") {
						const naturalSubTop = popoverTop - 4 - maxH;
						if (naturalSubTop < minY) {
							subOffsetY = minY - naturalSubTop;
						}
					} else {
						const naturalSubBottom = popoverBottom + 4 + maxH;
						if (naturalSubBottom > viewportHeight - MARGIN) {
							subOffsetY = viewportHeight - MARGIN - naturalSubBottom;
						}
					}
				}

				setSubmenuAlign(subH);
				setSubmenuVertical(subV);
				setSubmenuMaxHeight(maxH);
				setSubmenuOffsetX(subOffsetX);
				setSubmenuOffsetY(subOffsetY);
			}
		};
		updatePositions();
		window.addEventListener("resize", updatePositions);
		window.addEventListener("scroll", updatePositions, true);
		return () => {
			window.removeEventListener("resize", updatePositions);
			window.removeEventListener("scroll", updatePositions, true);
		};
	}, [open, skillsOpen, mcpOpen, knowledgeOpen]);

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
	}, [close, disabled, onAddFiles]);

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
					setMcpOpen(false);
					setSkillsOpen(false);
					setKnowledgeOpen(false);
				}}
				ref={triggerRef}
				type="button"
			>
				<Plus aria-hidden="true" size={iconSize} />
			</button>
			{open && (
				<div
					className={`composer-add-popover${popoverAlign === "right" ? " is-align-right" : ""}${popoverVertical === "below" ? " is-open-below" : ""}`}
					style={
						popoverOffsetX !== 0 || popoverOffsetY !== 0
							? { transform: `translate(${popoverOffsetX}px, ${popoverOffsetY}px)` }
							: undefined
					}
				>
					<div
						className="composer-add-menu"
						ref={menuRef}
						role="menu"
						onKeyDown={(event) => {
							const menu = (event.target as Element).closest('[role="menu"]');
							if (event.key === "ArrowLeft" && menu === knowledgeMenu.current) {
								event.preventDefault();
								setKnowledgeOpen(false);
								knowledgeTrigger.current?.focus();
								return;
							}
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !menu) return;
							event.preventDefault();
							const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")).filter(
								(item) => item.closest('[role="menu"]') === menu,
							);
							const current = items.indexOf(document.activeElement as HTMLButtonElement);
							const next =
								event.key === "Home"
									? 0
									: event.key === "End"
										? items.length - 1
										: event.key === "ArrowDown"
											? (current + 1) % items.length
											: (current <= 0 ? items.length : current) - 1;
							items[next]?.focus();
						}}
					>
						<button
							aria-label={t("Add files or photos")}
							onClick={() => {
								close();
								onAddFiles();
							}}
							role="menuitem"
							type="button"
						>
							<Paperclip aria-hidden="true" size={15} />
							<span>{t("Add files or photos")}</span>
							<span aria-hidden="true" className="composer-menu-shortcut">
								⌘U
							</span>
						</button>
						{knowledge && (
							<>
								<button
									aria-expanded={knowledgeOpen}
									aria-haspopup="menu"
									className={knowledgeOpen ? "is-active" : undefined}
									disabled={knowledge.disabled}
									onClick={() => {
										setKnowledgeOpen((value) => !value);
										setSkillsOpen(false);
										setMcpOpen(false);
									}}
									onKeyDown={(event) => {
										if (event.key !== "ArrowRight") return;
										event.preventDefault();
										setKnowledgeOpen(true);
										setSkillsOpen(false);
										setMcpOpen(false);
										queueMicrotask(() =>
											knowledgeMenu.current
												?.querySelector<HTMLButtonElement>("button:not(:disabled)")
												?.focus(),
										);
									}}
									ref={knowledgeTrigger}
									role="menuitem"
									type="button"
								>
									<Books aria-hidden="true" size={15} />
									<span>{t("Knowledge")}</span>
									<CaretRight aria-hidden="true" className="composer-menu-caret" size={13} />
								</button>
								{knowledgeOpen && (
									<div
										aria-label={t("Choose knowledge library")}
										className={`composer-skill-menu composer-knowledge-menu${submenuAlign === "left" ? " is-align-left" : submenuAlign === "stacked" ? " is-stacked" : ""}${submenuVertical === "top" ? " is-align-top" : ""}`}
										ref={knowledgeMenu}
										role="menu"
										style={{
											width: `${submenuWidth}px`,
											minWidth: 0,
											maxHeight: `${submenuMaxHeight}px`,
											transform: `translate(${submenuOffsetX}px, ${submenuOffsetY}px)`,
										}}
									>
										<KnowledgeLinkMenu {...knowledge} onClose={() => close(true)} />
									</div>
								)}
							</>
						)}
						<hr className="composer-menu-separator" />
						<button
							aria-expanded={skillsOpen}
							className={skillsOpen ? "is-active" : undefined}
							onClick={() => {
								setSkillsOpen((value) => !value);
								setMcpOpen(false);
								setKnowledgeOpen(false);
							}}
							role="menuitem"
							type="button"
						>
							<Scroll aria-hidden="true" size={15} />
							<span>{t("Skills")}</span>
							<CaretRight aria-hidden="true" className="composer-menu-caret" size={13} />
						</button>
						{skillsOpen && (
							<div
								className={`composer-skill-menu${submenuAlign === "left" ? " is-align-left" : submenuAlign === "stacked" ? " is-stacked" : ""}${submenuVertical === "top" ? " is-align-top" : ""}`}
								role="menu"
								style={{
									maxHeight: `${submenuMaxHeight}px`,
									...(submenuOffsetX !== 0 || submenuOffsetY !== 0
										? { transform: `translate(${submenuOffsetX}px, ${submenuOffsetY}px)` }
										: {}),
								}}
							>
								{skills.map((skill) => (
									<button
										key={skill.name}
										onClick={() => {
											close();
											onSelectSkill(skill);
										}}
										role="menuitem"
										title={skill.name}
										type="button"
									>
										<Scroll aria-hidden="true" size={15} />
										<span className="composer-menu-item-label">{skill.name}</span>
									</button>
								))}
								<hr className="composer-menu-separator" />
								<button
									onClick={() => {
										close();
										onManageSkills();
									}}
									role="menuitem"
									type="button"
								>
									<Briefcase aria-hidden="true" size={15} />
									<span className="composer-menu-item-label">{t("Manage skills")}</span>
								</button>
							</div>
						)}
						<button
							aria-expanded={mcpOpen}
							className={mcpOpen ? "is-active" : undefined}
							onClick={() => {
								setMcpOpen((value) => !value);
								setSkillsOpen(false);
								setKnowledgeOpen(false);
							}}
							role="menuitem"
							type="button"
						>
							<Plug aria-hidden="true" size={15} />
							<span>{t("MCP")}</span>
							<CaretRight aria-hidden="true" className="composer-menu-caret" size={13} />
						</button>
						{mcpOpen && (
							<div
								className={`composer-skill-menu composer-mcp-menu${submenuAlign === "left" ? " is-align-left" : submenuAlign === "stacked" ? " is-stacked" : ""}${submenuVertical === "top" ? " is-align-top" : ""}`}
								role="menu"
								style={{
									maxHeight: `${submenuMaxHeight}px`,
									...(submenuOffsetX !== 0 || submenuOffsetY !== 0
										? { transform: `translate(${submenuOffsetX}px, ${submenuOffsetY}px)` }
										: {}),
								}}
							>
								{mcpServers.map((server) => (
									<button
										key={`${server.scope}:${server.name}`}
										onClick={() => {
											close();
											onManageMcp();
										}}
										role="menuitem"
										title={server.name}
										type="button"
									>
										<Plug aria-hidden="true" size={15} />
										<span className="composer-menu-item-label">{server.name}</span>
									</button>
								))}
								<hr className="composer-menu-separator" />
								<button
									onClick={() => {
										close();
										onManageMcp();
									}}
									role="menuitem"
									type="button"
								>
									<Briefcase aria-hidden="true" size={15} />
									<span className="composer-menu-item-label">{t("Manage MCP")}</span>
								</button>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
