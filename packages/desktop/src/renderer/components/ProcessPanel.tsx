import type { ClientResult, SessionProcessView } from "@metis/app-protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { Play, SkipBack, SkipForward } from "../icons.tsx";
import { iconSize } from "../ui/icon-size.ts";
import { TERMINAL_THEMES } from "./TerminalPanel.tsx";

interface ProcessPanelProps {
	readonly api: Pick<MetisDesktopApi, "readProcess">;
	readonly sessionId: string;
	readonly process?: SessionProcessView;
	readonly panelId: string;
	readonly theme: "dark" | "light";
	readonly visible: boolean;
	readonly onError: (cause: unknown) => void;
}

export function ProcessPanel({ api, sessionId, process: latest, panelId, theme, visible, onError }: ProcessPanelProps) {
	const { t, i18n } = useTranslation();
	const [selection, setSelection] = useState<{ index: number; processId?: string } | null>(null);
	const [position, setPosition] = useState(0);
	const [page, setPage] = useState<ClientResult<"session/readProcess">>();
	const [error, setError] = useState(false);
	const [retry, setRetry] = useState(0);
	const reads = useRef<{ running: boolean; pending?: () => Promise<void> }>({ running: false });
	// biome-ignore lint/correctness/useExhaustiveDependencies: Resolving an index to its identity must not reread the same body. Command boundaries and retry refresh it; streaming output uses the live prop.
	useEffect(() => {
		if (!visible) return;
		let active = true;
		const queue = reads.current;
		const read = async () => {
			setError(false);
			await api.readProcess({ sessionId, ...selection }).then(
				(result) => {
					if (!active) return;
					setPage(result);
					if (selection && result.process && selection.processId !== result.process.processId)
						setSelection({ index: result.index, processId: result.process.processId });
				},
				(cause) => {
					if (active) {
						setError(true);
						onError(cause);
					}
				},
			);
		};
		// Keep one in-flight read and only the newest pending selection. The thumb
		// moves immediately; obsolete commands never enter the server's serial queue.
		queue.pending = read;
		if (!queue.running) {
			queue.running = true;
			void (async () => {
				try {
					while (queue.pending) {
						const next = queue.pending;
						queue.pending = undefined;
						await next();
					}
				} finally {
					queue.running = false;
				}
			})();
		}
		return () => {
			active = false;
			if (queue.pending === read) queue.pending = undefined;
		};
	}, [api, sessionId, visible, selection?.index, latest?.revision, latest?.processId, retry, onError]);
	// Only a deliberately selected concurrent running command needs polling.
	// The latest command already arrives through the session event stream.
	useEffect(() => {
		if (
			!visible ||
			!selection ||
			error ||
			(page?.process?.state !== "running" && page?.process?.state !== "awaiting_approval")
		)
			return;
		const timer = window.setInterval(() => {
			// A slow poll must finish before another poll can supersede its response.
			if (!reads.current.running) setRetry((value) => value + 1);
		}, 500);
		return () => window.clearInterval(timer);
	}, [visible, selection, page?.process?.state, error]);
	const process = selection === null ? (latest ?? page?.process) : page?.process;
	const total = page?.total ?? (process ? 1 : 0);
	const index = selection === null ? Math.max(0, total - 1) : (selection.index ?? page?.index ?? 0);
	const progress = total ? (selection === null ? 100 : (position / (total * 1000)) * 100) : 0;
	// A seek updates the thumb before its body arrives. Never label the new position
	// with the previous command's timestamp while that read is pending.
	const selectedStartedAt = selection === null || page?.index === index ? process?.startedAt : undefined;
	const dateLabel = useMemo(() => {
		if (!selectedStartedAt) return;
		const date = new Date(selectedStartedAt);
		const locale = i18n.resolvedLanguage;
		return {
			short: new Intl.DateTimeFormat(locale, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hourCycle: "h23",
			}).format(date),
			full: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "medium" }).format(date),
		};
	}, [selectedStartedAt, i18n.resolvedLanguage]);
	const select = (target: number, nextPosition = (target + 0.5) * 1000) => {
		setPosition(nextPosition);
		if (selection === null || index !== target) setSelection({ index: target });
	};
	return (
		<section aria-label={t("Activity log")} className="process-panel" hidden={!visible} id={panelId} role="tabpanel">
			{error ? (
				<div className="process-notice" role="alert">
					{t("Couldn’t load activity log.")}{" "}
					<button type="button" onClick={() => setRetry((value) => value + 1)}>
						{t("Retry")}
					</button>
				</div>
			) : null}
			{visible && process ? (
				<ProcessOutput process={process} theme={theme} />
			) : !page ? (
				<p className="process-notice">{t("Loading…")}</p>
			) : (
				<p className="process-notice">{t("No commands in this conversation yet.")}</p>
			)}
			<footer className="process-history-footer">
				{selection !== null && total > 0 ? (
					<button className="process-return-live" type="button" onClick={() => setSelection(null)}>
						<Play aria-hidden="true" size={iconSize.lg} />
						{t("Return to live")}
					</button>
				) : null}
				<div className="process-history-controls">
					<button
						type="button"
						className="icon-button"
						aria-label={t("Previous command")}
						disabled={index <= 0 || !total}
						onClick={() => select(index - 1)}
					>
						<SkipBack aria-hidden="true" size={iconSize.md} />
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={t("Next command")}
						disabled={!total || index >= total - 1}
						onClick={() => select(index + 1)}
					>
						<SkipForward aria-hidden="true" size={iconSize.md} />
					</button>
					<div className="process-history-timeline">
						{dateLabel ? (
							<time
								className="process-history-date"
								dateTime={selectedStartedAt}
								title={dateLabel.full}
								style={{
									left: `clamp(0px, calc(${progress}% - var(--process-date-width) / 2), calc(100% - var(--process-date-width)))`,
								}}
							>
								{dateLabel.short}
							</time>
						) : null}
						<div className="process-history-rail" aria-hidden="true">
							<span style={{ width: `${progress}%` }} />
						</div>
						<input
							className="process-history-range"
							type="range"
							aria-label={t("Command history")}
							aria-valuetext={[
								dateLabel?.full,
								t("Command {{index}} of {{total}}", { index: total ? index + 1 : 0, total }),
							]
								.filter(Boolean)
								.join(" · ")}
							min={0}
							max={Math.max(1, total * 1000)}
							step={1}
							value={total ? (selection === null ? total * 1000 : position) : 0}
							disabled={!total}
							onChange={(event) => {
								const nextPosition = Number(event.currentTarget.value);
								if (nextPosition >= total * 1000) setSelection(null);
								else select(Math.floor(nextPosition / 1000), nextPosition);
							}}
							onKeyDown={(event) => {
								if (event.key === "End") {
									event.preventDefault();
									setSelection(null);
									return;
								}
								const target =
									event.key === "ArrowLeft" || event.key === "ArrowDown"
										? index - 1
										: event.key === "ArrowRight" || event.key === "ArrowUp"
											? index + 1
											: event.key === "Home"
												? 0
												: undefined;
								if (target !== undefined) {
									event.preventDefault();
									select(Math.max(0, Math.min(total - 1, target)), event.key === "Home" ? 0 : undefined);
								}
							}}
						/>
					</div>
					<span className="process-history-position sr-only">
						{total ? index + 1 : 0}/{total}
					</span>
					<button
						type="button"
						className={`process-live${selection === null ? " is-live" : ""}`}
						disabled={selection === null}
						onClick={() => setSelection(null)}
						title={t("Return to live")}
					>
						{t("Live")}
					</button>
				</div>
				{visible && process ? (
					<div className="process-statusbar">
						<output className={`process-state is-${process.state}`}>
							<span aria-hidden="true" />
							{t(
								process.state === "awaiting_approval"
									? "Waiting for permission approval"
									: process.state === "running"
										? "Command running"
										: process.state === "completed"
											? "Command completed"
											: process.state === "unavailable"
												? "Command history unavailable"
												: process.state === "interrupted"
													? "Command interrupted"
													: "Command stopped with an error",
							)}
						</output>
					</div>
				) : null}
			</footer>
		</section>
	);
}

const ProcessOutput = memo(function ProcessOutput({
	process,
	theme,
}: {
	readonly process: SessionProcessView;
	readonly theme: "dark" | "light";
}) {
	const { t } = useTranslation();
	const hostRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const renderedOutput = useRef("");
	const renderedProcessId = useRef<string | undefined>(undefined);
	const themeRef = useRef(theme);
	themeRef.current = theme;

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
		renderedProcessId.current = undefined;
		let frame = 0;
		const fitTerminal = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (host.clientWidth && host.clientHeight) addon.fit();
			});
		};
		const observer = new ResizeObserver(fitTerminal);
		observer.observe(host);
		fitTerminal();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			terminalRef.current = null;
			terminal.dispose();
		};
	}, []);

	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;
		const previous = renderedOutput.current;
		// bash updates contain the cumulative bounded tail, not output deltas.
		if (renderedProcessId.current === process.processId && process.output.startsWith(previous)) {
			const delta = process.output.slice(previous.length);
			if (delta) terminal.write(delta);
		} else {
			// Queue the reset with the new output so pending writes from the previous
			// command finish before clearing its buffer, without rebuilding xterm.
			terminal.write(`\x1bc${process.output}`);
		}
		renderedProcessId.current = process.processId;
		renderedOutput.current = process.output;
	}, [process.processId, process.output]);

	useEffect(() => {
		if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_THEMES[theme];
	}, [theme]);

	return (
		<>
			{process.command && (
				<pre className="process-command">
					<span aria-hidden="true">$ </span>
					{process.command}
				</pre>
			)}
			{process.truncated && (
				<p className="process-notice">{t("Showing the latest output; earlier output was truncated.")}</p>
			)}
			{!process.output && process.state !== "unavailable" && (
				<p className="process-notice">
					{t(
						process.state === "awaiting_approval"
							? "The command has not started."
							: process.state === "running"
								? "Waiting for command output…"
								: "This command produced no output.",
					)}
				</p>
			)}
			<section aria-label={t("Command output")} className="process-output terminal-host" ref={hostRef} />
		</>
	);
});
