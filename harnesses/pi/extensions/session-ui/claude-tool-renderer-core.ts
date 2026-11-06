import { isAbsolute, relative } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";

export function formatGeminiDots(
	step: number,
	theme: Theme,
	total = 3,
): string {
	const count = Math.max(2, total);
	const cycle = (count - 1) * 2;
	const pos = Math.abs(step) % cycle;
	const activeIndex = pos < count ? pos : cycle - pos;

	const parts: string[] = [];
	for (let i = 0; i < count; i++) {
		if (i === activeIndex) {
			parts.push(theme.fg("accent", "●"));
		} else {
			parts.push(theme.fg("dim", "·"));
		}
	}
	return parts.join(" ");
}

export const SPINNER_FRAMES = ["0", "1", "2", "1"];

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
): string {
	let icon: string;
	if (!isDone) {
		icon = `${formatGeminiDots(animStep, theme, 3)} `;
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
		paramSummary = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
	} else if (toolName === "edit") {
		displayName = "Edit";
		paramSummary = formatPath(args?.path, cwd);
	} else if (toolName === "write") {
		displayName = "Write";
		paramSummary = formatPath(args?.path, cwd);
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
					paramSummary = val.length > 50 ? `${val.slice(0, 47)}...` : val;
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
		const editsCount = Array.isArray(args?.edits) ? args.edits.length : 1;
		return `${editsCount} replacement${editsCount === 1 ? "" : "s"} applied`;
	}
	if (toolName === "write") {
		return `Wrote ${lines} line${lines === 1 ? "" : "s"}`;
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
