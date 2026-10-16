import type { SessionProcessView } from "@metis/app-protocol";
import { Copy } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { TERMINAL_THEMES } from "./TerminalPanel.tsx";

interface ProcessPanelProps {
	readonly process: SessionProcessView;
	readonly panelId: string;
	readonly theme: "dark" | "light";
	readonly visible: boolean;
	readonly onError: (cause: unknown) => void;
}

export function ProcessPanel({ process, panelId, theme, visible, onError }: ProcessPanelProps) {
	const { t } = useTranslation();
	const hostRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitRef = useRef<(() => void) | null>(null);
	const renderedOutput = useRef("");
	const themeRef = useRef(theme);
	themeRef.current = theme;

	// biome-ignore lint/correctness/useExhaustiveDependencies(process.processId): A different process recreates the terminal, replays its output, and refits the viewport.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const terminal = new Terminal({
			disableStdin: true,
			convertEol: true,
			cursorBlink: false,
			fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
			fontSize: 12,
			lineHeight: 1.3,
			scrollback: 2_000,
			screenReaderMode: true,
			theme: TERMINAL_THEMES[themeRef.current],
		});
		const addon = new FitAddon();
		terminal.loadAddon(addon);
		terminal.open(host);
		terminalRef.current = terminal;
		renderedOutput.current = "";
		let frame = 0;
		const fitTerminal = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (host.clientWidth && host.clientHeight) addon.fit();
			});
		};
		fitRef.current = fitTerminal;
		const observer = new ResizeObserver(fitTerminal);
		observer.observe(host);
		fitTerminal();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			fitRef.current = null;
			terminalRef.current = null;
			terminal.dispose();
		};
	}, [process.processId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(process.processId): A different process recreates the terminal, replays its output, and refits the viewport.
	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;
		const previous = renderedOutput.current;
		// bash updates contain the cumulative bounded tail, not output deltas.
		if (process.output.startsWith(previous)) terminal.write(process.output.slice(previous.length));
		else terminal.write(`\x1bc${process.output}`);
		renderedOutput.current = process.output;
	}, [process.processId, process.output]);

	useEffect(() => {
		if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_THEMES[theme];
	}, [theme]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(process.processId): A different process recreates the terminal, replays its output, and refits the viewport.
	useEffect(() => {
		if (visible) fitRef.current?.();
	}, [visible, process.processId]);

	return (
		<section aria-label="Process" className="process-panel" hidden={!visible} id={panelId} role="tabpanel">
			<div className="process-toolbar">
				<output className={`process-state is-${process.state}`}>
					<span aria-hidden="true" />
					{t(
						process.state === "running"
							? "Command running"
							: process.state === "completed"
								? "Command completed"
								: "Command stopped with an error",
					)}
				</output>
				<button
					aria-label={t("Copy output")}
					className="icon-button"
					disabled={!process.output}
					onClick={() => {
						void navigator.clipboard.writeText(process.output).catch(onError);
					}}
					title={t("Copy output")}
					type="button"
				>
					<Copy aria-hidden="true" size={14} />
				</button>
			</div>
			<pre className="process-command">
				<span aria-hidden="true">$ </span>
				{process.command}
			</pre>
			{process.truncated && (
				<p className="process-notice">{t("Showing the latest output; earlier output was truncated.")}</p>
			)}
			{!process.output && (
				<p className="process-notice">
					{t(process.state === "running" ? "Waiting for command output…" : "This command produced no output.")}
				</p>
			)}
			<section aria-label={t("Command output")} className="process-output terminal-host" ref={hostRef} />
		</section>
	);
}
