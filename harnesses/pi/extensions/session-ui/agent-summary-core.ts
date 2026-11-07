/**
 * Agent-turn tool summary stats (Claude Code style).
 *
 * Categories: bash/powershell → commands; read/edit/write → unique paths;
 * everything else → other. Failures counted separately.
 *
 * Adapted from pi-cc-extensions agent-summary (MIT).
 */

export type AgentToolCategory = "bash" | "read" | "edit" | "write" | "other";

export type AgentSummaryData = {
	commands: number;
	reads: number;
	edits: number;
	writes: number;
	others: number;
	failed: number;
	durationMs: number;
};

export type SummarySegment = { text: string; tone: "success" | "failed" };

export function classifyTool(toolName: string): AgentToolCategory {
	const base = toolName.split(".").pop() ?? toolName;
	if (base === "bash" || base === "powershell") return "bash";
	if (base === "read") return "read";
	if (base === "edit") return "edit";
	if (base === "write") return "write";
	return "other";
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function toolPath(args?: Record<string, unknown> | null): string | undefined {
	const path = args?.path ?? args?.file_path;
	return nonEmptyString(path) ? path : undefined;
}

export class AgentRunSummary {
	toolCount = 0;
	commandCount = 0;
	readFiles = new Set<string>();
	editFiles = new Set<string>();
	writeFiles = new Set<string>();
	otherCount = 0;
	failedCount = 0;
	readonly startedAt: number;

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}

	recordToolStart(toolName: string, args?: Record<string, unknown> | null): void {
		this.toolCount++;
		const path = toolPath(args);
		switch (classifyTool(toolName)) {
			case "bash":
				this.commandCount++;
				break;
			case "read":
				if (path) this.readFiles.add(path);
				break;
			case "edit":
				if (path) this.editFiles.add(path);
				break;
			case "write":
				if (path) this.writeFiles.add(path);
				break;
			default:
				this.otherCount++;
		}
	}

	recordToolResult(isError: boolean): void {
		if (isError) this.failedCount++;
	}

	snapshot(now = Date.now()): AgentSummaryData {
		return {
			commands: this.commandCount,
			reads: this.readFiles.size,
			edits: this.editFiles.size,
			writes: this.writeFiles.size,
			others: this.otherCount,
			failed: this.failedCount,
			durationMs: Math.max(0, now - this.startedAt),
		};
	}
}

const plural = (count: number) => (count === 1 ? "" : "s");

function summaryParts(data: AgentSummaryData): string[] {
	const parts: string[] = [];
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.writes) parts.push(`wrote ${data.writes} file${plural(data.writes)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	return parts;
}

export function summarySegments(data: AgentSummaryData): SummarySegment[] {
	const parts = summaryParts(data);
	if (parts.length === 0) return [];
	const capitalizeFirst = (part: string, first: boolean) => {
		const verb = part.match(/^[a-z]+/)?.[0] ?? "";
		return first && verb ? verb[0]!.toUpperCase() + verb.slice(1) + part.slice(verb.length) : part;
	};
	return parts.map((part, index) => ({
		text: capitalizeFirst(part, index === 0),
		tone: part.endsWith("failed") ? ("failed" as const) : ("success" as const),
	}));
}

/** Short duration for the summary line (e.g. 15s / 2m 3s). */
export function formatSummaryDuration(ms: number): string {
	const totalSec = Math.floor(Math.max(0, ms) / 1000);
	if (totalSec < 1) return "";
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
