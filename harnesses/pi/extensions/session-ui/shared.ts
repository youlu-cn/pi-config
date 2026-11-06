import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export interface TextResult {
	content?: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	details?: unknown;
}

export function normalizeInline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function ellipsize(value: string, max: number): string {
	const normalized = normalizeInline(value);
	if (normalized.length <= max) return normalized;
	if (max <= 1) return "…";
	return `${normalized.slice(0, max - 1)}…`;
}

export function sanitizeTerminalText(text: string): string {
	return normalizeInline(
		text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\r\n\t]/g, " "),
	);
}

export function textOf(result: TextResult | undefined): string {
	if (!result?.content?.length) return "";
	return result.content
		.flatMap((entry) => (entry.type === "text" && entry.text ? [entry.text] : []))
		.join("\n")
		.trim();
}

export function formatTokens(value: number): string {
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

export function statusColor(percent: number): ThemeColor {
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "success";
}

export function thinkingColor(level: string): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "muted";
	}
}

/** Keep the Fast switch badge after effort, with its existing success/bold style. */
export function formatEffortWithFast(
	theme: Theme,
	level: string | undefined,
	fastStatus: string | undefined,
): string | undefined {
	const effort =
		level && level !== "off"
			? segment(theme, thinkingColor(level), "\uF0E7", level)
			: "";
	const fast =
		fastStatus === "fast" ? theme.fg("success", theme.bold("fast")) : "";
	return [effort, fast].filter(Boolean).join(" ") || undefined;
}

export function segment(
	theme: Theme,
	color: ThemeColor,
	icon: string,
	value: string,
): string {
	return `${theme.fg(color, icon)} ${value}`;
}
