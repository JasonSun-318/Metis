import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PreviewToolbar } from "./PreviewToolbar.tsx";
import { decodePreviewText } from "./preview-bytes.ts";

const THEME_MESSAGE = "metis-preview-theme";
const READY_MESSAGE = "metis-preview-ready";
const THEME_VARIABLES = [
	"--app-bg",
	"--surface-02",
	"--surface-03",
	"--text",
	"--text-strong",
	"--muted",
	"--accent",
	"--accent-ink",
	"--link",
	"--border",
	"--border-weak",
] as const;

// The frame runs model-authored scripts in an opaque origin: sandbox only
// grants allow-scripts, so the page cannot reach the host document. A small
// bridge lets it follow the host theme through postMessage instead.
const THEME_BRIDGE = [
	"<script>",
	"(() => {",
	"\tconst apply = (data) => {",
	`\t\tif (!data || data.type !== "${THEME_MESSAGE}") return;`,
	"\t\tconst root = document.documentElement;",
	`\t\tif (data.theme === "dark" || data.theme === "light") root.style.colorScheme = data.theme;`,
	"\t\tconst variables = data.variables;",
	'\t\tif (!variables || typeof variables !== "object") return;',
	"\t\tfor (const [name, value] of Object.entries(variables)) {",
	'\t\t\tif (/^--[a-z0-9-]+$/i.test(name) && typeof value === "string" && value.length <= 4096) {',
	"\t\t\t\troot.style.setProperty(name, value);",
	"\t\t\t}",
	"\t\t}",
	"\t};",
	'\tglobalThis.addEventListener("message", (event) => {',
	"\t\tif (event.source !== globalThis.parent) return;",
	"\t\tapply(event.data);",
	"\t});",
	`\tglobalThis.parent.postMessage({ type: "${READY_MESSAGE}" }, "*");`,
	"})();",
	"</script>",
].join("\n");

function withThemeBridge(html: string): string {
	const headEnd = html.search(/<\/head\s*>/i);
	if (headEnd >= 0) return `${html.slice(0, headEnd)}${THEME_BRIDGE}${html.slice(headEnd)}`;
	return `${THEME_BRIDGE}${html}`;
}

export interface HtmlViewerProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

export function HtmlViewer({ fileName, byteLength, bytes, onClose, onOpenDefault, onReveal }: HtmlViewerProps) {
	const { t } = useTranslation();
	const [mode, setMode] = useState<"preview" | "source">("preview");
	const frameRef = useRef<HTMLIFrameElement>(null);
	const source = useMemo(() => decodePreviewText(bytes), [bytes]);
	const documentSource = useMemo(() => withThemeBridge(source), [source]);

	const postTheme = useCallback(() => {
		const frame = frameRef.current?.contentWindow;
		if (!frame) return;
		const root = document.documentElement;
		const style = getComputedStyle(root);
		const variables: Record<string, string> = {};
		for (const name of THEME_VARIABLES) {
			const value = style.getPropertyValue(name).trim();
			if (value) variables[name] = value;
		}
		frame.postMessage(
			{ type: THEME_MESSAGE, theme: root.dataset.theme === "light" ? "light" : "dark", variables },
			"*",
		);
	}, []);

	useEffect(() => {
		if (mode !== "preview") return;
		const observer = new MutationObserver(postTheme);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frameRef.current?.contentWindow) return;
			if ((event.data as { type?: unknown } | null)?.type === READY_MESSAGE) postTheme();
		};
		window.addEventListener("message", onMessage);
		return () => {
			observer.disconnect();
			window.removeEventListener("message", onMessage);
		};
	}, [mode, postTheme]);

	const modeActions = (
		<fieldset aria-label={t("Preview mode")} className="control-group settings-segmented preview-html-modes">
			<button aria-pressed={mode === "preview"} onClick={() => setMode("preview")} type="button">
				{t("Rendered")}
			</button>
			<button aria-pressed={mode === "source"} onClick={() => setMode("source")} type="button">
				{t("Source code")}
			</button>
		</fieldset>
	);

	return (
		<div className="universal-previewer preview-html-viewer">
			<PreviewToolbar
				byteLength={byteLength}
				extraActions={modeActions}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
			/>
			{mode === "preview" ? (
				<iframe
					className="preview-html-frame"
					onLoad={postTheme}
					referrerPolicy="no-referrer"
					ref={frameRef}
					sandbox="allow-scripts"
					srcDoc={documentSource}
					title={fileName}
				/>
			) : (
				<pre className="preview-html-source">{source}</pre>
			)}
		</div>
	);
}
