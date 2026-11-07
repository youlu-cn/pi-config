/**
 * End-of-agent tool summary line (non-LLM entry):
 * `│ Ran 1 command, wrote 1 file · 15s`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AgentRunSummary,
	formatSummaryDuration,
	summarySegments,
	type AgentSummaryData,
	type SummarySegment,
} from "./agent-summary-core.ts";

export const AGENT_SUMMARY_ENTRY_TYPE = "session-ui:agent-summary";

export interface AgentSummaryOptions {
	enabled?: boolean;
	/** Minimum tools before emitting a summary (default 1). */
	minToolCount?: number;
}

type SummaryTheme = {
	fg(color: string, text: string): string;
	italic?(text: string): string;
	getFgAnsi?(color: string): string;
};

function stylePrefix(style: (text: string) => string): string {
	const sentinel = "\u0000";
	const styled = style(sentinel);
	const index = styled.indexOf(sentinel);
	return index >= 0 ? styled.slice(0, index) : "";
}

function paintNumber(segment: SummarySegment, theme: SummaryTheme): string {
	const match = /(\d+)/.exec(segment.text);
	if (!match) return segment.text;
	const ansi =
		typeof theme.getFgAnsi === "function"
			? theme.getFgAnsi(segment.tone === "failed" ? "error" : "success")
			: "";
	if (!ansi) {
		const color = segment.tone === "failed" ? "error" : "success";
		const start = match.index;
		return (
			segment.text.slice(0, start) +
			theme.fg(color, match[1]!) +
			segment.text.slice(start + match[1]!.length)
		);
	}
	const start = match.index;
	return `${segment.text.slice(0, start)}${ansi}${match[1]}\x1b[0m${segment.text.slice(start + match[1]!.length)}`;
}

class AgentSummaryLine {
	private readonly body: string;
	private readonly border: string;

	constructor(segments: readonly SummarySegment[], duration: string, theme: SummaryTheme) {
		this.border = theme.fg("mdQuoteBorder", "│");
		const italic = theme.italic ?? ((t: string) => t);
		const quoteStyle = (text: string) => italic(theme.fg("mdQuote", text));
		const counts = segments.map((segment) => paintNumber(segment, theme)).join(", ");
		const text = duration ? `${counts} · ${duration}` : counts;
		const prefix = stylePrefix(quoteStyle);
		this.body = quoteStyle(prefix ? text.replace(/\x1b\[0m/g, `\x1b[0m${prefix}`) : text);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const line = ` ${this.border} ${this.body}`;
		if (width > 0 && line.length > width) {
			return [`${line.slice(0, Math.max(0, width - 1))}…`];
		}
		return [line];
	}
}

export function registerAgentSummary(pi: ExtensionAPI, options: AgentSummaryOptions = {}): void {
	const minToolCount = Math.max(1, options.minToolCount ?? 1);
	let summary = new AgentRunSummary();
	let enabledForSession = options.enabled !== false;

	pi.registerEntryRenderer<AgentSummaryData>(AGENT_SUMMARY_ENTRY_TYPE, (entry, _opts, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const segments = summarySegments(data);
		if (segments.length === 0) return undefined;
		const duration = formatSummaryDuration(data.durationMs);
		return new AgentSummaryLine(segments, duration, theme as unknown as SummaryTheme);
	});

	pi.on("session_start", () => {
		enabledForSession = options.enabled !== false;
		summary = new AgentRunSummary();
	});

	pi.on("agent_start", () => {
		if (!enabledForSession) return;
		summary = new AgentRunSummary();
	});

	pi.on("tool_execution_start", (event) => {
		if (!enabledForSession) return;
		summary.recordToolStart(event.toolName, event.args as Record<string, unknown> | null);
	});

	pi.on("tool_execution_end", (event) => {
		if (!enabledForSession) return;
		summary.recordToolResult(event.isError === true);
	});

	pi.on("agent_end", () => {
		if (!enabledForSession) return;
		if (summary.toolCount < minToolCount) return;
		const data = summary.snapshot();
		if (summarySegments(data).length === 0) return;
		pi.appendEntry<AgentSummaryData>(AGENT_SUMMARY_ENTRY_TYPE, data);
	});
}
