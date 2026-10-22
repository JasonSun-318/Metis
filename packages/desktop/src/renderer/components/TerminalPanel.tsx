import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowDown, Trash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

interface TerminalPanelProps {
	readonly api: MetisDesktopApi;
	readonly cwd: string;
	readonly terminalId: string;
	readonly theme: "dark" | "light";
	readonly visible: boolean;
}

export const TERMINAL_THEMES = {
	dark: {
		background: "#141414",
		foreground: "#e8e7e2",
		cursor: "#9a9a9a",
		selectionBackground: "#585858",
		black: "#202020",
		red: "#ff8585",
		green: "#8fc17b",
		yellow: "#e4b56a",
		blue: "#75a9d6",
		magenta: "#c69bd6",
		cyan: "#78c2bd",
		white: "#e8e7e2",
		brightBlack: "#7d7c77",
		brightWhite: "#ffffff",
	},
	light: {
		background: "#fcfcfb",
		foreground: "#2e2b27",
		cursor: "#69655f",
		selectionBackground: "#dbe8f4",
		black: "#252320",
		red: "#b64235",
		green: "#397a49",
		yellow: "#956b24",
		blue: "#356a9b",
		magenta: "#80569b",
		cyan: "#2d7a78",
		white: "#d9d5ce",
		brightBlack: "#817d76",
		brightWhite: "#ffffff",
	},
} as const;

export function TerminalPanel({ api, cwd, terminalId, theme, visible }: TerminalPanelProps) {
	const { t } = useTranslation();
	const hostRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitRef = useRef<(() => void) | null>(null);
	const creationRef = useRef<Promise<unknown> | null>(null);
	const creationFailedRef = useRef(false);
	const startCreationRef = useRef<(() => void) | null>(null);
	const translateRef = useRef(t);
	const themeRef = useRef(theme);
	translateRef.current = t;
	themeRef.current = theme;
	const [status, setStatus] = useState<string | null>(null);
	const [creationFailed, setCreationFailed] = useState(false);

	const retryCreation = () => {
		const start = startCreationRef.current;
		if (!start || !creationFailedRef.current) return;
		creationFailedRef.current = false;
		creationRef.current = null;
		setCreationFailed(false);
		setStatus(null);
		start();
	};

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let active = true;
		let ready = false;
		let frame = 0;
		let lastSize = "";
		const terminal = new Terminal({
			allowTransparency: true,
			convertEol: false,
			cursorBlink: true,
			disableStdin: true,
			fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
			fontSize: 12,
			lineHeight: 1.24,
			scrollback: 1_000,
			theme: TERMINAL_THEMES[themeRef.current],
		});
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(host);
		terminalRef.current = terminal;

		const fitTerminal = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (!active || host.clientWidth === 0 || host.clientHeight === 0) return;
				fitAddon.fit();
				const size = `${terminal.cols}x${terminal.rows}`;
				if (!ready || size === lastSize) return;
				lastSize = size;
				void api.resizeTerminal({ terminalId, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
			});
		};
		fitRef.current = fitTerminal;
		const observer = new ResizeObserver(fitTerminal);
		observer.observe(host);

		const removeTerminalListener = api.subscribeTerminal((event) => {
			if (event.terminalId !== terminalId) return;
			if (event.type === "data") {
				terminal.write(event.data);
				return;
			}
			ready = false;
			terminal.options.disableStdin = true;
			terminal.options.cursorBlink = false;
			terminal.write(
				`\r\n\x1b[90m${translateRef.current("Process exited with code {{code}}", { code: event.exitCode })}\x1b[0m\r\n`,
			);
		});
		const input = terminal.onData((data) => {
			if (!ready) return;
			void api.writeTerminal({ terminalId, data }).catch(() => {
				if (active) setStatus(translateRef.current("Terminal disconnected"));
			});
		});

		const startCreation = () => {
			creationRef.current ??= api.createTerminal({ terminalId, cwd, cols: terminal.cols, rows: terminal.rows });
			void creationRef.current.then(
				() => {
					if (!active) return;
					creationFailedRef.current = false;
					setCreationFailed(false);
					ready = true;
					terminal.options.disableStdin = false;
					setStatus(null);
					fitTerminal();
					terminal.focus();
				},
				(cause) => {
					if (!active) return;
					creationFailedRef.current = true;
					setCreationFailed(true);
					setStatus(cause instanceof Error ? cause.message : translateRef.current("Terminal could not start"));
				},
			);
		};
		startCreationRef.current = startCreation;
		startCreation();

		return () => {
			active = false;
			cancelAnimationFrame(frame);
			observer.disconnect();
			removeTerminalListener();
			input.dispose();
			terminal.dispose();
			if (terminalRef.current === terminal) terminalRef.current = null;
			if (fitRef.current === fitTerminal) fitRef.current = null;
			if (startCreationRef.current === startCreation) startCreationRef.current = null;
		};
	}, [api, cwd, terminalId]);

	useEffect(() => {
		if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_THEMES[theme];
	}, [theme]);

	useEffect(() => {
		if (!visible) return;
		fitRef.current?.();
		terminalRef.current?.focus();
	}, [visible]);

	return (
		<section
			aria-hidden={!visible}
			aria-label={t("Terminal")}
			className={`terminal-panel${visible ? " is-visible" : ""}`}
			id={`terminal-panel-${terminalId}`}
			role="tabpanel"
		>
			<div className="terminal-actions">
				<button
					aria-label={t("Scroll to bottom")}
					aria-describedby={`terminal-scroll-hint-${terminalId}`}
					className="terminal-action-btn"
					onClick={() => terminalRef.current?.scrollToBottom()}
					type="button"
				>
					<ArrowDown aria-hidden="true" size={13} />
					<span className="terminal-action-tooltip" id={`terminal-scroll-hint-${terminalId}`} role="tooltip">
						{t("Scroll to bottom")}
					</span>
				</button>
				<button
					aria-label={t("Clear terminal")}
					aria-describedby={`terminal-clear-hint-${terminalId}`}
					className="terminal-action-btn"
					onClick={() => terminalRef.current?.clear()}
					type="button"
				>
					<Trash aria-hidden="true" size={13} />
					<span className="terminal-action-tooltip" id={`terminal-clear-hint-${terminalId}`} role="tooltip">
						{t("Clear terminal")}
					</span>
				</button>
			</div>
			<div className="terminal-host" ref={hostRef} />
			{status && (
				<output className="status-block terminal-status">
					{status}
					{creationFailed && (
						<button className="settings-secondary-button" onClick={retryCreation} type="button">
							{t("Retry")}
						</button>
					)}
				</output>
			)}
		</section>
	);
}
