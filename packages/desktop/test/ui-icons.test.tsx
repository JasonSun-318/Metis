// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Scroll as createScrollIcon } from "reicon/icons/Scroll";
import { Target as createTargetIcon } from "reicon/icons/Target";
import { Code as ReiconCode } from "reicon-react/icons/Code";
import { Folder as ReiconFolder } from "reicon-react/icons/Folder";
import { FolderOpen as ReiconFolderOpen } from "reicon-react/icons/FolderOpen";
import { Globe as ReiconGlobe } from "reicon-react/icons/Globe";
import { MoreH as ReiconMoreH } from "reicon-react/icons/MoreH";
import { Widget2 as ReiconWidget2 } from "reicon-react/icons/Widget2";
import { afterEach, describe, expect, it, vi } from "vitest";
import githubMark from "../src/renderer/assets/github-mark.svg";
import { AnimatedNavIcon } from "../src/renderer/components/AnimatedNavIcon.tsx";
import { Composer } from "../src/renderer/components/Composer.tsx";
import { GitHubBrandIcon } from "../src/renderer/components/GitHubBrandIcon.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import {
	Browser,
	CaretLeft,
	CaretRight,
	Cpu,
	Customize,
	Database,
	DotsThree,
	DotsThreeVertical,
	Folder,
	Gear,
	Plus,
	Programming,
	Robot,
	Tool,
} from "../src/renderer/icons.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();

afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount();
	});
	roots.clear();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

async function mount(content: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(content));
	return { container, render: async (next: ReactNode) => act(async () => root.render(next)) };
}

function svg(container: ParentNode): SVGSVGElement {
	const element = container.querySelector("svg");
	if (!element) throw new Error("Expected a rendered SVG icon");
	return element;
}

function type(editor: HTMLElement, value: string) {
	const text = document.createTextNode(value);
	editor.append(text);
	const range = document.createRange();
	range.selectNodeContents(text);
	range.collapse(false);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function rendererSources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		return entry.isDirectory() ? rendererSources(file) : /\.[jt]sx?$/u.test(entry.name) ? [file] : [];
	});
}

describe("Shared UI icons", () => {
	it("keeps decorative icons font-sized and forwards the real SVG ref", async () => {
		const ref = createRef<SVGSVGElement>();
		const { container } = await mount(<Plus className="toolbar-icon" ref={ref} />);
		const element = svg(container);

		expect(ref.current).toBe(element);
		expect(element.getAttribute("width")).toBe("1em");
		expect(element.getAttribute("height")).toBe("1em");
		expect(element.getAttribute("viewBox")).toBe("0 0 24 24");
		expect(element.classList.contains("reicon")).toBe(true);
		expect(element.classList.contains("toolbar-icon")).toBe(true);
		expect(element.getAttribute("aria-hidden")).toBe("true");
		expect(element.getAttribute("focusable")).toBe("false");
	});

	it("keeps static glyph DOM intact across parent content updates", async () => {
		const scene = (text: string) => (
			<>
				<Plus size={16} />
				<span>{text}</span>
			</>
		);
		const { container, render } = await mount(scene("Before"));
		const glyph = svg(container).firstElementChild;
		await render(scene("After"));
		expect(container.textContent).toContain("After");
		expect(svg(container).firstElementChild).toBe(glyph);
	});

	it("preserves accessible names, explicit ARIA, events and currentColor styling", async () => {
		const onClick = vi.fn();
		const { container, render } = await mount(
			<Plus aria-label="Add item" color="rebeccapurple" onClick={onClick} role="img" size={18} />,
		);
		let element = svg(container);
		expect(element.getAttribute("aria-label")).toBe("Add item");
		expect(element.getAttribute("role")).toBe("img");
		expect(element.hasAttribute("aria-hidden")).toBe(false);
		expect(element.getAttribute("width")).toBe("18");
		expect(element.getAttribute("height")).toBe("18");
		expect(element.style.color).toBe("rebeccapurple");
		expect(element.querySelector('[fill="currentColor"], [stroke="currentColor"]')).not.toBeNull();
		await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onClick).toHaveBeenCalledOnce();

		await render(<Plus aria-hidden={false} aria-labelledby="icon-description" size="1.5rem" />);
		element = svg(container);
		expect(element.getAttribute("aria-hidden")).toBe("false");
		expect(element.getAttribute("aria-labelledby")).toBe("icon-description");
		expect(element.getAttribute("width")).toBe("1.5rem");
	});

	it("renders the library's distinct Outline and Filled artwork", async () => {
		const { container, render } = await mount(<Folder />);
		const outline = svg(container).innerHTML;
		await render(<ReiconFolder weight="Outline" />);
		expect(svg(container).innerHTML).toBe(outline);

		await render(<Folder weight="fill" />);
		const filled = svg(container).innerHTML;
		expect(filled).not.toBe(outline);
		await render(<ReiconFolder weight="Filled" />);
		expect(svg(container).innerHTML).toBe(filled);
	});

	it("uses official compact widgets, code brackets and globe artwork for their semantic exports", async () => {
		const view = await mount(null);
		for (const [semantic, official, paths] of [
			[Customize, ReiconWidget2, 4],
			[Programming, ReiconCode, 3],
			[Browser, ReiconGlobe, 1],
		] as const) {
			const Semantic = semantic;
			const Official = official;
			await view.render(<Semantic />);
			const artwork = svg(view.container).innerHTML;
			expect(svg(view.container).querySelectorAll("path")).toHaveLength(paths);
			await view.render(<Official weight="Outline" />);
			expect(svg(view.container).innerHTML).toBe(artwork);
		}
	});

	it("keeps horizontal and vertical menu dots filled across weights and preserves caller SVG props", async () => {
		const ref = createRef<SVGSVGElement>();
		const view = await mount(<ReiconMoreH weight="Filled" />);
		const filled = svg(view.container).innerHTML;
		expect(svg(view.container).querySelectorAll('path[fill="currentColor"]')).toHaveLength(3);
		for (const Menu of [DotsThree, DotsThreeVertical]) {
			for (const weight of ["regular", "bold", "fill"] as const) {
				await view.render(
					<Menu
						aria-label="More actions"
						className="menu-trigger-icon"
						ref={ref}
						role="img"
						size={18}
						style={{ opacity: 0.6, color: "rebeccapurple", transform: "translateX(2px)" }}
						weight={weight}
					/>,
				);
				const element = svg(view.container);
				expect(element.innerHTML).toBe(filled);
				expect(ref.current).toBe(element);
				expect(element.classList.contains("menu-trigger-icon")).toBe(true);
				expect(element.getAttribute("aria-label")).toBe("More actions");
				expect(element.getAttribute("role")).toBe("img");
				expect(element.hasAttribute("aria-hidden")).toBe(false);
				expect(element.getAttribute("width")).toBe("18");
				expect(element.getAttribute("height")).toBe("18");
				expect(element.style.opacity).toBe("0.6");
				expect(element.style.color).toBe("rebeccapurple");
				expect(element.style.transform).toBe("translateX(2px)");
				expect(element.style.rotate).toBe(Menu === DotsThreeVertical ? "90deg" : "");
				expect(element.style.transformOrigin).toBe(Menu === DotsThreeVertical ? "center" : "");
			}
		}
	});

	it("crossfades compact official closed and open folders without replacing their artwork", async () => {
		const { container, render } = await mount(<ReiconFolder />);
		const closedArtwork = svg(container).innerHTML;
		await render(<ReiconFolderOpen />);
		const openArtwork = svg(container).innerHTML;
		expect(openArtwork).not.toBe(closedArtwork);
		await render(<AnimatedNavIcon className="project-icon" kind="folder" />);
		const wrapper = container.querySelector(".sidebar-folder-icon")!;
		const closed = wrapper.querySelector('svg[data-folder-state="closed"]')!;
		const open = wrapper.querySelector('svg[data-folder-state="open"]')!;
		expect(wrapper.getAttribute("data-expanded")).toBe("false");
		expect(closed.innerHTML).toBe(closedArtwork);
		expect(open.innerHTML).toBe(openArtwork);
		for (const element of [closed, open]) {
			expect(element.classList.contains("animated-nav-icon-folder")).toBe(true);
			expect(element.classList.contains("project-icon")).toBe(true);
			expect(element.getAttribute("width")).toBe("14");
			expect(element.getAttribute("height")).toBe("14");
			expect(element.getAttribute("aria-hidden")).toBe("true");
		}
		for (const expanded of [true, false, true]) {
			await render(<AnimatedNavIcon className="project-icon" expanded={expanded} kind="folder" />);
			expect(container.querySelector(".sidebar-folder-icon")).toBe(wrapper);
			expect(wrapper.getAttribute("data-expanded")).toBe(String(expanded));
			expect(wrapper.querySelector('svg[data-folder-state="closed"]')).toBe(closed);
			expect(wrapper.querySelector('svg[data-folder-state="open"]')).toBe(open);
		}
	});

	it("uses open disclosure angles and keeps tools, agents and memory distinct from settings and hardware", async () => {
		const { container } = await mount(
			<>
				<CaretRight />
				<CaretLeft />
				<Tool />
				<Gear />
				<Robot />
				<Cpu />
				<Database />
			</>,
		);
		const glyphs = [...container.querySelectorAll("svg")];
		expect(glyphs[0]?.querySelector("polyline")).not.toBeNull();
		expect(glyphs[1]?.querySelector("polyline")).not.toBeNull();
		expect(glyphs[0]?.querySelector("path")).toBeNull();
		expect(glyphs[1]?.querySelector("path")).toBeNull();
		expect(glyphs[2]?.innerHTML).not.toBe(glyphs[3]?.innerHTML);
		expect(glyphs[4]?.innerHTML).not.toBe(glyphs[5]?.innerHTML);
		expect(glyphs[6]?.innerHTML).not.toBe(glyphs[5]?.innerHTML);
		for (const element of glyphs) {
			expect(element.getAttribute("aria-hidden")).toBe("true");
			expect(element.classList.contains("reicon")).toBe(true);
		}
	});

	it("uses DOM-library icons for composer tokens without interpreting skill names as markup", async () => {
		await setLocale("en");
		const name = '"><img/src=x/onerror=alert(1)>';
		const { container } = await mount(
			<Composer
				disabled={false}
				onGoalCommand={async () => undefined}
				onInterrupt={async () => undefined}
				onSubmit={async () => undefined}
				running={false}
				skills={[{ name, description: "An ordinary skill label" }]}
			/>,
		);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
				.find((item) => item.textContent?.trim() === "Skills")!
				.click(),
		);
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
				.find((item) => item.textContent?.trim() === name)!
				.click(),
		);
		const skill = container.querySelector<HTMLElement>('[data-token-kind="skill"]')!;
		expect(skill.querySelector(".composer-token-name")?.textContent).toBe(name);
		expect(skill.getAttribute("aria-label")).toBe(`Remove skill ${name}`);
		expect(skill.getAttribute("role")).toBe("button");
		expect(skill.contentEditable).toBe("false");
		expect(svg(skill).innerHTML).toBe(createScrollIcon().innerHTML);
		expect(container.querySelector("img, script, [onerror]")).toBeNull();

		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => type(editor, "/goal"));
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((option) => option.querySelector("strong")?.textContent === "/goal")!
				.click(),
		);
		const goal = container.querySelector<HTMLElement>('[data-token-kind="goal"]')!;
		expect(svg(goal).innerHTML).toBe(createTargetIcon().innerHTML);
		for (const token of [skill, goal]) {
			expect(svg(token).classList.contains("reicon")).toBe(true);
			expect(svg(token).getAttribute("width")).toBe("14");
			expect(svg(token).getAttribute("aria-hidden")).toBe("true");
			expect(svg(token).getAttribute("focusable")).toBe("false");
		}
		await act(async () => skill.click());
		expect(container.querySelector('[data-token-kind="skill"]')).toBeNull();
		expect(container.querySelector('[data-token-kind="goal"]')).toBe(goal);
	});

	it("keeps the official brand mark separate from general UI artwork", async () => {
		const { container } = await mount(<GitHubBrandIcon size={22} />);
		const mark = container.querySelector<HTMLElement>(".github-brand-icon")!;
		expect(mark.getAttribute("aria-hidden")).toBe("true");
		expect(mark.style.width).toBe("22px");
		expect(mark.style.height).toBe("22px");
		expect(mark.style.maskImage).toContain(githubMark);
		expect(container.querySelector("svg.reicon")).toBeNull();
	});

	it("keeps library ownership centralized and only permits purpose-built data SVGs", () => {
		const directory = path.join(process.cwd(), "src/renderer");
		const failures: string[] = [];
		const dataVisualizations = new Set(["components/ContextUsageRing.tsx", "components/KnowledgeGraph.tsx"]);
		for (const file of rendererSources(directory)) {
			const relative = path.relative(directory, file).replaceAll(path.sep, "/");
			const source = readFileSync(file, "utf8");
			if (source.includes("@phosphor-icons/react")) failures.push(`${relative}: legacy icon import`);
			if (/from\s+["']reicon-react(?:\/|["'])/u.test(source) && relative !== "icons.tsx") {
				failures.push(`${relative}: bypasses shared React icon adapter`);
			}
			if (/from\s+["']reicon(?:\/|["'])/u.test(source) && relative !== "components/Composer.tsx") {
				failures.push(`${relative}: unexpected DOM icon factory owner`);
			}
			if (/<svg\b|createElementNS\s*\(/u.test(source) && !dataVisualizations.has(relative)) {
				failures.push(`${relative}: hand-authored general SVG`);
			}
		}
		expect(failures).toEqual([]);
	});
});
