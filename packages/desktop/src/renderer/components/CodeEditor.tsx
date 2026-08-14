import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface CodeEditorProps {
	readonly label: string;
	readonly onChange: (value: string) => void;
	readonly onSave: () => void;
	readonly path: string;
	readonly value: string;
}

function languageForPath(path: string): Extension {
	const name = path.toLocaleLowerCase();
	if (name.endsWith(".tsx")) return javascript({ jsx: true, typescript: true });
	if (name.endsWith(".ts")) return javascript({ typescript: true });
	if (name.endsWith(".jsx")) return javascript({ jsx: true });
	if (/\.(?:js|mjs|cjs)$/u.test(name)) return javascript();
	if (/\.jsonc?$/u.test(name)) return json();
	if (/\.(?:md|markdown)$/u.test(name)) return markdown();
	if (name.endsWith(".css")) return css();
	if (/\.(?:html?|xhtml)$/u.test(name)) return html();
	if (name.endsWith(".py")) return python();
	if (/\.ya?ml$/u.test(name)) return yaml();
	return [];
}

const theme = EditorView.theme({
	"&": { height: "100%", backgroundColor: "var(--editor-bg)", color: "var(--editor-text)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		overflow: "auto",
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
		fontSize: "var(--code-mono-size)",
		lineHeight: "1.55",
	},
	".cm-content": { minHeight: "100%", padding: "12px 0 28px", caretColor: "var(--editor-caret)" },
	".cm-line": { padding: "0 14px 0 7px" },
	".cm-gutters": {
		backgroundColor: "var(--editor-bg)",
		borderRight: "1px solid var(--editor-border)",
		color: "var(--editor-muted)",
	},
	".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--editor-active)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--editor-selection) !important" },
	".cm-panels": { backgroundColor: "var(--editor-panel)", color: "var(--editor-text)" },
	".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--editor-border)" },
	".cm-textfield": { border: "1px solid var(--editor-border)", backgroundColor: "var(--editor-field)", color: "var(--editor-text)" },
	".cm-button": {
		border: "1px solid var(--editor-border)",
		backgroundColor: "var(--editor-button)",
		backgroundImage: "none",
		color: "var(--editor-text)",
	},
}, { dark: true });

const highContrastHighlightStyle = HighlightStyle.define([
	{ tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "#ff7b72" },
	{ tag: [tags.string, tags.docString, tags.character, tags.attributeValue], color: "#a5d6ff" },
	{ tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: "#79c0ff" },
	{ tag: [tags.function(tags.variableName), tags.propertyName, tags.attributeName, tags.labelName], color: "#d2a8ff" },
	{ tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: "#ffa657" },
	{ tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "#8b949e", fontStyle: "italic" },
	{ tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: "#ff7b72", fontWeight: "600" },
	{ tag: [tags.link, tags.url], color: "#d2a8ff", textDecoration: "underline" },
	{ tag: [tags.monospace, tags.inserted], color: "#7ee787" },
	{ tag: [tags.operator, tags.punctuation, tags.bracket], color: "#c9d1d9" },
	{ tag: tags.meta, color: "#79c0ff" },
	{ tag: tags.invalid, color: "#ff7b72", textDecoration: "underline wavy #f85149" },
]);

const chinesePhrases = EditorState.phrases.of({
	Find: "查找",
	Replace: "替换",
	next: "下一个",
	previous: "上一个",
	all: "全部",
	"match case": "区分大小写",
	regexp: "正则表达式",
	"by word": "全字匹配",
	replace: "替换",
	"replace all": "全部替换",
	close: "关闭",
	"Go to line": "跳转到行",
	go: "跳转",
	"current match": "当前匹配",
	"on line": "位于行",
	"replaced match on line $": "已替换第 $ 行的匹配",
	"replaced $ matches": "已替换 $ 个匹配",
});

export function CodeEditor({ label, onChange, onSave, path, value }: CodeEditorProps) {
	const { i18n } = useTranslation();
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	const editorValueRef = useRef(value);
	const applyingControlledValue = useRef(false);
	onChangeRef.current = onChange;
	onSaveRef.current = onSave;

	useEffect(() => {
		const parent = hostRef.current;
		if (!parent) return;
		editorValueRef.current = value;
		const view = new EditorView({
			doc: value,
			parent,
			extensions: [
				Prec.high(keymap.of([{
					key: "Mod-s",
					preventDefault: true,
					run: () => {
						onSaveRef.current();
						return true;
					},
				}])),
				basicSetup,
				EditorState.tabSize.of(4),
				EditorView.contentAttributes.of({ "aria-label": label }),
				theme,
				syntaxHighlighting(highContrastHighlightStyle),
				i18n.language.startsWith("zh") ? chinesePhrases : [],
				languageForPath(path),
				EditorView.updateListener.of((update) => {
					if (update.docChanged && !applyingControlledValue.current) {
						editorValueRef.current = update.state.doc.toString();
						onChangeRef.current(editorValueRef.current);
					}
				}),
			],
		});
		viewRef.current = view;
		return () => {
			viewRef.current = null;
			view.destroy();
		};
	}, [i18n.language, label, path]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view || editorValueRef.current === value) return;
		editorValueRef.current = value;
		applyingControlledValue.current = true;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
		applyingControlledValue.current = false;
	}, [value]);

	return <div className="file-code-editor" ref={hostRef} />;
}
