// The character field and wave geometry match the DSH 0.10.3 canvas.
const GLYPHS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CELL_WIDTH = 8;
const CELL_HEIGHT = 15;
const SAMPLE_STEP = 18;
const WAVE_LIFETIME_MS = 2800;
const WAVE_FRONT_COUNT = 3;
const WAVE_FRONT_SPACING = 0.2;
const TAU = Math.PI * 2;
const HEART = [0.808, 0.237, -0.047, -0.187, -0.048, -0.046, -0.005, -0.035];
const HEART_WIDTH = 1.18;

interface Ripple {
	readonly x: number;
	readonly y: number;
	readonly time: number;
}

type Rgb = readonly [number, number, number];

interface Cell {
	readonly x: number;
	readonly y: number;
	readonly sample: number;
	readonly fx: number;
	readonly fy: number;
	readonly grain: number;
	readonly edge: number;
	readonly pixel: number;
	tick: number;
}

interface RippleSurface {
	readonly width: number;
	readonly height: number;
	readonly density: number;
	readonly columns: number;
	readonly rows: number;
	readonly cells: Cell[];
	readonly ambient: Float32Array;
	readonly clicked: Float32Array;
	readonly atlas: CanvasRenderingContext2D;
	readonly glyphs: CanvasRenderingContext2D;
	readonly mask: CanvasRenderingContext2D;
	readonly pixels: ImageData;
}

function mix(from: number, to: number, weight: number) {
	return from + (to - from) * weight;
}

function ease(from: number, to: number, value: number) {
	const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
	return t * t * (3 - 2 * t);
}

function hash(x: number, y: number) {
	const first = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
	const second = Math.imul(first ^ (first >>> 13), 1274126177);
	return ((second ^ (second >>> 16)) >>> 0) / 4294967296;
}

function noise(x: number, y: number) {
	const left = Math.floor(x);
	const top = Math.floor(y);
	const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
	const fx = fade(x - left);
	const fy = fade(y - top);
	return (
		mix(mix(hash(left, top), hash(left + 1, top), fx), mix(hash(left, top + 1), hash(left + 1, top + 1), fx), fy) *
			2 -
		1
	);
}

function waveScale(width: number, height: number) {
	return Math.max(320, Math.min(width, height, 900));
}

// Sample the waves on a coarser grid than the characters; each cell interpolates its four neighbors.
function paintAmbientSamples(surface: RippleSurface, now: number, reveal: number, scale: number) {
	const seconds = now / 1000;
	const t = seconds * 0.45;
	const breathing = 0.9 + 0.1 * Math.sin((seconds * TAU) / 12.8);
	const offsetX = hash(0, 17) * 13;
	const offsetY = hash(0, 43) * 13;
	const phase = hash(0, 71) * TAU;
	const { rows, columns, ambient } = surface;
	for (let row = 0; row < rows; row++) {
		const y = (row * SAMPLE_STEP) / scale;
		for (let col = 0; col < columns; col++) {
			const x = (col * SAMPLE_STEP) / scale;
			const u =
				x +
				0.27 * noise(x * 2 + offsetX + t * 0.08, y * 2 - t * 0.11) +
				0.065 * Math.sin(y * 5.1 + t * 0.43 + phase);
			const v =
				y +
				0.24 * noise(x * 2.3 + 23 - t * 0.09, y * 2 + offsetY + t * 0.07) +
				0.055 * Math.sin(x * 4.7 - t * 0.37);
			const a = Math.sin(Math.hypot((u - 0.17) * 0.84, v - 0.62) * 9.6 - t * 2.05 + phase);
			const b = Math.sin(Math.hypot(u - 1.1, (v + 0.18) * 0.78) * 8.2 - t * 1.53 - phase * 0.7);
			const cross = Math.sin(u * 3.5 + v * 2.6 + t * 0.71 + phase);
			const crests = ease(0.66, 0.98, a * 0.65 + b * 0.43 + cross * 0.2);
			const gaps = ease(0.12, 0.42, noise(u * 8.5 + offsetX - t * 0.12, v * 8.5 + offsetY + t * 0.08));
			ambient[row * columns + col] = breathing * crests * 0.5 * gaps * reveal;
		}
	}
}

function heartRadius(angle: number) {
	return HEART.reduce((radius, coefficient, index) => radius + coefficient * Math.cos(index * angle), 0);
}

function addWaveSamples(surface: RippleSurface, ripple: Ripple, age: number, scale: number) {
	const { width, height, rows, columns, clicked } = surface;
	const x = ripple.x * width;
	const y = ripple.y * height;
	const seed = ripple.x * 7 + ripple.y * 11 + ripple.time / 10000;
	const heart = hash(Math.floor(seed * 997), 31) < 0.5;
	const growth = ease(0, 0.1, age);
	const shape = heart ? growth : 0;
	const loose = growth * (heart ? 0.55 : 1);
	const radius = age * 1.25;
	const warped = growth * ease(0.05, 0.5, radius);
	const thickness = 0.028 + age * 0.035;
	const contact = (1 - ease(0.025, 0.12, age)) * 0.24;
	const fade = ease(0, 0.045, age) * (1 - ease(0.4, 1, age));
	const tilt = 0.08 * Math.sin(seed * 5.3);
	const frontMargin = radius * loose * 0.18 + thickness * 4;
	const warpMargin = warped * Math.SQRT2 * 0.07;
	const waveSpan = (WAVE_FRONT_COUNT - 1) * WAVE_FRONT_SPACING;
	const inner = contact > 0 ? 0 : Math.max(0, (radius - waveSpan - frontMargin) * mix(1, 0.52, shape) - warpMargin);
	const outer = Math.max(
		(radius + frontMargin) * mix(1, 1.17 * HEART_WIDTH, shape) + warpMargin,
		contact > 0 ? 0.4 : 0,
	);
	const reach = outer * scale;
	const left = Math.max(0, Math.ceil((x - reach) / SAMPLE_STEP));
	const right = Math.min(columns - 1, Math.floor((x + reach) / SAMPLE_STEP));
	const top = Math.max(0, Math.ceil((y - reach) / SAMPLE_STEP));
	const bottom = Math.min(rows - 1, Math.floor((y + reach) / SAMPLE_STEP));
	const widen = mix(1, HEART_WIDTH, shape);
	for (let row = top; row <= bottom; row++) {
		const dy = (row * SAMPLE_STEP - y) / scale;
		for (let col = left; col <= right; col++) {
			const dx = (col * SAMPLE_STEP - x) / scale;
			const squared = dx * dx + dy * dy;
			if (squared < inner * inner || squared > outer * outer) continue;
			const u = dx + warped * 0.07 * noise(dx * 3.2 + seed + age * 0.5, dy * 3.2 - age * 0.4);
			const v = dy + warped * 0.07 * noise(dx * 3.1 + 23 - age * 0.5, dy * 3.1 + seed);
			const angle = Math.atan2(v, u);
			const across = u / widen;
			const wobble =
				1 +
				loose * (0.1 * Math.sin(angle * 2 + seed * 7 + age * 2) + 0.05 * Math.sin(angle * 3 - seed * 5 - age * 3));
			const distance = (Math.hypot(across, v) / mix(1, heartRadius(Math.atan2(across, -v) + tilt), shape)) * wobble;
			let crests = 0;
			for (let index = 0; index < WAVE_FRONT_COUNT; index++) {
				const band = (distance - radius + index * WAVE_FRONT_SPACING) / thickness;
				if (Math.abs(band) <= 4) crests += Math.exp(-band * band) * (1 - index * 0.23);
			}
			const patches =
				crests > 0 ? 0.08 + 0.92 * ease(-0.3, 0.65, noise(u * 5 + seed + age * 0.3, v * 5 - age * 0.2)) : 0;
			const point = contact > 0 ? Math.exp(-(u * u + v * v) / 0.009) * contact : 0;
			const index = row * columns + col;
			clicked[index] = clicked[index]! + (crests * patches * 0.72 + point) * fade;
		}
	}
}

function sample(grid: Float32Array, columns: number, cell: Cell) {
	const { sample: i, fx, fy } = cell;
	return mix(mix(grid[i]!, grid[i + 1]!, fx), mix(grid[i + columns]!, grid[i + columns + 1]!, fx), fy);
}

function rgb(hex: string): Rgb {
	const value = Number.parseInt(hex.slice(1), 16);
	return [value >> 16, (value >> 8) & 255, value & 255];
}

function createLayer(document: Document, width: number, height: number) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas.getContext("2d");
}

function createSurface(canvas: HTMLCanvasElement, density: number): RippleSurface | undefined {
	const width = canvas.width / density;
	const height = canvas.height / density;
	if (width === 0 || height === 0) return;
	const columns = Math.ceil(width / SAMPLE_STEP) + 1;
	const rows = Math.ceil(height / SAMPLE_STEP) + 1;
	const maskWidth = Math.ceil(width / CELL_WIDTH);
	const document = canvas.ownerDocument;
	const mask = createLayer(document, maskWidth, Math.ceil(height / CELL_HEIGHT));
	const glyphs = createLayer(document, canvas.width, canvas.height);
	const atlas = createLayer(document, GLYPHS.length * CELL_WIDTH * density, CELL_HEIGHT * density);
	if (!mask || !glyphs || !atlas) return;
	glyphs.setTransform(density, 0, 0, density, 0, 0);
	atlas.setTransform(density, 0, 0, density, 0, 0);
	atlas.font = "12px monospace";
	atlas.textBaseline = "top";

	const cells: Cell[] = [];
	for (let y = CELL_HEIGHT; y < height; y += CELL_HEIGHT) {
		for (let x = CELL_WIDTH; x < width; x += CELL_WIDTH) {
			const edge = Math.min(ease(0, 55, x), ease(0, 55, width - x), ease(0, 16, y), ease(0, 100, height - y));
			const col = Math.floor(x / CELL_WIDTH);
			const row = Math.floor(y / CELL_HEIGHT);
			cells.push({
				x,
				y,
				edge,
				sample: Math.floor(y / SAMPLE_STEP) * columns + Math.floor(x / SAMPLE_STEP),
				fx: (x / SAMPLE_STEP) % 1,
				fy: (y / SAMPLE_STEP) % 1,
				grain: hash(col, row),
				pixel: (row * maskWidth + col) * 4,
				tick: -1,
			});
		}
	}
	return {
		width,
		height,
		density,
		columns,
		rows,
		cells,
		ambient: new Float32Array(columns * rows),
		clicked: new Float32Array(columns * rows),
		atlas,
		glyphs,
		mask,
		pixels: mask.createImageData(maskWidth, mask.canvas.height),
	};
}

export class RippleField {
	private readonly canvas: HTMLCanvasElement;
	private readonly context: CanvasRenderingContext2D;
	private surface: RippleSurface | undefined;
	private ripples: Ripple[] = [];
	private theme: string | undefined;
	private idle: Rgb = [0, 0, 0];
	private accent: Rgb = [0, 0, 0];

	constructor(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
		this.canvas = canvas;
		this.context = context;
	}

	resize(width: number, height: number, density: number) {
		const bitmapWidth = Math.round(width * density);
		const bitmapHeight = Math.round(height * density);
		if (this.surface?.density === density && this.canvas.width === bitmapWidth && this.canvas.height === bitmapHeight)
			return;
		this.canvas.width = bitmapWidth;
		this.canvas.height = bitmapHeight;
		this.surface = createSurface(this.canvas, density);
		this.theme = undefined;
	}

	addRipple(x: number, y: number, time: number) {
		this.ripples.push({ x, y, time });
	}

	clearRipples() {
		this.ripples = [];
	}

	paint(now: number, theme: string) {
		const surface = this.surface;
		if (!surface) return;
		const context = this.context;
		const { atlas, glyphs, mask, pixels, density, width, height, clicked, ambient, columns, cells } = surface;
		if (theme !== this.theme) {
			const style = getComputedStyle(this.canvas);
			const ink = style.getPropertyValue("--home-ripple-accent").trim();
			this.idle = rgb(style.getPropertyValue("--home-ripple-ink").trim());
			this.accent = rgb(ink);
			atlas.clearRect(0, 0, GLYPHS.length * CELL_WIDTH, CELL_HEIGHT);
			atlas.fillStyle = ink;
			for (let index = 0; index < GLYPHS.length; index++) atlas.fillText(GLYPHS[index]!, index * CELL_WIDTH, 0);
			glyphs.clearRect(0, 0, width, height);
			for (const cell of cells) cell.tick = -1;
			this.theme = theme;
		}

		const reveal = ease(0, 1.4, now / 1000);
		const scale = waveScale(width, height);
		paintAmbientSamples(surface, now, reveal, scale);
		clicked.fill(0);
		this.ripples = this.ripples.filter(({ time }) => now - time < WAVE_LIFETIME_MS);
		for (const ripple of this.ripples) {
			const age = (now - ripple.time) / WAVE_LIFETIME_MS;
			if (age >= 0) addWaveSamples(surface, ripple, age, scale);
		}

		// Colors and opacity change each frame, while a glyph only needs repainting when its own clock advances.
		for (const cell of cells) {
			const { x, y, grain, edge, pixel } = cell;
			const click = sample(clicked, columns, cell);
			const tint = ease(0.0005, 0.006, click);
			const light = sample(ambient, columns, cell) * (1 - tint) + click;
			const alpha = Math.min(0.72, (0.012 + grain * 0.013) * reveal + light * 1.65 * (0.45 + 0.55 * grain)) * edge;
			pixels.data[pixel] = mix(this.idle[0], this.accent[0], tint);
			pixels.data[pixel + 1] = mix(this.idle[1], this.accent[1], tint);
			pixels.data[pixel + 2] = mix(this.idle[2], this.accent[2], tint);
			pixels.data[pixel + 3] = alpha > 0.006 ? Math.round(alpha * 255) : 0;
			if (alpha <= 0.006) continue;
			const tick = Math.floor(now / (300 + grain * 400) + grain * 17);
			if (tick === cell.tick) continue;
			cell.tick = tick;
			const glyph = Math.floor(
				hash(Math.floor(x / CELL_WIDTH) + tick * 1013, Math.floor(y / CELL_HEIGHT)) * GLYPHS.length,
			);
			glyphs.clearRect(x, y, CELL_WIDTH, CELL_HEIGHT);
			glyphs.drawImage(
				atlas.canvas,
				glyph * CELL_WIDTH * density,
				0,
				CELL_WIDTH * density,
				CELL_HEIGHT * density,
				x,
				y,
				CELL_WIDTH,
				CELL_HEIGHT,
			);
		}

		context.setTransform(density, 0, 0, density, 0, 0);
		context.clearRect(0, 0, width, height);
		mask.putImageData(pixels, 0, 0);
		const smoothing = context.imageSmoothingEnabled;
		context.imageSmoothingEnabled = false;
		context.drawImage(mask.canvas, 0, 0, mask.canvas.width * CELL_WIDTH, mask.canvas.height * CELL_HEIGHT);
		context.imageSmoothingEnabled = smoothing;
		context.globalCompositeOperation = "destination-in";
		context.drawImage(glyphs.canvas, 0, 0, width, height);
		context.globalCompositeOperation = "source-over";
	}
}
