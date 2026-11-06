import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionUiConfig } from "./config.ts";
import {
	ellipsize,
	sanitizeTerminalText,
	textOf,
	type TextResult,
} from "./shared.ts";
import {
	type ActivityRow,
	type ActivityStatus,
	ActivityTree,
	type CallCount,
} from "./tool-activity-core.ts";

const WIDGET_ID = "session-ui:tool-activity";

interface ToolActivity {
	action: string;
	detail: string;
	status: ActivityStatus;
	summary?: string;
}

interface ToolPresentation {
	action: string;
	detail: string;
}

interface ToolPresenter {
	matches(name: string): boolean;
	present(args: Record<string, unknown>): ToolPresentation;
}

function stringArg(
	args: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathDetail(args: Record<string, unknown>, fallback = "."): string {
	return ellipsize(stringArg(args, "path") ?? fallback, 64);
}

function namedPresenter(
	names: readonly string[],
	action: string,
	detail: (args: Record<string, unknown>) => string,
): ToolPresenter {
	const accepted = new Set(names);
	return {
		matches: (name) => accepted.has(name),
		present: (args) => ({ action, detail: detail(args) }),
	};
}

const PRESENTERS: readonly ToolPresenter[] = [
	namedPresenter(["read", "ls"], "Inspect", (args) => pathDetail(args)),
	namedPresenter(["grep", "find"], "Search", (args) => {
		const pattern = stringArg(args, "pattern") ?? stringArg(args, "query") ?? "";
		const where = stringArg(args, "path") ?? stringArg(args, "glob");
		const target = pattern ? ellipsize(pattern, 48) : "items";
		return where ? `${target} in ${ellipsize(where, 48)}` : target;
	}),
	namedPresenter(["bash"], "Run", (args) =>
		ellipsize(stringArg(args, "command") ?? "command", 90),
	),
	namedPresenter(["edit", "write"], "Change", (args) => pathDetail(args)),
	// The script body is not a useful one-line detail; nested calls carry the detail.
	namedPresenter(["codemode"], "Codemode", () => ""),
];

function titleCaseToolName(name: string): string {
	return (
		name
			.split(/[-_.:/]+/)
			.flatMap((part) =>
				part ? [`${part[0]?.toUpperCase()}${part.slice(1)}`] : [],
			)
			.join(" ") || "Tool"
	);
}

function genericDetail(args: Record<string, unknown>): string {
	for (const key of ["path", "command", "query", "pattern", "url", "name"]) {
		const value = stringArg(args, key);
		if (value) return ellipsize(value, key === "command" ? 90 : 64);
	}
	const keys = Object.keys(args);
	return keys.length > 0 ? keys.slice(0, 3).join(", ") : "";
}

function presentTool(
	name: string,
	args: Record<string, unknown> | undefined,
): ToolPresentation {
	const safeArgs = args ?? {};
	const presenter = PRESENTERS.find((candidate) => candidate.matches(name));
	if (presenter) return presenter.present(safeArgs);
	return {
		action: titleCaseToolName(name),
		detail: genericDetail(safeArgs),
	};
}

function statusGlyph(theme: Theme, status: ActivityStatus): string {
	if (status === "error") return theme.fg("error", "✗");
	if (status === "running") return theme.fg("warning", "◆");
	return theme.fg("success", "◇");
}

function statusColor(status: ActivityStatus): ThemeColor {
	if (status === "error") return "error";
	if (status === "running") return "warning";
	return "success";
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function callCountText(calls: CallCount): string {
	return calls.failed > 0
		? `${plural(calls.total, "call")}, ${calls.failed} failed`
		: plural(calls.total, "call");
}

function renderRow(row: ActivityRow<ToolActivity>, theme: Theme): string {
	// Nested rows hang off their top-level call; the group's last row closes the branch.
	const prefix = row.nested ? theme.fg("dim", `${row.last ? "└" : "├"} `) : "";
	if (row.kind === "more") {
		return `${prefix}${theme.fg("dim", `… ${plural(row.count, "earlier call")}`)}`;
	}
	const activity = row.value;
	const detail = activity.detail
		? ` ${theme.fg("accent", activity.detail)}`
		: "";
	const calls =
		!row.nested && row.calls
			? theme.fg(row.calls.failed > 0 ? "error" : "dim", ` · ${callCountText(row.calls)}`)
			: "";
	const summary = activity.summary
		? theme.fg(statusColor(activity.status), ` · ${activity.summary}`)
		: "";
	return `${prefix}${statusGlyph(theme, activity.status)} ${theme.fg("toolTitle", theme.bold(activity.action))}${detail}${calls}${summary}`;
}

function renderActivities(
	activities: ActivityTree<ToolActivity>,
	theme: Theme,
	width: number,
	maxItems: number,
): string[] {
	if (width <= 0) return [];
	const { rows, running, failed, hidden } = activities.layout(maxItems);
	if (rows.length === 0) return [];
	const titleParts = [
		running > 0 ? `${running} running` : "tools",
		failed > 0 ? `${failed} failed` : "",
		hidden > 0 ? `${hidden} hidden` : "",
	].filter(Boolean);
	const lines = [
		theme.fg("dim", `Activity · ${titleParts.join(" · ")}`),
		...rows.map((row) => renderRow(row, theme)),
	];
	return lines.map((line) => truncateToWidth(line, width));
}

function resultSummary(
	result: TextResult | undefined,
	isError: boolean,
): string | undefined {
	const firstLine = sanitizeTerminalText(textOf(result).split("\n")[0] ?? "");
	if (isError) return ellipsize(firstLine || "failed", 72);
	return firstLine ? ellipsize(firstLine, 48) : undefined;
}

/**
 * Projects tool lifecycle events into an ephemeral activity widget.
 * It deliberately does not re-register tools, so execution, provenance,
 * --no-builtin-tools, remote operations and third-party overrides remain intact.
 */
export function registerToolActivity(
	pi: ExtensionAPI,
	config: SessionUiConfig["toolActivity"],
): void {
	const activities = new ActivityTree<ToolActivity>();
	let requestRender: (() => void) | undefined;
	let activeContext: ExtensionContext | undefined;

	const refresh = () => requestRender?.();
	const reset = () => {
		activities.clear();
		refresh();
	};

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		reset();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET_ID,
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					render: (width: number) =>
						renderActivities(activities, theme, width, config.maxItems),
					invalidate() {},
				};
			},
			{ placement: config.placement },
		);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		activeContext = ctx;
		const name = event.toolName || "tool";
		const presentation = presentTool(
			name,
			event.args as Record<string, unknown> | undefined,
		);
		activities.start(
			event.toolCallId,
			{ ...presentation, status: "running" },
			event.parentToolCallId,
		);
		refresh();
	});

	pi.on("tool_execution_update", (event) => {
		const activity = activities.get(event.toolCallId);
		if (!activity) return;
		activity.summary = resultSummary(event.partialResult as TextResult, false);
		refresh();
	});

	pi.on("tool_execution_end", (event) => {
		const activity = activities.get(event.toolCallId);
		if (!activity) return;
		activity.status = event.isError ? "error" : "done";
		activity.summary = resultSummary(event.result as TextResult, event.isError);
		refresh();
	});

	pi.on("turn_end", () => {
		reset();
	});

	pi.on("session_shutdown", () => {
		if (activeContext?.hasUI && activeContext.mode === "tui") {
			activeContext.ui.setWidget(WIDGET_ID, undefined);
		}
		requestRender = undefined;
		activeContext = undefined;
		reset();
	});
}
