// Minimal OOXML style reader for the spreadsheet preview. SheetJS exposes solid
// fills on `cell.s`, but fonts, borders and alignment are only present in
// `xl/styles.xml`, so the preview reads that part itself. Parsing is
// namespace-tolerant and regex based: the workbook is untrusted input and the
// goal is a display model, not a full OOXML implementation.

export interface SpreadsheetFont {
	readonly bold?: boolean;
	readonly italic?: boolean;
	/** Font size in points. */
	readonly size?: number;
	/** `#RRGGBB` text color. */
	readonly color?: string;
}

export type SpreadsheetHorizontalAlign = "left" | "center" | "right";
export type SpreadsheetVerticalAlign = "top" | "middle" | "bottom";

export interface SpreadsheetBorderSide {
	/** CSS border style name: solid, dashed, dotted or double. */
	readonly style: string;
	/** Border width in pixels. */
	readonly width: number;
	readonly color?: string;
}

export interface SpreadsheetBorders {
	readonly top?: SpreadsheetBorderSide;
	readonly right?: SpreadsheetBorderSide;
	readonly bottom?: SpreadsheetBorderSide;
	readonly left?: SpreadsheetBorderSide;
}

export interface SpreadsheetCellStyle {
	readonly font?: SpreadsheetFont;
	readonly fill?: string;
	readonly align?: SpreadsheetHorizontalAlign;
	readonly valign?: SpreadsheetVerticalAlign;
	readonly wrap?: boolean;
	readonly borders?: SpreadsheetBorders;
}

export interface SpreadsheetStyleTable {
	/** Composed styles indexed like `cellXfs`; a cell's `s` attribute indexes this. */
	readonly styles: readonly SpreadsheetCellStyle[];
}

const NAMESPACE = "(?:[A-Za-z][A-Za-z0-9._-]*:)?";

function attribute(source: string, name: string): string | undefined {
	const pattern = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
	return pattern.exec(source)?.[1];
}

interface ElementFragment {
	readonly attributes: string;
	readonly body: string;
}

/**
 * Collects elements in document order. Both `<name .../>` and
 * `<name ...>...</name>` are supported so self-closing defaults such as
 * `<border/>` keep the same index as the `borderId` references.
 */
function elementFragments(xml: string, name: string): ElementFragment[] {
	const pattern = new RegExp(`<${NAMESPACE}${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${NAMESPACE}${name}>)`, "g");
	const fragments: ElementFragment[] = [];
	for (const match of xml.matchAll(pattern)) {
		fragments.push({ attributes: match[1] ?? "", body: match[2] ?? "" });
	}
	return fragments;
}

/** Normalizes `rgb="#AARRGGBB"` / `"FFRRGGBB"` into `#RRGGBB`. */
export function normalizeColor(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const hex = value.replace(/^#/, "");
	if (hex.length === 6) return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : undefined;
	if (hex.length === 8) {
		const rgb = hex.slice(2);
		return /^[0-9a-fA-F]{6}$/.test(rgb) ? `#${rgb.toUpperCase()}` : undefined;
	}
	return undefined;
}

function colorFrom(fragment: string): string | undefined {
	const rgb = attribute(fragment, "rgb");
	return normalizeColor(rgb);
}

function parseFonts(stylesXml: string): readonly SpreadsheetFont[] {
	const section = elementFragments(stylesXml, "fonts")[0];
	if (!section) return [];
	return elementFragments(section.body, "font").map(({ body: font }) => {
		const bold = new RegExp(`<${NAMESPACE}b\\b`).test(font);
		const italic = new RegExp(`<${NAMESPACE}i\\b`).test(font);
		const sizeMatch = new RegExp(`<${NAMESPACE}sz\\b[^>]*val="([0-9.]+)"`).exec(font);
		const colorMatch = new RegExp(`<${NAMESPACE}color\\b[^>]*?rgb="([0-9A-Fa-f]{6,8})"`).exec(font);
		return {
			...(bold ? { bold: true } : {}),
			...(italic ? { italic: true } : {}),
			...(sizeMatch?.[1] ? { size: Number.parseFloat(sizeMatch[1]) } : {}),
			...(colorMatch?.[1] ? { color: normalizeColor(colorMatch[1]) } : {}),
		};
	});
}

function parseFills(stylesXml: string): readonly (string | undefined)[] {
	const section = elementFragments(stylesXml, "fills")[0];
	if (!section) return [];
	return elementFragments(section.body, "fill").map(({ body: fill }) => {
		const patternMatch = new RegExp(`<${NAMESPACE}patternFill\\b[^>]*patternType="([^"]*)"`).exec(fill);
		if (patternMatch?.[1] !== "solid") return undefined;
		const foreground = new RegExp(`<${NAMESPACE}fgColor\\b[^>]*rgb="([0-9A-Fa-f]{6,8})"`).exec(fill);
		return foreground?.[1] ? normalizeColor(foreground[1]) : undefined;
	});
}

const BORDER_STYLES: Record<string, { style: string; width: number }> = {
	thin: { style: "solid", width: 1 },
	hair: { style: "solid", width: 1 },
	dotted: { style: "dotted", width: 1 },
	dashed: { style: "dashed", width: 1 },
	dashDot: { style: "dashed", width: 1 },
	dashDotDot: { style: "dashed", width: 1 },
	medium: { style: "solid", width: 2 },
	mediumDashed: { style: "dashed", width: 2 },
	mediumDashDot: { style: "dashed", width: 2 },
	mediumDashDotDot: { style: "dashed", width: 2 },
	slantDashDot: { style: "dashed", width: 2 },
	thick: { style: "solid", width: 3 },
	double: { style: "double", width: 3 },
};

function parseBorderSide(fragment: string): SpreadsheetBorderSide | undefined {
	const known = BORDER_STYLES[fragment];
	if (!known) return undefined;
	return known;
}

function borderSide(fragment: string, side: string): SpreadsheetBorderSide | undefined {
	const element = elementFragments(fragment, side)[0];
	if (!element) return undefined;
	const style = attribute(element.attributes, "style");
	if (!style || style === "none") return undefined;
	const mapped = parseBorderSide(style);
	if (!mapped) return undefined;
	const color = colorFrom(element.body);
	return { ...mapped, ...(color ? { color } : {}) };
}

function parseBorders(stylesXml: string): readonly (SpreadsheetBorders | undefined)[] {
	const section = elementFragments(stylesXml, "borders")[0];
	if (!section) return [];
	return elementFragments(section.body, "border").map(({ body: border }) => {
		const top = borderSide(border, "top");
		const right = borderSide(border, "right");
		const bottom = borderSide(border, "bottom");
		const left = borderSide(border, "left");
		if (!top && !right && !bottom && !left) return undefined;
		return {
			...(top ? { top } : {}),
			...(right ? { right } : {}),
			...(bottom ? { bottom } : {}),
			...(left ? { left } : {}),
		};
	});
}

function horizontalAlignment(value: string | undefined): SpreadsheetHorizontalAlign | undefined {
	if (value === "center" || value === "centerContinuous") return "center";
	if (value === "right") return "right";
	if (value === "left" || value === "justify" || value === "fill") return "left";
	return undefined;
}

function verticalAlignment(value: string | undefined): SpreadsheetVerticalAlign | undefined {
	if (value === "center") return "middle";
	if (value === "top") return "top";
	if (value === "bottom" || value === "justify") return "bottom";
	return undefined;
}

export function parseStylesXml(stylesXml: string): SpreadsheetStyleTable {
	const fonts = parseFonts(stylesXml);
	const fills = parseFills(stylesXml);
	const borders = parseBorders(stylesXml);
	const section = elementFragments(stylesXml, "cellXfs")[0];
	if (!section) return { styles: [] };
	const styles = elementFragments(section.body, "xf").map(({ attributes: xf, body }) => {
		const fontId = Number.parseInt(attribute(xf, "fontId") ?? "", 10);
		const fillId = Number.parseInt(attribute(xf, "fillId") ?? "", 10);
		const borderId = Number.parseInt(attribute(xf, "borderId") ?? "", 10);
		const applyFont = attribute(xf, "applyFont");
		const applyBorder = attribute(xf, "applyBorder");
		const alignment = new RegExp(`<${NAMESPACE}alignment\\b([^>]*)>`).exec(body)?.[1] ?? "";
		const align = horizontalAlignment(attribute(alignment, "horizontal"));
		const valign = verticalAlignment(attribute(alignment, "vertical"));
		const wrapText = attribute(alignment, "wrapText");
		// fontId/borderId 0 mean "the base font/border" unless the xf applies it.
		const font = Number.isFinite(fontId) && (fontId > 0 || applyFont === "1") ? fonts[fontId] : undefined;
		const fill = Number.isFinite(fillId) && fillId > 0 ? fills[fillId] : undefined;
		const border = Number.isFinite(borderId) && (borderId > 0 || applyBorder === "1") ? borders[borderId] : undefined;
		return {
			...(font && Object.keys(font).length > 0 ? { font } : {}),
			...(fill ? { fill } : {}),
			...(border ? { borders: border } : {}),
			...(align ? { align } : {}),
			...(valign ? { valign } : {}),
			...(wrapText === "1" || wrapText === "true" ? { wrap: true } : {}),
		} satisfies SpreadsheetCellStyle;
	});
	return { styles };
}

/** Maps cell addresses (`r:c`, at worksheet coordinates) to their style index. */
export function parseCellStyleIndexes(sheetXml: string): Map<string, number> {
	const indexes = new Map<string, number>();
	const cellPattern = new RegExp(`<${NAMESPACE}c\\b([^>]*?)/?>`, "g");
	for (const match of sheetXml.matchAll(cellPattern)) {
		const attributes = match[1] ?? "";
		const reference = attribute(attributes, "r");
		const styleId = attribute(attributes, "s");
		if (!reference || !styleId) continue;
		const decoded = decodeCellReference(reference);
		if (decoded) indexes.set(`${decoded.row}:${decoded.column}`, Number.parseInt(styleId, 10));
	}
	return indexes;
}

function decodeCellReference(reference: string): { row: number; column: number } | undefined {
	const match = /^([A-Za-z]{1,3})([0-9]{1,7})$/.exec(reference);
	if (!match?.[1] || !match[2]) return undefined;
	let column = 0;
	for (const character of match[1].toUpperCase()) column = column * 26 + (character.charCodeAt(0) - 64);
	return { row: Number.parseInt(match[2], 10) - 1, column: column - 1 };
}

/** Resolves a style index against the table, tolerating out-of-range values. */
export function styleAt(table: SpreadsheetStyleTable, index: number | undefined): SpreadsheetCellStyle | undefined {
	if (index === undefined || !Number.isFinite(index)) return undefined;
	return table.styles[index];
}
