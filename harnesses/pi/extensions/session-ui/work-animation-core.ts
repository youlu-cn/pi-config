export type AnimationStyle = "claude" | "gemini" | "braille" | "dots";

export const VALID_ANIMATION_STYLES: readonly AnimationStyle[] = [
	"claude",
	"gemini",
	"braille",
	"dots",
];

export function isValidAnimationStyle(value: unknown): value is AnimationStyle {
	return (
		typeof value === "string" &&
		(VALID_ANIMATION_STYLES as readonly string[]).includes(value)
	);
}

const STYLE_FRAMES: Record<Exclude<AnimationStyle, "dots">, readonly string[]> = {
	// Claude Code starburst: visually prominent, balanced crisp stars, strictly narrow EAW (zero horizontal jitter)
	claude: ["✦", "✶", "✷", "✹", "✷", "✶"],
	// Google Gemini sparkle pulse: crisp four-point stars
	gemini: ["✧", "✦", "❖", "✦"],
	// Smooth Braille circular spinner
	braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

export function renderGeminiDots(
	step: number,
	theme: { fg: (color: string, text: string) => string },
	total = 4,
): string {
	const count = Math.max(2, total);
	const cycle = (count - 1) * 2;
	const pos = Math.abs(step) % cycle;
	const activeIndex = pos < count ? pos : cycle - pos;

	const parts: string[] = [];
	for (let i = 0; i < count; i++) {
		if (i === activeIndex) {
			parts.push(theme.fg("accent", "•"));
		} else {
			parts.push(theme.fg("dim", "·"));
		}
	}
	return parts.join(" ");
}

/**
 * Render a styled animation frame for either the main work widget or tool headers.
 */
export function renderSpinnerFrame(
	step: number,
	theme: { fg: (color: string, text: string) => string },
	style: AnimationStyle = "claude",
	dotsCount = 4,
): string {
	if (style === "dots") {
		return renderGeminiDots(step, theme, dotsCount);
	}
	const frames = STYLE_FRAMES[style] ?? STYLE_FRAMES.claude;
	const idx = Math.abs(step) % frames.length;
	return theme.fg("accent", frames[idx]!);
}

/**
 * Get raw unstyled character for terminal window title animation.
 */
export function getTitleSpinnerFrame(
	step: number,
	style: AnimationStyle = "claude",
): string {
	const frames =
		style === "dots"
			? STYLE_FRAMES.braille
			: (STYLE_FRAMES[style] ?? STYLE_FRAMES.claude);
	return frames[Math.abs(step) % frames.length]!;
}

export function phaseForTool(toolName: string): string {
	const name = toolName.toLowerCase();
	if (name === "scout") return "Scouting repository...";
	if (name === "architect") return "Designing architecture...";
	if (name === "read" || name.includes("fetch")) return "Reading...";
	if (name === "edit" || name === "write") return "Editing...";
	if (name === "bash") return "Running command...";
	if (name.includes("search") || name.includes("grep") || name === "find") {
		return "Searching...";
	}
	if (name.includes("diagnostic") || name.includes("lsp")) {
		return "Checking code...";
	}
	if (name.includes("image")) return "Processing image...";
	const safeName =
		toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "tool";
	return `Using ${safeName}...`;
}
