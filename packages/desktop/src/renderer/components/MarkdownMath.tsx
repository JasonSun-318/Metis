import katex from "katex";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopySimple } from "../icons.tsx";

// KaTeX never sees untrusted structure beyond the TeX body itself, and every
// formula gets its own macro state so one note cannot influence another.
const KATEX_OPTIONS = {
	displayMode: false,
	throwOnError: true,
	trust: false,
	maxExpand: 1000,
	maxSize: 20,
} as const;

const MAX_MATH_BYTES = 16 * 1024;

const byteEncoder = new TextEncoder();

export function MarkdownMath({
	tex,
	displayMode,
	raw,
}: {
	readonly tex: string;
	readonly displayMode: boolean;
	readonly raw?: string;
}) {
	const { t } = useTranslation();
	const [copyStatus, setCopyStatus] = useState("");
	const hostRef = useRef<HTMLSpanElement>(null);
	// The fallback state is keyed to the TeX body: a streaming edit that
	// replaces a failing formula must retry typesetting instead of sticking
	// to the fallback, so the state resets during render when `tex` changes.
	const [state, setState] = useState<{ tex: string; failed: boolean }>(() => ({ tex, failed: false }));
	if (state.tex !== tex) setState({ tex, failed: false });
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		if (byteEncoder.encode(tex).length > MAX_MATH_BYTES) {
			setState({ tex, failed: true });
			return;
		}
		host.replaceChildren();
		try {
			katex.render(tex, host, { ...KATEX_OPTIONS, displayMode, macros: {} });
		} catch {
			setState({ tex, failed: true });
		}
	}, [tex, displayMode]);
	return (
		<span className="markdown-math-container" data-markdown-math-source={tex}>
			{state.failed ? (
				<code className="markdown-math-fallback" title={t("Formula could not be rendered")}>
					{raw ?? tex}
				</code>
			) : (
				<span className="markdown-math" ref={hostRef} role="math" />
			)}
			<button
				className="markdown-math-copy"
				type="button"
				data-math-copy="true"
				aria-label={t("Copy formula")}
				title={t(copyStatus || "Copy formula")}
				onClick={() => {
					if (!navigator.clipboard) {
						setCopyStatus("Failed to copy");
						return;
					}
					void navigator.clipboard.writeText(tex).then(
						() => setCopyStatus("Copied"),
						() => setCopyStatus("Failed to copy"),
					);
				}}
			>
				<CopySimple aria-hidden="true" size={12} />
			</button>
		</span>
	);
}
