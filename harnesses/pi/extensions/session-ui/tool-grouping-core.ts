import { countDiffStats, formatPath, getTextContent } from "./claude-tool-renderer-core.ts";

export type ToolStatus = "pending" | "success" | "error";

export type ToolCategory = "explore" | "change" | "bash" | `tool:${string}`;

export interface ToolSnapshot {
	toolName: string;
	args?: any;
	cwd?: string;
	result?: {
		content?: any[];
		details?: any;
		isError?: boolean;
		durationMs?: number;
	};
	isPartial?: boolean;
}

export interface GroupTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

export interface LineRange {
	start: number;
	end: number; // Infinity means to EOF
}

const EXPLORE_TOOLS = new Set(["read", "ls", "grep", "find"]);
const CHANGE_TOOLS = new Set(["edit", "write"]);
const BASH_TOOLS = new Set(["bash", "powershell"]);
const NON_GROUPABLE_TOOLS = new Set(["ask_user_question"]);

const MAX_COLLAPSED_ITEMS = 8;

export function classifyGroupCategory(toolName: string): ToolCategory | null {
	const name = (toolName || "").trim();
	if (!name || NON_GROUPABLE_TOOLS.has(name)) return null;
	if (EXPLORE_TOOLS.has(name)) return "explore";
	if (CHANGE_TOOLS.has(name)) return "change";
	if (BASH_TOOLS.has(name)) return "bash";
	return `tool:${name}`;
}

export function statusOfTool(tool: ToolSnapshot): ToolStatus {
	if (!tool?.result) return "pending";
	if (tool.result.isError) return "error";
	return "success";
}

function overallStatus(statuses: readonly ToolStatus[]): ToolStatus {
	if (statuses.includes("error")) return "error";
	if (statuses.includes("pending")) return "pending";
	return "success";
}

function statusIcon(status: ToolStatus, theme: GroupTheme): string {
	if (status === "pending") return theme.fg("accent", "●");
	if (status === "error") return theme.fg("error", "●");
	return theme.fg("success", "●");
}

function itemStatusIcon(status: ToolStatus, theme: GroupTheme): string {
	if (status === "pending") return theme.fg("accent", "◆");
	if (status === "error") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function capitalize(name: string): string {
	if (!name) return "Tool";
	if (name.startsWith("mcp__")) {
		const parts = name.slice(5).split("__");
		return `Mcp(${parts.join(".")})`;
	}
	return name.charAt(0).toUpperCase() + name.slice(1);
}

function plural(count: number, singular: string, pluralForm?: string): string {
	return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

function countTextLines(text: string): number {
	if (!text) return 0;
	return text.trimEnd().split("\n").length;
}

function extractPath(args: any, cwd: string): string {
	const raw = args?.file_path ?? args?.path;
	return formatPath(raw, cwd) || (typeof raw === "string" ? raw : "");
}

function readRangeFromArgs(args: any): LineRange | "full" {
	const hasOffset = typeof args?.offset === "number" && Number.isFinite(args.offset);
	const hasLimit = typeof args?.limit === "number" && Number.isFinite(args.limit) && args.limit > 0;
	if (!hasOffset && !hasLimit) return "full";
	const start = Math.max(1, Math.floor(hasOffset ? args.offset : 1));
	const end = hasLimit ? start + Math.floor(args.limit) - 1 : Number.POSITIVE_INFINITY;
	return { start, end };
}

export function mergeLineRanges(ranges: readonly (LineRange | "full")[]): LineRange[] | "full" {
	if (ranges.length === 0 || ranges.includes("full")) return "full";
	const sorted = [...(ranges as LineRange[])].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: LineRange[] = [];
	for (const r of sorted) {
		const last = merged[merged.length - 1];
		if (!last) {
			merged.push({ ...r });
			continue;
		}
		if (r.start <= last.end + 1) {
			last.end = Math.max(last.end, r.end);
		} else {
			merged.push({ ...r });
		}
	}
	return merged;
}

export function formatMergedRanges(ranges: LineRange[] | "full"): string {
	if (ranges === "full") return "";
	return ranges
		.map((r) => (Number.isFinite(r.end) ? `${r.start}-${r.end}` : `${r.start}+`))
		.join(", ");
}

function oneLine(value: unknown, max = 72): string {
	const raw = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

function formatDuration(ms: number | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function countBadges(counts: { pending: number; success: number; error: number }, theme: GroupTheme): string {
	const parts: string[] = [];
	if (counts.success) parts.push(theme.fg("success", `${counts.success} done`));
	if (counts.error) parts.push(theme.fg("error", `${counts.error} failed`));
	if (counts.pending) parts.push(theme.fg("accent", `${counts.pending} running`));
	return parts.join(theme.fg("dim", " · "));
}

type RenderRow = {
	status: ToolStatus;
	text: string;
};

function rowTextBudget(width: number, reserve: number, min = 32): number {
	const safeWidth = width > 0 ? width : 80;
	return Math.max(min, Math.floor((safeWidth - reserve) * 0.9));
}

function renderExploreGroup(
	tools: readonly ToolSnapshot[],
	theme: GroupTheme,
	expanded: boolean,
	width: number,
): { title: string; subtitle: string; rows: RenderRow[] } {
	const patternBudget = Math.max(24, Math.floor(rowTextBudget(width, 16, 40) * 0.45));
	type ReadAgg = {
		kind: "read";
		path: string;
		ranges: (LineRange | "full")[];
		lines: number;
		calls: number;
		statuses: ToolStatus[];
	};
	type SearchAgg = {
		kind: "search";
		toolName: string;
		label: string;
		matches: number;
		status: ToolStatus;
	};

	const items: (ReadAgg | SearchAgg)[] = [];
	const readByPath = new Map<string, ReadAgg>();

	let readCalls = 0;
	let searchCalls = 0;

	for (const tool of tools) {
		const cwd = tool.cwd ?? "";
		const st = statusOfTool(tool);
		if (tool.toolName === "read") {
			readCalls++;
			const path = extractPath(tool.args, cwd) || "(file)";
			const range = readRangeFromArgs(tool.args);
			const lines = tool.result ? countTextLines(getTextContent(tool.result.content)) : 0;
			let agg = readByPath.get(path);
			if (!agg) {
				agg = { kind: "read", path, ranges: [], lines: 0, calls: 0, statuses: [] };
				readByPath.set(path, agg);
				items.push(agg);
			}
			agg.ranges.push(range);
			agg.lines += lines;
			agg.calls++;
			agg.statuses.push(st);
		} else {
			searchCalls++;
			const pattern = typeof tool.args?.pattern === "string" ? tool.args.pattern : "";
			const where = extractPath(tool.args, cwd);
			const matches = tool.result ? countTextLines(getTextContent(tool.result.content)) : 0;
			let label = capitalize(tool.toolName);
			if (tool.toolName === "grep") {
				const q = pattern ? `"${oneLine(pattern, patternBudget)}"` : "";
				label = where ? `Grep ${q} in ${where}` : `Grep ${q}`;
			} else if (tool.toolName === "find") {
				const q = pattern ? `"${oneLine(pattern, patternBudget)}"` : where;
				label = `Find ${q}`;
			} else if (tool.toolName === "ls") {
				label = `Ls ${where || "."}`;
			}
			items.push({ kind: "search", toolName: tool.toolName, label: label.trim(), matches, status: st });
		}
	}

	const allReadsOnly = searchCalls === 0;
	const uniqueFiles = readByPath.size;
	const totalReadLines = [...readByPath.values()].reduce((acc, r) => acc + r.lines, 0);

	let title: string;
	const subParts: string[] = [];
	if (allReadsOnly) {
		title = `Read ${plural(uniqueFiles, "file")}`;
		if (readCalls > uniqueFiles) subParts.push(plural(readCalls, "read"));
		if (totalReadLines > 0) subParts.push(plural(totalReadLines, "line"));
	} else {
		title = "Explore";
		if (readCalls > 0) subParts.push(plural(readCalls, "read"));
		if (searchCalls > 0) subParts.push(plural(searchCalls, "search", "searches"));
	}

	const rows: RenderRow[] = expanded
		? []
		: items.map((item) => {
				if (item.kind === "read") {
					const st = overallStatus(item.statuses);
					const merged = formatMergedRanges(mergeLineRanges(item.ranges));
					const loc = merged ? `${item.path}:${merged}` : item.path;
					const metaParts: string[] = [];
					if (item.lines > 0) metaParts.push(plural(item.lines, "line"));
					if (item.calls > 1) metaParts.push(plural(item.calls, "read"));
					const meta = metaParts.length > 0 ? theme.fg("dim", ` · ${metaParts.join(", ")}`) : "";
					return { status: st, text: `${loc}${meta}` };
				}
				const meta =
					item.status === "pending"
						? theme.fg("dim", " · running")
						: item.matches > 0
							? theme.fg("dim", ` · ${plural(item.matches, item.toolName === "grep" ? "match" : "item", item.toolName === "grep" ? "matches" : "items")}`)
							: "";
				return { status: item.status, text: `${item.label}${meta}` };
			});

	return { title, subtitle: subParts.join(" · "), rows };
}

function renderChangeGroup(
	tools: readonly ToolSnapshot[],
	theme: GroupTheme,
	expanded: boolean,
): { title: string; subtitle: string; rows: RenderRow[] } {
	type FileChangeAgg = {
		path: string;
		edits: number;
		writes: number;
		added: number;
		removed: number;
		statuses: ToolStatus[];
	};

	const byPath = new Map<string, FileChangeAgg>();
	let totalEdits = 0;
	let totalWrites = 0;
	let totalAdded = 0;
	let totalRemoved = 0;

	for (const tool of tools) {
		const cwd = tool.cwd ?? "";
		const path = extractPath(tool.args, cwd) || "(file)";
		const st = statusOfTool(tool);
		let agg = byPath.get(path);
		if (!agg) {
			agg = { path, edits: 0, writes: 0, added: 0, removed: 0, statuses: [] };
			byPath.set(path, agg);
		}
		agg.statuses.push(st);
		if (tool.toolName === "edit") {
			agg.edits++;
			totalEdits++;
			const stats = countDiffStats(tool.result?.details?.diff, tool.args?.edits);
			agg.added += stats.added;
			agg.removed += stats.removed;
			totalAdded += stats.added;
			totalRemoved += stats.removed;
		} else {
			agg.writes++;
			totalWrites++;
			const content =
				typeof tool.args?.content === "string"
					? tool.args.content
					: getTextContent(tool.result?.content);
			const lines = countTextLines(content);
			agg.added += lines;
			totalAdded += lines;
		}
	}

	const fileCount = byPath.size;
	const title =
		totalWrites === 0
			? `Edit ${plural(fileCount, "file")}`
			: totalEdits === 0
				? `Write ${plural(fileCount, "file")}`
				: `Edit & Write ${plural(fileCount, "file")}`;

	const subParts: string[] = [];
	if (totalAdded > 0 || totalRemoved > 0) {
		const diffChips: string[] = [];
		if (totalAdded > 0) diffChips.push(theme.fg("success", `+${totalAdded}`));
		if (totalRemoved > 0) diffChips.push(theme.fg("error", `-${totalRemoved}`));
		subParts.push(diffChips.join(" "));
	}
	const totalOps = totalEdits + totalWrites;
	if (totalOps > fileCount) {
		subParts.push(plural(totalOps, totalWrites === 0 ? "edit" : "change"));
	}

	const rows: RenderRow[] = expanded
		? []
		: [...byPath.values()].map((agg) => {
				const st = overallStatus(agg.statuses);
				const opLabel = agg.writes > 0 && agg.edits === 0 ? "Write" : "Edit";
				const diffChips: string[] = [];
				if (agg.added > 0) diffChips.push(theme.fg("success", `+${agg.added}`));
				if (agg.removed > 0) diffChips.push(theme.fg("error", `-${agg.removed}`));
				const ops = agg.edits + agg.writes;
				const opsNote = ops > 1 ? ` · ${plural(ops, "batch", "batches")}` : "";
				const meta =
					diffChips.length > 0 || opsNote
						? ` ${theme.fg("dim", "(")}${diffChips.join(" ")}${theme.fg("dim", `${opsNote})`) }`
						: "";
				return {
					status: st,
					text: `${theme.fg("muted", opLabel)} ${agg.path}${meta}`,
				};
			});

	return { title, subtitle: subParts.join(" · "), rows };
}

function renderBashGroup(
	tools: readonly ToolSnapshot[],
	theme: GroupTheme,
	expanded: boolean,
	width: number,
): { title: string; subtitle: string; rows: RenderRow[] } {
	const title = `Bash (${plural(tools.length, "command")})`;
	const cmdBudget = rowTextBudget(width, 16, 48);
	const rows: RenderRow[] = expanded
		? []
		: tools.map((tool) => {
				const st = statusOfTool(tool);
				const cmd = oneLine(tool.args?.command ?? "command", cmdBudget);
				const dur = formatDuration(tool.result?.durationMs);
				const meta = dur ? theme.fg("dim", ` · ${dur}`) : "";
				return { status: st, text: `${cmd}${meta}` };
			});
	return { title, subtitle: "", rows };
}

function renderGenericGroup(
	tools: readonly ToolSnapshot[],
	theme: GroupTheme,
	expanded: boolean,
	width: number,
): { title: string; subtitle: string; rows: RenderRow[] } {
	const labels = new Map<string, number>();
	for (const tool of tools) {
		const label = capitalize(tool.toolName || "tool");
		labels.set(label, (labels.get(label) ?? 0) + 1);
	}
	const title =
		labels.size === 1
			? `${[...labels.keys()][0]!} (${plural(tools.length, "call")})`
			: `Tools (${plural(tools.length, "call")})`;
	const detailBudget = rowTextBudget(width, 24, 40);
	const rows: RenderRow[] = expanded
		? []
		: tools.map((tool) => {
				const st = statusOfTool(tool);
				const cwd = tool.cwd ?? "";
				const detail =
					extractPath(tool.args, cwd) ||
					oneLine(tool.args?.query ?? tool.args?.pattern ?? tool.args?.url ?? "", detailBudget);
				const dur = formatDuration(tool.result?.durationMs);
				const meta = dur ? theme.fg("dim", ` · ${dur}`) : "";
				return {
					status: st,
					text: `${capitalize(tool.toolName)}${detail ? ` ${detail}` : ""}${meta}`,
				};
			});
	return { title, subtitle: "", rows };
}

export function buildGroupLines(
	tools: readonly ToolSnapshot[],
	theme: GroupTheme,
	expanded: boolean,
	width = 80,
): string[] {
	const counts = { pending: 0, success: 0, error: 0 };
	const categories = new Set<ToolCategory | null>();
	for (const tool of tools) {
		counts[statusOfTool(tool)]++;
		categories.add(classifyGroupCategory(tool.toolName));
	}

	const overall: ToolStatus = counts.error ? "error" : counts.pending ? "pending" : "success";
	const onlyCategory = categories.size === 1 ? [...categories][0] : null;

	let rendered: { title: string; subtitle: string; rows: RenderRow[] };
	if (onlyCategory === "explore") {
		rendered = renderExploreGroup(tools, theme, expanded, width);
	} else if (onlyCategory === "change") {
		rendered = renderChangeGroup(tools, theme, expanded);
	} else if (onlyCategory === "bash") {
		rendered = renderBashGroup(tools, theme, expanded, width);
	} else {
		rendered = renderGenericGroup(tools, theme, expanded, width);
	}

	const statusSummary = countBadges(counts, theme);
	const hint = expanded ? "click to collapse" : "click to expand";
	const parts = [
		` ${statusIcon(overall, theme)} ${theme.bold?.(rendered.title) ?? rendered.title}`,
		rendered.subtitle ? rendered.subtitle : statusSummary,
		rendered.subtitle && counts.pending > 0 ? theme.fg("accent", `${counts.pending} running`) : "",
		rendered.subtitle && counts.error > 0 ? theme.fg("error", `${counts.error} failed`) : "",
		theme.fg("dim", hint),
	].filter(Boolean);

	const out: string[] = [parts.join(theme.fg("dim", " · "))];

	if (!expanded && rendered.rows.length > 0) {
		const hidden = Math.max(0, rendered.rows.length - MAX_COLLAPSED_ITEMS);
		const visible = hidden > 0 ? rendered.rows.slice(-MAX_COLLAPSED_ITEMS) : rendered.rows;
		if (hidden > 0) {
			out.push(`   ${theme.fg("dim", `├ … ${plural(hidden, "earlier item")}`)}`);
		}
		for (let i = 0; i < visible.length; i++) {
			const row = visible[i]!;
			const branch = i === visible.length - 1 ? "└" : "├";
			out.push(`   ${theme.fg("dim", branch)} ${itemStatusIcon(row.status, theme)} ${row.text}`);
		}
	}

	return out;
}
