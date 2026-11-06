import type { ProviderQuotaReport, QuotaWindow } from "./types.ts";

const BAR_SEGMENTS = 12;

function isWideCodePoint(code: number): boolean {
	return (
		code >= 0x1100 &&
		(code <= 0x115f ||
			code === 0x2329 ||
			code === 0x232a ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x20000 && code <= 0x3fffd))
	);
}

function displayWidth(str: string): number {
	let width = 0;
	for (const char of str) {
		width += isWideCodePoint(char.codePointAt(0) || 0) ? 2 : 1;
	}
	return width;
}

function padEnd(str: string, width: number): string {
	const current = displayWidth(str);
	if (current >= width) return str;
	return str + " ".repeat(width - current);
}

function formatReset(resetsAt?: number): string {
	if (!resetsAt || resetsAt <= 0) return "";
	const d = new Date(resetsAt);
	if (isNaN(d.getTime())) return "";
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const h = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${m}/${day} ${h}:${min}`;
}

function renderProgressBar(percent: number, segments = BAR_SEGMENTS): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * segments);
	return "█".repeat(filled) + "░".repeat(segments - filled);
}

function windowDurationMinutes(w: QuotaWindow): number {
	if (typeof w.windowMinutes === "number" && w.windowMinutes > 0) {
		return w.windowMinutes;
	}
	if (w.kind === "hourly") return 60;
	if (w.kind === "daily") return 1440;
	if (w.kind === "weekly") return 10080;
	if (w.kind === "monthly") return 43200;
	return Number.POSITIVE_INFINITY;
}

function getWindowRowLabel(w: QuotaWindow): string {
	if (w.windowMinutes) {
		if (w.windowMinutes === 10080 || w.kind === "weekly") return "1w Window";
		if (w.windowMinutes === 43200 || w.kind === "monthly") return "1m Window";
		if (w.windowMinutes % 60 === 0) return `${w.windowMinutes / 60}h Window`;
		return `${w.windowMinutes}m Window`;
	}
	if (w.kind === "weekly") return "1w Window";
	if (w.kind === "hourly") return "Hourly Window";
	if (w.kind === "daily") return "Daily Window";
	if (w.kind === "rolling") return "Rolling Window";
	return w.label || "Quota";
}

interface GroupEntry {
	id: string;
	heading: string;
	windows: QuotaWindow[];
}

export function formatQuotaReport(
	report: ProviderQuotaReport,
	activeModelId?: string,
): string {
	const groupsMap = new Map<string, GroupEntry>();

	for (const w of report.windows) {
		const gId = w.groupId || "default";
		const gLabel =
			w.groupLabel ||
			(gId === "gemini-models"
				? "Gemini Models"
				: gId === "claude-and-gpt-models"
					? "Claude and GPT models"
					: gId === "gemini-argon"
						? "Gemini 4 Argon"
						: "Quota Windows");

		let entry = groupsMap.get(gId);
		if (!entry) {
			entry = { id: gId, heading: gLabel, windows: [] };
			groupsMap.set(gId, entry);
		}
		entry.windows.push(w);
	}

	// 组内窗口排序：更短的周期在前（如 5h 在 1w 之前）
	for (const entry of groupsMap.values()) {
		entry.windows.sort((a, b) => windowDurationMinutes(a) - windowDurationMinutes(b));
	}

	const groupsList = Array.from(groupsMap.values());

	// 组间排序：当前模型匹配的组优先置顶
	const normModel = (activeModelId || "").toLowerCase();
	groupsList.sort((a, b) => {
		const aMatch = a.windows.some((w) =>
			(w.modelKeys || []).some((k) => normModel.includes(k.toLowerCase())),
		);
		const bMatch = b.windows.some((w) =>
			(w.modelKeys || []).some((k) => normModel.includes(k.toLowerCase())),
		);
		if (aMatch && !bMatch) return -1;
		if (!aMatch && bMatch) return 1;
		return a.heading.localeCompare(b.heading);
	});

	// 计算最大标签对齐宽度
	let maxLabelWidth = 0;
	for (const g of groupsList) {
		for (const w of g.windows) {
			maxLabelWidth = Math.max(maxLabelWidth, displayWidth(getWindowRowLabel(w)));
		}
	}
	if (report.planName) maxLabelWidth = Math.max(maxLabelWidth, displayWidth("Plan"));
	if (report.accountEmail) maxLabelWidth = Math.max(maxLabelWidth, displayWidth("Email"));

	const lines: string[] = [report.displayName];

	// 输出各个分组与进度条
	for (const g of groupsList) {
		lines.push("");
		lines.push(`  ${g.heading}:`);
		for (const w of g.windows) {
			const label = padEnd(getWindowRowLabel(w), maxLabelWidth);
			const bar = renderProgressBar(w.remainingPercent);
			const pct = `${String(w.remainingPercent).padStart(3)}% left`;
			const resetTimeStr = w.resetsAt ? ` · resets ${formatReset(w.resetsAt)}` : "";
			const countdownStr = w.resetCountdown ? ` (${w.resetCountdown})` : "";
			lines.push(`    ${label}  ${bar}  ${pct}${resetTimeStr}${countdownStr}`);
		}
	}

	// 账号与套餐信息
	if (report.planName || report.accountEmail) {
		lines.push("");
		lines.push("  Account:");
		if (report.planName) {
			lines.push(`    ${padEnd("Plan", maxLabelWidth)}  ${report.planName}`);
		}
		if (report.accountEmail) {
			lines.push(`    ${padEnd("Email", maxLabelWidth)}  ${report.accountEmail}`);
		}
	}

	return lines.join("\n");
}
