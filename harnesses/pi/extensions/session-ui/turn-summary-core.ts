export const TURN_SUMMARY_TYPE = "session-ui:turn-summary";
export const LEGACY_TURN_DURATION_TYPE = "session-ui:turn-duration";
export const I_DURATION = "\u{F051B}";

export interface TurnSummaryData {
	ms: number;
	startedAt: number;
	endedAt: number;
	model?: string;
	effort?: string;
}

export interface TurnSummaryOptions {
	enabled?: boolean;
	showDuration?: boolean;
	showModel?: boolean;
	showEffort?: boolean;
}

export function formatTurnDuration(ms: number): string {
	const clamped = Math.max(0, ms);
	if (clamped < 10_000) return `${(clamped / 1_000).toFixed(1)}s`;
	const totalSeconds = Math.round(clamped / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return [
			`${hours}h`,
			minutes > 0 ? `${minutes}m` : "",
			seconds > 0 ? `${seconds}s` : "",
		]
			.filter(Boolean)
			.join(" ");
	}
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatTurnSummaryText(
	data: TurnSummaryData,
	options: TurnSummaryOptions = {},
): string {
	const showDuration = options.showDuration !== false;
	const showModel = options.showModel !== false;
	const showEffort = options.showEffort !== false;

	const parts: string[] = [];

	if (showDuration) {
		parts.push(`${I_DURATION} ${formatTurnDuration(data.ms)}`);
	}

	if (showModel && data.model) {
		let modelText = data.model;
		if (showEffort && data.effort && data.effort !== "off") {
			modelText += ` (${data.effort})`;
		}
		parts.push(modelText);
	}

	return parts.join(" · ");
}
