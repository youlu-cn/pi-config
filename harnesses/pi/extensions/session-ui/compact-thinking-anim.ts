import { ansi16ToRgb, ansi256ToRgb } from "./ansi-color.ts";

export type Rgb = readonly [number, number, number];

export interface ShimmerTheme {
	fg(color: string, text: string): string;
	italic?(text: string): string;
	getFgAnsi?(color: string): string;
}

const DEFAULT_CYCLE_MS = 1400;
const DEFAULT_SWEEP_MS = 1100;
const SHIMMER_SPREAD = 2.6;
const FALLBACK_BASE_RGB: Rgb = [142, 142, 152];
const FALLBACK_PEAK_RGB: Rgb = [235, 195, 130];

/** Cycle 1–3 dots, always pad to width 3 so the duration suffix does not jitter. */
export function animateDots(frame: number): string {
	return ".".repeat((frame % 3) + 1).padEnd(3, " ");
}

/** Parse truecolor, 256-color, or 16-color foreground ANSI SGR into RGB. */
export function parseForegroundRgbFromAnsi(ansi: string | undefined): Rgb | null {
	if (!ansi) return null;
	const trueColor = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
	if (trueColor) {
		return [
			Math.min(255, Math.max(0, Number(trueColor[1]))),
			Math.min(255, Math.max(0, Number(trueColor[2]))),
			Math.min(255, Math.max(0, Number(trueColor[3]))),
		];
	}
	const color256 = /\x1b\[38;5;(\d+)m/.exec(ansi);
	if (color256) {
		return ansi256ToRgb(Number(color256[1]));
	}
	const color16 = /\x1b\[(3[0-7]|9[0-7])m/.exec(ansi);
	if (color16) {
		const code = Number(color16[1]);
		const index = code >= 90 ? code - 90 + 8 : code - 30;
		return ansi16ToRgb(index);
	}
	return null;
}

function mixRgb(a: Rgb, b: Rgb, t: number): [number, number, number] {
	const clamped = Math.min(1, Math.max(0, t));
	return [
		Math.round(a[0] + (b[0] - a[0]) * clamped),
		Math.round(a[1] + (b[1] - a[1]) * clamped),
		Math.round(a[2] + (b[2] - a[2]) * clamped),
	];
}

/**
 * Compute per-character shimmer intensity [0..1] for `textLength` characters
 * at `elapsedMs`, driven by wall-clock time so frame drops never stall the wave.
 */
export function shimmerWaveWeights(
	textLength: number,
	elapsedMs: number,
	cycleMs = DEFAULT_CYCLE_MS,
	sweepMs = DEFAULT_SWEEP_MS,
): number[] {
	if (textLength <= 0) return [];
	const phaseMs = ((elapsedMs % cycleMs) + cycleMs) % cycleMs;
	if (phaseMs >= sweepMs) {
		return Array.from({ length: textLength }, () => 0);
	}
	const progress = phaseMs / sweepMs;
	const start = -SHIMMER_SPREAD;
	const end = textLength - 1 + SHIMMER_SPREAD;
	const center = start + (end - start) * progress;

	const weights: number[] = [];
	for (let i = 0; i < textLength; i++) {
		const dist = Math.abs(i - center);
		if (dist >= SHIMMER_SPREAD) {
			weights.push(0);
		} else {
			weights.push(0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_SPREAD)));
		}
	}
	return weights;
}

function resolveShimmerPalette(theme: ShimmerTheme | undefined): {
	base: Rgb;
	peak: Rgb;
	hasTrueColor: boolean;
} {
	if (typeof theme?.getFgAnsi !== "function") {
		return { base: FALLBACK_BASE_RGB, peak: FALLBACK_PEAK_RGB, hasTrueColor: false };
	}
	const base = parseForegroundRgbFromAnsi(theme.getFgAnsi("thinkingText"));
	const accent = parseForegroundRgbFromAnsi(theme.getFgAnsi("accent"));
	const text = parseForegroundRgbFromAnsi(theme.getFgAnsi("text"));
	if (!base && !accent) {
		return { base: FALLBACK_BASE_RGB, peak: FALLBACK_PEAK_RGB, hasTrueColor: false };
	}
	const resolvedBase = base ?? FALLBACK_BASE_RGB;
	const resolvedPeak = accent
		? text
			? mixRgb(accent, text, 0.35)
			: accent
		: (text ?? FALLBACK_PEAK_RGB);
	return { base: resolvedBase, peak: resolvedPeak, hasTrueColor: true };
}

/**
 * Render `text` with a smooth time-driven foreground color shimmer sweep.
 * Uses truecolor RGB interpolation when theme ANSI colors are available, and
 * falls back to theme `fg("accent" | "thinkingText")` bands otherwise.
 */
export function renderShimmerText(
	text: string,
	elapsedMs: number,
	theme?: ShimmerTheme,
): string {
	const chars = Array.from(text);
	if (chars.length === 0) return "";
	const weights = shimmerWaveWeights(chars.length, elapsedMs);
	const { base, peak, hasTrueColor } = resolveShimmerPalette(theme);

	let body = "";
	if (hasTrueColor || !theme) {
		let lastKey = "";
		for (let i = 0; i < chars.length; i++) {
			const [r, g, b] = mixRgb(base, peak, weights[i]!);
			const key = `${r};${g};${b}`;
			if (key !== lastKey) {
				body += `\x1b[38;2;${key}m`;
				lastKey = key;
			}
			body += chars[i]!;
		}
		body += "\x1b[39m";
	} else {
		let lastToken: "accent" | "thinkingText" | null = null;
		let run = "";
		const flush = () => {
			if (!run || !lastToken) return;
			body += theme.fg(lastToken, run);
			run = "";
		};
		for (let i = 0; i < chars.length; i++) {
			const token: "accent" | "thinkingText" = weights[i]! >= 0.5 ? "accent" : "thinkingText";
			if (token !== lastToken) {
				flush();
				lastToken = token;
			}
			run += chars[i]!;
		}
		flush();
	}

	return typeof theme?.italic === "function" ? theme.italic(body) : body;
}
