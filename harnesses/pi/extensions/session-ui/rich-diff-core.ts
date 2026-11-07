/**
 * Rich edit/write diff formatting for Claude-style tool cards.
 *
 * Adds change indicator bars, (+A -D) chips, collapsed line budgets, optional
 * split layout, and simple intra-line highlighting for 1:1 replacements.
 *
 * Diff presentation ideas adapted from pi-cc-extensions (MIT).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { countDiffStats, getTextContent } from "./claude-tool-renderer-core.ts";

export type DiffViewMode = "auto" | "unified" | "split";
export type DiffIndicatorMode = "bars" | "classic" | "none";

export interface RichDiffOptions {
	viewMode: DiffViewMode;
	indicatorMode: DiffIndicatorMode;
	splitMinWidth: number;
	editCollapsedLines: number;
	writeCollapsedLines: number;
	/** Available render width for the result body (after pad). */
	width?: number;
}

export const DEFAULT_RICH_DIFF_OPTIONS: RichDiffOptions = {
	viewMode: "auto",
	indicatorMode: "bars",
	splitMinWidth: 120,
	editCollapsedLines: 12,
	writeCollapsedLines: 8,
};

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "  ");
}

function stripAnsi(text: string): string {
	return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function styleChangeCounts(
	theme: Theme,
	added: number,
	removed: number,
): string {
	const parts: string[] = [];
	if (added > 0) parts.push(theme.fg("success", `+${added}`));
	if (removed > 0) parts.push(theme.fg("error", `-${removed}`));
	if (parts.length === 0) return "";
	return `${theme.fg("dim", "(")}${parts.join(" ")}${theme.fg("dim", ")")}`;
}

function indicatorGlyph(
	kind: "add" | "remove" | "context",
	mode: DiffIndicatorMode,
	theme: Theme,
): string {
	if (mode === "none") return "";
	if (mode === "classic") {
		const ch = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
		const color =
			kind === "add" ? "toolDiffAdded" : kind === "remove" ? "toolDiffRemoved" : "toolDiffContext";
		return theme.fg(color, ch);
	}
	// bars
	if (kind === "add") return theme.fg("success", "▌");
	if (kind === "remove") return theme.fg("error", "▌");
	return theme.fg("dim", "▏");
}

function classifyRenderedLine(line: string): "add" | "remove" | "context" {
	// Strip real ANSI and mock theme tags used in unit tests.
	const plain = stripAnsi(line)
		.replace(/\[[a-zA-Z0-9_-]+\]/g, "")
		.replace(/\[\/[a-zA-Z0-9_-]+\]/g, "")
		.replace(/<\/?\w+>/g, "")
		.trimStart();
	if (plain.startsWith("+")) return "add";
	if (plain.startsWith("-")) return "remove";
	return "context";
}

function decorateLines(
	lines: string[],
	theme: Theme,
	indicatorMode: DiffIndicatorMode,
	pad: string,
): string[] {
	return lines.map((line) => {
		const kind = classifyRenderedLine(line);
		const bar = indicatorGlyph(kind, indicatorMode, theme);
		const prefix = bar ? `${bar} ` : "";
		return `${pad}      ${prefix}${line}`;
	});
}

function collapseLines(
	lines: string[],
	limit: number,
	expanded: boolean,
	theme: Theme,
	pad: string,
	expandHint: string,
): string[] {
	if (expanded || limit <= 0 || lines.length <= limit) {
		if (!expanded && limit === 0 && lines.length > 0) {
			return [
				`${pad}      ${theme.fg("dim", `… ${lines.length} lines hidden · ${expandHint}`)}`,
			];
		}
		return lines;
	}
	const visible = lines.slice(0, limit);
	const remaining = lines.length - limit;
	visible.push(
		`${pad}      ${theme.fg("dim", `… +${remaining} more lines · ${expandHint}`)}`,
	);
	return visible;
}

function buildSyntheticDiffFromEdits(
	edits: Array<{ oldText?: string; newText?: string }>,
): string {
	const lines: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (const edit of edits) {
		const oldLines = typeof edit.oldText === "string" ? edit.oldText.split("\n") : [];
		const newLines = typeof edit.newText === "string" ? edit.newText.split("\n") : [];
		for (const l of oldLines) {
			lines.push(`-${String(oldLine).padStart(3, " ")} ${replaceTabs(l)}`);
			oldLine++;
		}
		for (const l of newLines) {
			lines.push(`+${String(newLine).padStart(3, " ")} ${replaceTabs(l)}`);
			newLine++;
		}
	}
	return lines.join("\n");
}

function shouldSplit(opts: RichDiffOptions, width: number | undefined): boolean {
	if (opts.viewMode === "unified") return false;
	if (opts.viewMode === "split") return true;
	return (width ?? 0) >= opts.splitMinWidth;
}

/**
 * Simple split layout: pair consecutive -/ + lines side by side when possible.
 * Falls back to unified when pairing is ambiguous.
 */
function renderSplitDiff(
	diffText: string,
	theme: Theme,
	width: number,
	indicatorMode: DiffIndicatorMode,
	pad: string,
): string[] | null {
	const rawLines = diffText.split("\n").filter((l) => l.length > 0);
	const parsed = rawLines.map((line) => {
		const m = line.match(/^([+\- ])(\s*\d*)\s?(.*)$/);
		if (!m) return { kind: "context" as const, num: "", content: line };
		const kind =
			m[1] === "+" ? ("add" as const) : m[1] === "-" ? ("remove" as const) : ("context" as const);
		return { kind, num: (m[2] ?? "").trim(), content: replaceTabs(m[3] ?? "") };
	});

	const colWidth = Math.max(20, Math.floor((width - 10) / 2));
	const out: string[] = [];
	let i = 0;
	while (i < parsed.length) {
		const cur = parsed[i]!;
		const next = parsed[i + 1];
		if (cur.kind === "remove" && next?.kind === "add") {
			const left = truncateCell(`-${cur.num} ${cur.content}`, colWidth);
			const right = truncateCell(`+${next.num} ${next.content}`, colWidth);
			const leftBar = indicatorGlyph("remove", indicatorMode, theme);
			const rightBar = indicatorGlyph("add", indicatorMode, theme);
			out.push(
				`${pad}      ${leftBar ? `${leftBar} ` : ""}${theme.fg("toolDiffRemoved", left.padEnd(colWidth))} ${theme.fg("dim", "│")} ${rightBar ? `${rightBar} ` : ""}${theme.fg("toolDiffAdded", right)}`,
			);
			i += 2;
			continue;
		}
		const bar = indicatorGlyph(cur.kind, indicatorMode, theme);
		const color =
			cur.kind === "add"
				? "toolDiffAdded"
				: cur.kind === "remove"
					? "toolDiffRemoved"
					: "toolDiffContext";
		const prefix = cur.kind === "add" ? "+" : cur.kind === "remove" ? "-" : " ";
		out.push(
			`${pad}      ${bar ? `${bar} ` : ""}${theme.fg(color, `${prefix}${cur.num} ${cur.content}`)}`,
		);
		i++;
	}
	return out;
}

function truncateCell(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}

type ParsedDiffLine = {
	prefix: "+" | "-" | " ";
	lineNum: string;
	content: string;
};

function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return {
		prefix: match[1] as ParsedDiffLine["prefix"],
		lineNum: match[2] ?? "",
		content: match[3] ?? "",
	};
}

/** Lightweight word-level highlight for single-line replacements. */
function highlightIntraLine(
	oldContent: string,
	newContent: string,
	theme: Theme,
): { removed: string; added: string } {
	// Longest common prefix / suffix — good enough for indent-stable edits.
	let start = 0;
	const minLen = Math.min(oldContent.length, newContent.length);
	while (start < minLen && oldContent[start] === newContent[start]) start++;
	let oldEnd = oldContent.length;
	let newEnd = newContent.length;
	while (
		oldEnd > start &&
		newEnd > start &&
		oldContent[oldEnd - 1] === newContent[newEnd - 1]
	) {
		oldEnd--;
		newEnd--;
	}
	const inverse =
		typeof (theme as { inverse?: (t: string) => string }).inverse === "function"
			? (theme as { inverse: (t: string) => string }).inverse
			: (t: string) => t;
	const removed =
		oldContent.slice(0, start) +
		inverse(oldContent.slice(start, oldEnd)) +
		oldContent.slice(oldEnd);
	const added =
		newContent.slice(0, start) +
		inverse(newContent.slice(start, newEnd)) +
		newContent.slice(newEnd);
	return { removed, added };
}

/** Theme-aware unified diff renderer (Pi-compatible `±N content` lines). */
export function renderThemedDiff(diffText: string, theme: Theme): string[] {
	const lines = diffText.split("\n");
	const result: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const parsed = parseDiffLine(lines[i]!);
		if (!parsed) {
			if (lines[i]!.length > 0) result.push(theme.fg("toolDiffContext", lines[i]!));
			i++;
			continue;
		}
		if (parsed.prefix === "-") {
			const removed: ParsedDiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]!);
				if (!p || p.prefix !== "-") break;
				removed.push(p);
				i++;
			}
			const added: ParsedDiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]!);
				if (!p || p.prefix !== "+") break;
				added.push(p);
				i++;
			}
			if (removed.length === 1 && added.length === 1) {
				const hl = highlightIntraLine(
					replaceTabs(removed[0]!.content),
					replaceTabs(added[0]!.content),
					theme,
				);
				result.push(
					theme.fg("toolDiffRemoved", `-${removed[0]!.lineNum} ${hl.removed}`),
				);
				result.push(theme.fg("toolDiffAdded", `+${added[0]!.lineNum} ${hl.added}`));
			} else {
				for (const r of removed) {
					result.push(
						theme.fg("toolDiffRemoved", `-${r.lineNum} ${replaceTabs(r.content)}`),
					);
				}
				for (const a of added) {
					result.push(
						theme.fg("toolDiffAdded", `+${a.lineNum} ${replaceTabs(a.content)}`),
					);
				}
			}
			continue;
		}
		if (parsed.prefix === "+") {
			result.push(
				theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`),
			);
			i++;
			continue;
		}
		result.push(
			theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`),
		);
		i++;
	}
	return result;
}

export function formatRichEditDiff(
	args: any,
	result: { content?: any[]; details?: any },
	theme: Theme,
	expanded: boolean,
	pad: string,
	expandHint: string,
	opts: RichDiffOptions = DEFAULT_RICH_DIFF_OPTIONS,
): string {
	const diffText: string | undefined = result?.details?.diff;
	const edits: Array<{ oldText?: string; newText?: string }> | undefined = Array.isArray(
		args?.edits,
	)
		? args.edits
		: typeof args?.oldText === "string" || typeof args?.newText === "string"
			? [{ oldText: args.oldText, newText: args.newText }]
			: undefined;

	const { added, removed } = countDiffStats(diffText, edits);
	const counts = styleChangeCounts(theme, added, removed);
	const summaryCore =
		counts ||
		theme.fg(
			"dim",
			`${edits?.length ?? 1} replacement${(edits?.length ?? 1) === 1 ? "" : "s"}`,
		);
	const hint = theme.fg("dim", `(${expandHint})`);
	const header = `${pad}  ${theme.fg("dim", "└")} ${summaryCore} ${hint}`;

	const sourceDiff =
		typeof diffText === "string" && diffText.trim().length > 0
			? diffText
			: edits && edits.length > 0
				? buildSyntheticDiffFromEdits(edits)
				: "";

	if (!sourceDiff) return header;

	const bodyWidth = Math.max(40, (opts.width ?? 80) - pad.length - 8);
	let bodyLines: string[];

	const splitLines = shouldSplit(opts, opts.width)
		? renderSplitDiff(sourceDiff, theme, bodyWidth, opts.indicatorMode, pad)
		: null;
	if (splitLines) {
		bodyLines = splitLines;
	} else {
		const raw = renderThemedDiff(sourceDiff, theme);
		bodyLines = decorateLines(raw, theme, opts.indicatorMode, pad);
	}

	const limited = collapseLines(
		bodyLines,
		opts.editCollapsedLines,
		expanded,
		theme,
		pad,
		expandHint,
	);
	return [header, ...limited].join("\n");
}

export function formatRichWritePreview(
	args: any,
	result: { content?: any[]; details?: any },
	theme: Theme,
	expanded: boolean,
	pad: string,
	expandHint: string,
	opts: RichDiffOptions = DEFAULT_RICH_DIFF_OPTIONS,
): string {
	const writtenContent =
		typeof args?.content === "string" ? args.content : getTextContent(result?.content);
	const allLines = writtenContent
		? writtenContent.replace(/\r\n/g, "\n").trimEnd().split("\n")
		: [];
	const lineCount = allLines.length;
	const counts = styleChangeCounts(theme, lineCount, 0);
	const summary =
		lineCount > 0
			? `${theme.fg("dim", "Wrote")} ${counts || theme.fg("dim", `${lineCount} lines`)}`
			: theme.fg("dim", "Wrote file");
	const hint = theme.fg("dim", `(${expandHint})`);
	const header = `${pad}  ${theme.fg("dim", "└")} ${summary} ${hint}`;

	if (lineCount === 0 || typeof args?.content !== "string") return header;

	const bar = indicatorGlyph("add", opts.indicatorMode, theme);
	const body = allLines.map((line, i) => {
		const num = String(i + 1).padStart(3, " ");
		const code = replaceTabs(line);
		return `${pad}      ${bar ? `${bar} ` : ""}${theme.fg("dim", `${num} │ `)}${theme.fg("toolDiffAdded", code)}`;
	});

	const limited = collapseLines(
		body,
		opts.writeCollapsedLines,
		expanded,
		theme,
		pad,
		expandHint,
	);
	return [header, ...limited].join("\n");
}
