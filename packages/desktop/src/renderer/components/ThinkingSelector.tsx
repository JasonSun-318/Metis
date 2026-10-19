import type { SessionSnapshot } from "@metis/app-protocol";
import { CaretDown, Question } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMenuDismiss } from "../hooks/use-menu-dismiss.ts";

interface ThinkingSelectorProps {
	readonly actualThinkingLevel: SessionSnapshot["actualThinkingLevel"];
	readonly available: Readonly<SessionSnapshot["availableThinkingSelections"]>;
	readonly commandRequest?: { readonly id: number; readonly open: boolean };
	readonly disabled: boolean;
	readonly onChange: (selection: SessionSnapshot["thinkingSelection"]) => void;
	readonly reducedMotion: boolean;
	readonly value: SessionSnapshot["thinkingSelection"];
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const smoothstep = (minimum: number, maximum: number, value: number) => {
	const progress = clamp((value - minimum) / (maximum - minimum), 0, 1);
	return progress * progress * (3 - 2 * progress);
};
const hash = (x: number, y: number, seed = 0) => Math.abs(Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453) % 1;

export function highestThinkingSelection(
	available: Readonly<SessionSnapshot["availableThinkingSelections"]>,
): SessionSnapshot["thinkingSelection"] | undefined {
	return available.filter((selection) => selection !== "off").at(-1);
}

function HighestEffortField({ reducedMotion }: { readonly reducedMotion: boolean }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !context) return;
		let frame = 0;
		let lastDrawnAt = 0;
		const startedAt = performance.now();

		const draw = (time: number) => {
			const rect = canvas.getBoundingClientRect();
			const ratio = Math.min(window.devicePixelRatio || 1, 2);
			const width = Math.max(1, rect.width);
			const height = Math.max(1, rect.height);
			const pixelWidth = Math.round(width * ratio);
			const pixelHeight = Math.round(height * ratio);
			if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
				canvas.width = pixelWidth;
				canvas.height = pixelHeight;
			}
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, height);
			const elapsed = reducedMotion ? 4000 : Math.max(0, time - startedAt);
			const cell = width < 190 ? 3 : 4;
			const gap = 0.8;
			const columns = Math.ceil(width / cell);
			const rows = Math.ceil(height / cell);
			const reveal = reducedMotion ? 1 : smoothstep(0, 1, elapsed / 1000);
			const frontier = 1 - reveal;
			const flow = reducedMotion ? 1 : elapsed / 4000;

			context.save();
			context.beginPath();
			context.roundRect(0, 0, width, height, 10);
			context.clip();

			for (let row = 0; row < rows; row += 1) {
				for (let column = 0; column < columns; column += 1) {
					const x = column * cell;
					const y = row * cell;
					const normalizedX = (x + cell / 2) / width;
					const revealAlpha = smoothstep(frontier - 0.1, frontier + 0.07, normalizedX);
					if (revealAlpha <= 0.002) continue;

					const base = hash(column, row);
					const phase = hash(column, row, 31.17);
					const tempo = 500 + hash(column, row, 7.13) * 1500;
					const cycleProgress = ((elapsed + phase * tempo) % tempo) / tempo;
					const pulseCenter = 0.2 + hash(column, row, Math.floor(elapsed / tempo) * 13.11) * 0.55;
					const pulseDistance = (cycleProgress - pulseCenter) / (0.09 + hash(column, row, 5.37) * 0.08);
					const pulse = Math.exp(-pulseDistance * pulseDistance * 1.45);
					const wave = (0.5 + 0.5 * Math.cos((normalizedX + flow + row * 0.06 + base * 0.02) * Math.PI * 2)) ** 5;
					const brightness = Math.max(pulse * (0.42 + wave * 0.58), wave * (0.38 + base * 0.28));
					const revealGlow =
						reveal < 0.995
							? Math.exp(-((normalizedX - frontier) ** 2) / 0.012) * (1 - smoothstep(0.7, 1, reveal))
							: 0;
					const highlight = clamp(Math.max(brightness, revealGlow * (0.4 + base * 0.4)), 0, 1);
					const purple = smoothstep(0.1, 0.88, normalizedX);
					const red = mix(78, 94 + base * 28, purple);
					const green = mix(78, 70 + phase * 28, purple);
					const blue = mix(76, 114 + base * 34, purple);
					const peak = highlight > 0.68;
					context.fillStyle = `rgb(${Math.round(mix(red, peak ? 226 : 181, highlight))} ${Math.round(mix(green, peak ? 214 : 163, highlight))} ${Math.round(mix(blue, peak ? 240 : 211, highlight))})`;
					context.globalAlpha = revealAlpha * smoothstep(0.04, 0.38, normalizedX) * (0.7 + base * 0.2);
					context.fillRect(x + gap / 2, y + gap / 2, cell - gap, cell - gap);
				}
			}

			context.restore();
			context.globalAlpha = 1;
		};

		const animate = (time: number) => {
			if (time - lastDrawnAt >= 33) {
				lastDrawnAt = time;
				draw(time);
			}
			frame = requestAnimationFrame(animate);
		};
		if (reducedMotion) draw(startedAt + 4000);
		else frame = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(frame);
	}, [reducedMotion]);

	return <canvas tabIndex={-1} aria-hidden="true" className="effort-highest-field" ref={canvasRef} />;
}

export function ThinkingSelector({
	actualThinkingLevel,
	available,
	commandRequest,
	disabled,
	onChange,
	reducedMotion,
	value,
}: ThinkingSelectorProps) {
	const { t } = useTranslation();
	const currentIndex = Math.max(0, available.indexOf(value));
	const [open, setOpen] = useState(false);
	const [previewIndex, setPreviewIndex] = useState(currentIndex);
	const [previewDirection, setPreviewDirection] = useState<"backward" | "forward">("forward");
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const lastCommandRequest = useRef(commandRequest?.id);
	const previewRef = useRef(currentIndex);
	const draggingRef = useRef(false);
	const samplesRef = useRef<Array<{ readonly time: number; readonly value: number }>>([]);
	const springFrameRef = useRef(0);
	const maximumIndex = Math.max(0, available.length - 1);
	const selectionLabel = (selection: string) =>
		t(selection === "xhigh" ? "XHigh" : `${selection.charAt(0).toUpperCase()}${selection.slice(1)}`);
	const label = selectionLabel(value);
	const previewSelection = available[Math.round(previewIndex)] ?? value;
	const previewLabel = selectionLabel(previewSelection);
	const fill = maximumIndex === 0 ? 0 : (previewIndex / maximumIndex) * 100;
	const highest = highestThinkingSelection(available);
	const highestActive = highest !== undefined && previewSelection === highest;
	const triggerHighestActive = highest !== undefined && value === highest;
	const commit = useCallback(
		(index: number) => {
			const selection = available[index];
			if (selection && selection !== value) onChange(selection);
		},
		[available, onChange, value],
	);

	const close = useCallback(
		(restoreFocus = false, commitPending = true) => {
			const pendingIndex =
				commitPending && (draggingRef.current || springFrameRef.current !== 0)
					? Math.round(previewRef.current)
					: undefined;
			cancelAnimationFrame(springFrameRef.current);
			springFrameRef.current = 0;
			draggingRef.current = false;
			previewRef.current = currentIndex;
			setPreviewIndex(currentIndex);
			setOpen(false);
			if (pendingIndex !== undefined) commit(pendingIndex);
			if (restoreFocus) triggerRef.current?.focus();
		},
		[commit, currentIndex],
	);

	useEffect(() => {
		if (disabled) close(false, false);
	}, [close, disabled]);

	useEffect(() => {
		if (commandRequest === undefined || commandRequest.id === lastCommandRequest.current) return;
		lastCommandRequest.current = commandRequest.id;
		if (commandRequest.open && !disabled) setOpen(true);
		else close(false, false);
	}, [close, commandRequest, disabled]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(value): Selection or available levels changing cancels stale preview animation even at the same index.
	// biome-ignore lint/correctness/useExhaustiveDependencies(available): Selection or available levels changing cancels stale preview animation even at the same index.
	useEffect(() => {
		if (draggingRef.current) return;
		cancelAnimationFrame(springFrameRef.current);
		springFrameRef.current = 0;
		previewRef.current = currentIndex;
		setPreviewIndex(currentIndex);
	}, [available, currentIndex, value]);

	useEffect(() => () => cancelAnimationFrame(springFrameRef.current), []);

	useMenuDismiss(open, rootRef, close);

	const updatePreview = (nextValue: number) => {
		const next = clamp(nextValue, 0, maximumIndex);
		const previousStop = Math.round(previewRef.current);
		const nextStop = Math.round(next);
		if (nextStop !== previousStop) setPreviewDirection(nextStop > previousStop ? "forward" : "backward");
		previewRef.current = next;
		setPreviewIndex(next);
	};

	const snapToNearest = () => {
		const target = Math.round(previewRef.current);
		const samples = samplesRef.current;
		let velocity = 0;
		if (samples.length > 1) {
			const first = samples[0];
			const last = samples.at(-1)!;
			velocity = clamp((last.value - first.value) / Math.max((last.time - first.time) / 1000, 0.016), -8, 8);
		}
		if (Math.abs(target - previewRef.current) < 0.001 || reducedMotion) {
			updatePreview(target);
			commit(target);
			return;
		}
		let position = previewRef.current;
		let previousTime = performance.now();
		const animate = (time: number) => {
			const delta = Math.min((time - previousTime) / 1000, 0.032);
			previousTime = time;
			velocity += (-920 * (position - target) - 40 * velocity) * delta;
			position = clamp(position + velocity * delta, 0, maximumIndex);
			updatePreview(position);
			if (Math.abs(position - target) < 0.001 && Math.abs(velocity) < 0.01) {
				springFrameRef.current = 0;
				updatePreview(target);
				commit(target);
				return;
			}
			springFrameRef.current = requestAnimationFrame(animate);
		};
		cancelAnimationFrame(springFrameRef.current);
		springFrameRef.current = requestAnimationFrame(animate);
	};

	const applyMagnet = (rawValue: number) => {
		const nearest = Math.round(rawValue);
		const delta = rawValue - nearest;
		const distance = Math.abs(delta);
		if (distance < 0.001 || distance > 0.5) return rawValue;
		const pull = 1 - distance / 0.5;
		return rawValue - delta * (0.68 + 0.42 * pull) * pull * pull;
	};

	return (
		<div
			className={`composer-selector thinking-control${(open ? highestActive : triggerHighestActive) ? " thinking-highest" : ""}`}
			ref={rootRef}
		>
			<button
				aria-describedby="thinking-selection-detail"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={t("Select effort, current {{label}}", { label })}
				className="composer-selector-trigger"
				disabled={disabled}
				onClick={() => (open ? close() : setOpen(true))}
				ref={triggerRef}
				type="button"
			>
				<span>{open ? previewLabel : label}</span>
				<CaretDown aria-hidden="true" size={12} />
			</button>
			{open && (
				<div aria-label={t("Effort")} className="effort-popover" role="dialog">
					<div className="effort-title">
						<span>
							{t("Effort")}{" "}
							<strong className={highestActive ? "is-highest" : undefined}>
								<span className={`effort-label is-${previewDirection}`} key={previewSelection}>
									{previewLabel}
								</span>
							</strong>
						</span>
						<span title={t("Higher effort can improve difficult answers but may take longer.")}>
							<Question aria-hidden="true" size={16} />
						</span>
					</div>
					<div className="effort-axis">
						<span>{t("Faster")}</span>
						<span>{t("Smarter")}</span>
					</div>
					<div className={`effort-slider-shell${highestActive ? " is-highest" : ""}`}>
						<span
							aria-hidden="true"
							className="effort-slider-fill"
							style={{ width: `calc(8px + (100% - 16px) * ${fill / 100})` }}
						/>
						{highestActive && <HighestEffortField reducedMotion={reducedMotion} />}
						<div aria-hidden="true" className="effort-ticks">
							{available.map((selection) => (
								<span className={selection === highest ? "is-highest" : undefined} key={selection} />
							))}
						</div>
						<input
							aria-label={t("Effort")}
							aria-valuetext={previewLabel}
							disabled={disabled || available.length < 2}
							max={maximumIndex}
							min={0}
							onChange={(event) => {
								const rawValue = Number(event.currentTarget.value);
								const nextValue = draggingRef.current ? applyMagnet(rawValue) : rawValue;
								updatePreview(nextValue);
								if (draggingRef.current) {
									const now = performance.now();
									samplesRef.current = [...samplesRef.current, { time: now, value: nextValue }]
										.filter((sample) => now - sample.time < 90)
										.slice(-5);
								}
							}}
							onKeyDown={(event) => {
								const current = Math.round(previewRef.current);
								const targets: Partial<Record<string, number>> = {
									ArrowDown: current - 1,
									ArrowLeft: current - 1,
									ArrowRight: current + 1,
									ArrowUp: current + 1,
									End: maximumIndex,
									Home: 0,
									PageDown: current - 1,
									PageUp: current + 1,
								};
								const target = targets[event.key];
								if (target === undefined) return;
								event.preventDefault();
								cancelAnimationFrame(springFrameRef.current);
								springFrameRef.current = 0;
								const next = clamp(target, 0, maximumIndex);
								updatePreview(next);
								commit(next);
							}}
							onPointerCancel={() => {
								draggingRef.current = false;
								snapToNearest();
							}}
							onPointerDown={(event) => {
								event.currentTarget.setPointerCapture?.(event.pointerId);
								cancelAnimationFrame(springFrameRef.current);
								springFrameRef.current = 0;
								draggingRef.current = true;
								samplesRef.current = [{ time: performance.now(), value: previewRef.current }];
							}}
							onPointerUp={() => {
								if (!draggingRef.current) return;
								draggingRef.current = false;
								snapToNearest();
							}}
							step={0.001}
							type="range"
							value={previewIndex}
						/>
					</div>
				</div>
			)}
			<span className="sr-only" id="thinking-selection-detail">
				{triggerHighestActive
					? t("Uses the highest supported reasoning level ({{level}}).", {
							level: selectionLabel(actualThinkingLevel),
						})
					: t("Provider thinking level {{level}}.", { level: selectionLabel(actualThinkingLevel) })}
			</span>
		</div>
	);
}
