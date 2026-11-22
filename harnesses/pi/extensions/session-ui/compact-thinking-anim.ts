import type { Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, getTerminalColorMode, mixColors, parseColor } from "@earendil-works/pi-tui";

type ShimmerTheme = Pick<Theme, "appearance" | "getColorMode" | "italic">;

// Radius-inspired colors, with deeper shades to stay readable on light backgrounds.
const PALETTES = {
	dark: ["#4d9abf", "#83ccd2", "#f1be57", "#f09082"].map(parseColor),
	light: ["#19658d", "#21767e", "#875600", "#a23e58"].map(parseColor),
};
const CHARS_PER_COLOR = 3;
const CHARS_PER_SECOND = 10;

/** Stream a repeating, smoothly blended color gradient from left to right. */
export function renderShimmerText(text: string, elapsedMs: number, theme?: ShimmerTheme): string {
	if (!text) return "";
	const palette = PALETTES[theme?.appearance ?? "dark"];
	const mode = theme?.getColorMode() ?? getTerminalColorMode();
	const cycle = palette.length * CHARS_PER_COLOR;
	const offset = ((elapsedMs / 1000) * CHARS_PER_SECOND) % cycle;
	let body = "";
	let i = 0;
	for (const char of text) {
		const position = ((i++ - offset) % cycle + cycle) % cycle;
		const band = Math.floor(position / CHARS_PER_COLOR);
		const t = position / CHARS_PER_COLOR - band;
		const color = mixColors(palette[band]!, palette[(band + 1) % palette.length]!, t * t * (3 - 2 * t), "srgb");
		body += foregroundAnsi(color, mode) + char;
	}
	body += "\x1b[39m";
	return theme ? theme.italic(body) : body;
}
