const SYMBOLS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const TILE_WIDTH = 10;
const TILE_HEIGHT = 16;
const PULSE_DURATION = 1_900;
const PULSE_SPEED = 580;
const PULSE_WIDTH = 26;

interface Pulse {
	readonly x: number;
	readonly y: number;
	readonly started: number;
}

interface Tile {
	readonly x: number;
	readonly y: number;
	readonly seed: number;
}

interface Glow {
	readonly x: number;
	readonly y: number;
	readonly radiusX: number;
	readonly radiusY: number;
}

function driftingGlows(seconds: number, width: number, height: number): readonly Glow[] {
	return [
		{
			x: width * (0.25 + 0.19 * Math.sin(seconds / 7)),
			y: height * (0.27 + 0.18 * Math.cos(seconds / 9)),
			radiusX: width * 0.27,
			radiusY: height * 0.16,
		},
		{
			x: width * (0.73 + 0.12 * Math.cos(seconds / 6)),
			y: height * (0.54 + 0.23 * Math.sin(seconds / 10)),
			radiusX: width * 0.23,
			radiusY: height * 0.24,
		},
		{
			x: width * (0.38 + 0.24 * Math.cos(seconds / 11)),
			y: height * (0.76 + 0.12 * Math.sin(seconds / 8)),
			radiusX: width * 0.3,
			radiusY: height * 0.13,
		},
	];
}

function makeGlyphAtlas(color: string, density: number): HTMLCanvasElement {
	const atlas = document.createElement("canvas");
	atlas.width = Math.ceil(SYMBOLS.length * TILE_WIDTH * density);
	atlas.height = Math.ceil(TILE_HEIGHT * density);
	const context = atlas.getContext("2d");
	if (!context) throw new Error("A canvas context is required to draw the task background");
	context.scale(density, density);
	context.font = "11px monospace";
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.fillStyle = color;
	for (let index = 0; index < SYMBOLS.length; index++) {
		context.fillText(SYMBOLS.charAt(index), (index + 0.5) * TILE_WIDTH, TILE_HEIGHT / 2);
	}
	return atlas;
}

export class RippleField {
	private readonly canvas: HTMLCanvasElement;
	private readonly context: CanvasRenderingContext2D;
	private width = 0;
	private height = 0;
	private density = 1;
	private tiles: Tile[] = [];
	private pulses: Pulse[] = [];
	private palette: { theme: string; idle: HTMLCanvasElement; active: HTMLCanvasElement } | undefined;

	constructor(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
		this.canvas = canvas;
		this.context = context;
	}

	resize(width: number, height: number, density: number): void {
		if (width === this.width && height === this.height && density === this.density) return;
		if (density !== this.density) this.palette = undefined;
		this.width = width;
		this.height = height;
		this.density = density;
		this.canvas.width = Math.round(width * density);
		this.canvas.height = Math.round(height * density);

		const tiles: Tile[] = [];
		let state = 0x3a7e61d2;
		for (let x = 0; x < width; x += TILE_WIDTH) {
			for (let y = 0; y < height; y += TILE_HEIGHT) {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				tiles.push({ x, y, seed: (state >>> 0) / 2 ** 32 });
			}
		}
		this.tiles = tiles;
	}

	addRipple(x: number, y: number, time: number): void {
		this.pulses.push({ x, y, started: time });
	}

	clearRipples(): void {
		this.pulses = [];
	}

	paint(now: number, theme: string): void {
		const { density, width, height } = this;
		const context = this.context;
		if (width === 0 || height === 0) return;
		if (this.palette?.theme !== theme) {
			const style = getComputedStyle(this.canvas);
			this.palette = {
				theme,
				idle: makeGlyphAtlas(style.getPropertyValue("--home-ripple-ink").trim(), density),
				active: makeGlyphAtlas(style.getPropertyValue("--home-ripple-accent").trim(), density),
			};
		}

		const glows = driftingGlows(now / 1000, width, height);
		this.pulses = this.pulses.filter(({ started }) => now - started < PULSE_DURATION);
		const fronts = this.pulses.map(({ x, y, started }) => {
			const age = now - started;
			return {
				x: x * width,
				y: y * height,
				radius: (age / 1000) * PULSE_SPEED,
				strength: 0.68 * (1 - age / PULSE_DURATION) ** 1.3,
			};
		});
		const { idle, active } = this.palette;
		context.setTransform(density, 0, 0, density, 0, 0);
		context.clearRect(0, 0, width, height);
		for (const { x, y, seed } of this.tiles) {
			const centerX = x + TILE_WIDTH / 2;
			const centerY = y + TILE_HEIGHT / 2;
			let luminance = 0;
			for (const glow of glows) {
				const distance = ((centerX - glow.x) / glow.radiusX) ** 2 + ((centerY - glow.y) / glow.radiusY) ** 2;
				const falloff = Math.max(0, 1 - distance);
				luminance = Math.max(luminance, falloff * falloff);
			}
			let crest = 0;
			for (const front of fronts) {
				const distance = Math.hypot(centerX - front.x, centerY - front.y);
				const envelope = Math.max(0, 1 - Math.abs(distance - front.radius) / PULSE_WIDTH);
				crest = Math.max(crest, front.strength * envelope ** 2);
			}

			const cadence = 440 + seed * 510;
			const step = Math.floor((now + y * 3 + seed * 1_000) / cadence);
			const index = (Math.floor(seed * SYMBOLS.length) + step * 11) % SYMBOLS.length;
			context.globalAlpha = 0.034 + seed * 0.02 + Math.max(luminance * (0.1 + seed * 0.12), crest);
			context.drawImage(
				crest > 0.09 ? active : idle,
				index * TILE_WIDTH * density,
				0,
				TILE_WIDTH * density,
				TILE_HEIGHT * density,
				x,
				y,
				TILE_WIDTH,
				TILE_HEIGHT,
			);
		}
		context.globalAlpha = 1;
	}
}
