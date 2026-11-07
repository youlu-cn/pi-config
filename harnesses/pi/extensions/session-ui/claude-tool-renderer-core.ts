import { isAbsolute, relative } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	renderGeminiDots,
	renderSpinnerFrame,
	type AnimationStyle,
} from "./work-animation-core.ts";

export function formatGeminiDots(
	step: number,
	theme: Theme,
	total = 3,
): string {
	return renderGeminiDots(step, theme, total);
}

function capitalize(str: string): string {
	if (!str) return "";
	return str.charAt(0).toUpperCase() + str.slice(1);
}

export function formatPath(rawPath: unknown, cwd: string): string {
	if (typeof rawPath !== "string" || !rawPath) return "";
	if (isAbsolute(rawPath)) {
		const rel = relative(cwd, rawPath);
		if (!rel.startsWith("..") && !isAbsolute(rel)) {
			return rel;
		}
	}
	return rawPath;
}

export function formatToolHeader(
	toolName: string,
	args: any,
	cwd: string,
	theme: Theme,
	isDone: boolean,
	isError: boolean,
	animStep = 0,
	style: AnimationStyle = "claude",
): string {
	let icon: string;
	if (!isDone) {
		icon = `${renderSpinnerFrame(animStep, theme, style, 3)} `;
	} else if (isError) {
		icon = theme.fg("error", "● ");
	} else {
		icon = theme.fg("success", "● ");
	}

	let displayName = capitalize(toolName);
	let paramSummary = "";

	if (toolName === "read") {
		displayName = "Read";
		const filePath = formatPath(args?.file_path ?? args?.path, cwd);
		paramSummary = filePath;
		if (args?.offset !== undefined || args?.limit !== undefined) {
			paramSummary += `:${args.offset ?? 1}${args.limit ? `-${(args.offset ?? 1) + args.limit - 1}` : ""}`;
		}
	} else if (toolName === "bash") {
		displayName = "Bash";
		const cmd = typeof args?.command === "string" ? args.command.trim().replace(/\s+/g, " ") : "";
		paramSummary = cmd.length > 140 ? `${cmd.slice(0, 137)}...` : cmd;
	} else if (toolName === "edit") {
		displayName = "Edit";
		paramSummary = formatPath(args?.file_path ?? args?.path, cwd);
	} else if (toolName === "write") {
		displayName = "Write";
		paramSummary = formatPath(args?.file_path ?? args?.path, cwd);
	} else if (toolName === "grep") {
		displayName = "Grep";
		const pat = typeof args?.pattern === "string" ? `"${args.pattern}"` : "";
		const p = formatPath(args?.path, cwd);
		paramSummary = p ? `${pat} in ${p}` : pat;
	} else if (toolName === "find") {
		displayName = "Find";
		const p = typeof args?.pattern === "string" ? `"${args.pattern}"` : formatPath(args?.path, cwd);
		paramSummary = p;
	} else {
		if (toolName.startsWith("mcp__")) {
			const parts = toolName.slice(5).split("__");
			displayName = `Mcp(${parts.join(".")})`;
		}
		if (args && typeof args === "object") {
			for (const k of Object.keys(args)) {
				if (typeof args[k] === "string" && args[k].length > 0) {
					const val = args[k].trim().replace(/\s+/g, " ");
					paramSummary = val.length > 120 ? `${val.slice(0, 117)}...` : val;
					break;
				}
			}
		}
	}

	const nameStyled = theme.bold(displayName);
	const paramsStyled = paramSummary ? theme.fg("muted", `(${paramSummary})`) : "";
	const header = `${icon}${nameStyled}${paramsStyled}`;

	if (!isDone) {
		return `${header} ${theme.fg("dim", "(esc to interrupt)")}`;
	}
	return header;
}

export function getTextContent(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content
		.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n");
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.trim().split("\n").length;
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "  ");
}

/**
 * Count added and removed lines in a Pi diff string or edits array.
 */
export function countDiffStats(
	diffText: string | undefined,
	edits: any[] | undefined,
): { added: number; removed: number } {
	let added = 0;
	let removed = 0;

	if (typeof diffText === "string" && diffText.trim().length > 0) {
		for (const line of diffText.split("\n")) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
		}
		return { added, removed };
	}

	if (Array.isArray(edits)) {
		for (const edit of edits) {
			if (typeof edit?.oldText === "string" && edit.oldText.length > 0) {
				removed += edit.oldText.split("\n").length;
			}
			if (typeof edit?.newText === "string" && edit.newText.length > 0) {
				added += edit.newText.split("\n").length;
			}
		}
	}

	return { added, removed };
}

/**
 * Format Claude Code style colored diff block for Edit results.
 */
export function formatEditDiffPreview(
	args: any,
	result: { content?: any[]; details?: any },
	theme: Theme,
	expanded = false,
	pad = "",
): string {
	const diffText: string | undefined = result?.details?.diff;
	const edits: any[] | undefined = Array.isArray(args?.edits)
		? args.edits
		: typeof args?.oldText === "string" || typeof args?.newText === "string"
			? [{ oldText: args.oldText, newText: args.newText }]
			: undefined;

	const { added, removed } = countDiffStats(diffText, edits);
	const statsParts: string[] = [];
	if (added > 0) statsParts.push(`Added ${added} line${added === 1 ? "" : "s"}`);
	if (removed > 0) statsParts.push(`removed ${removed} line${removed === 1 ? "" : "s"}`);
	const summaryText =
		statsParts.length > 0
			? statsParts.join(", ")
			: `${edits?.length ?? 1} replacement${(edits?.length ?? 1) === 1 ? "" : "s"} applied`;

	const hint = expanded ? "(ctrl+o to collapse)" : "(ctrl+o to expand)";
	const outLines: string[] = [
		`${pad}  ${theme.fg("dim", `└ ${summaryText} ${hint}`)}`,
	];

	// Build colored diff lines from details.diff or fallback to edits array
	const rawDiffLines: { type: "add" | "remove" | "context"; text: string }[] = [];

	if (typeof diffText === "string" && diffText.trim().length > 0) {
		for (const line of diffText.split("\n")) {
			if (!line.trim() && rawDiffLines.length === 0) continue;
			if (line.startsWith("+")) {
				rawDiffLines.push({ type: "add", text: replaceTabs(line) });
			} else if (line.startsWith("-")) {
				rawDiffLines.push({ type: "remove", text: replaceTabs(line) });
			} else {
				rawDiffLines.push({ type: "context", text: replaceTabs(line) });
			}
		}
	} else if (edits && edits.length > 0) {
		for (const edit of edits) {
			if (typeof edit?.oldText === "string") {
				for (const l of edit.oldText.split("\n")) {
					rawDiffLines.push({ type: "remove", text: `- ${replaceTabs(l)}` });
				}
			}
			if (typeof edit?.newText === "string") {
				for (const l of edit.newText.split("\n")) {
					rawDiffLines.push({ type: "add", text: `+ ${replaceTabs(l)}` });
				}
			}
		}
	}

	if (rawDiffLines.length === 0) {
		return outLines.join("\n");
	}

	const maxLines = expanded ? rawDiffLines.length : 12;
	const visible = rawDiffLines.slice(0, maxLines);
	for (const item of visible) {
		if (item.type === "add") {
			outLines.push(`${pad}      ${theme.fg("toolDiffAdded", item.text)}`);
		} else if (item.type === "remove") {
			outLines.push(`${pad}      ${theme.fg("toolDiffRemoved", item.text)}`);
		} else {
			outLines.push(`${pad}      ${theme.fg("toolDiffContext", item.text)}`);
		}
	}

	const remaining = rawDiffLines.length - visible.length;
	if (remaining > 0) {
		outLines.push(
			`${pad}      ${theme.fg("dim", `... (${remaining} more diff lines, ctrl+o to expand)`)}`,
		);
	}

	return outLines.join("\n");
}

/**
 * Format Claude Code style code preview for Write results.
 */
export function formatWritePreview(
	args: any,
	result: { content?: any[]; details?: any },
	theme: Theme,
	expanded = false,
	pad = "",
): string {
	const writtenContent =
		typeof args?.content === "string" ? args.content : getTextContent(result?.content);
	const allLines = writtenContent
		? writtenContent.replace(/\r\n/g, "\n").trimEnd().split("\n")
		: [];
	const lineCount = allLines.length;

	const hint = expanded ? "(ctrl+o to collapse)" : "(ctrl+o to expand)";
	const summary =
		lineCount > 0
			? `Wrote ${lineCount} line${lineCount === 1 ? "" : "s"}`
			: "Wrote file";
	const outLines: string[] = [
		`${pad}  ${theme.fg("dim", `└ ${summary} ${hint}`)}`,
	];

	if (lineCount > 0 && typeof args?.content === "string") {
		const maxLines = expanded ? lineCount : 8;
		const visible = allLines.slice(0, maxLines);
		for (let i = 0; i < visible.length; i++) {
			const num = String(i + 1).padStart(3, " ");
			const codeLine = replaceTabs(visible[i]!);
			outLines.push(
				`${pad}      ${theme.fg("dim", `${num} │ `)}${theme.fg("toolOutput", codeLine)}`,
			);
		}
		const remaining = lineCount - visible.length;
		if (remaining > 0) {
			outLines.push(
				`${pad}      ${theme.fg("dim", `... (${remaining} more lines, ctrl+o to expand)`)}`,
			);
		}
	}

	return outLines.join("\n");
}

export function formatResultSummary(
	toolName: string,
	args: any,
	result: { content?: any[]; details?: any },
	durationMs: number | undefined,
): string {
	const text = getTextContent(result?.content);
	const lines = countLines(text);

	if (toolName === "read") {
		return `Read ${lines} line${lines === 1 ? "" : "s"}`;
	}
	if (toolName === "bash") {
		if (durationMs !== undefined && durationMs > 0) {
			const sec = (durationMs / 1000).toFixed(1);
			return `Done in ${sec}s`;
		}
		return lines > 0 ? `Executed (${lines} lines output)` : `Executed`;
	}
	if (toolName === "edit") {
		const { added, removed } = countDiffStats(result?.details?.diff, args?.edits);
		if (added > 0 || removed > 0) {
			const parts: string[] = [];
			if (added > 0) parts.push(`Added ${added} line${added === 1 ? "" : "s"}`);
			if (removed > 0) parts.push(`removed ${removed} line${removed === 1 ? "" : "s"}`);
			return parts.join(", ");
		}
		const editsCount = Array.isArray(args?.edits) ? args.edits.length : 1;
		return `${editsCount} replacement${editsCount === 1 ? "" : "s"} applied`;
	}
	if (toolName === "write") {
		const contentLines =
			typeof args?.content === "string" ? countLines(args.content) : lines;
		return `Wrote ${contentLines} line${contentLines === 1 ? "" : "s"}`;
	}
	if (toolName === "grep") {
		return `Found ${lines} match${lines === 1 ? "" : "es"}`;
	}
	if (toolName === "find") {
		return `Found ${lines} path${lines === 1 ? "" : "s"}`;
	}
	if (durationMs !== undefined && durationMs > 0) {
		const sec = (durationMs / 1000).toFixed(1);
		return `Done in ${sec}s`;
	}
	return `Done`;
}

export function formatErrorLines(
	errorText: string,
	theme: Theme,
	expanded = false,
	pad = "",
): string {
	const rawLines = errorText.trim().split("\n").filter((l) => l.trim().length > 0);
	if (rawLines.length === 0) {
		return `${pad}  ${theme.fg("error", "└ Error: Command failed")}`;
	}

	const resultLines: string[] = [];
	const first = rawLines[0]!;
	resultLines.push(`${pad}  ${theme.fg("error", `└ Error: ${first}`)}`);

	const maxDisplay = expanded ? rawLines.length : Math.min(rawLines.length, 4);
	for (let i = 1; i < maxDisplay; i++) {
		const isLast = i === rawLines.length - 1 || (!expanded && i === 3);
		const branch = isLast ? "└── " : "├── ";
		resultLines.push(`${pad}  ${theme.fg("error", `   ${branch}${rawLines[i]}`)}`);
	}
	if (!expanded && rawLines.length > 4) {
		resultLines.push(
			`${pad}  ${theme.fg("dim", `   ... (${rawLines.length - 4} more lines, ctrl+o to expand)`)}`,
		);
	}
	return resultLines.join("\n");
}
