import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	formatTurnSummaryText,
	LEGACY_TURN_DURATION_TYPE,
	TURN_SUMMARY_TYPE,
	type TurnSummaryData,
	type TurnSummaryOptions,
} from "./turn-summary-core.ts";

export { formatTurnDuration, formatTurnSummaryText, TURN_SUMMARY_TYPE } from "./turn-summary-core.ts";
export type { TurnSummaryData, TurnSummaryOptions } from "./turn-summary-core.ts";

export function registerTurnSummary(
	pi: ExtensionAPI,
	options: TurnSummaryOptions = {},
): void {
	let enabledForSession = false;
	let startedAt: number | undefined;
	let lastCompleted: TurnSummaryData | undefined;
	let pendingCompaction: TurnSummaryData | undefined;
	let continueAfterCompaction = false;

	const reset = () => {
		startedAt = undefined;
		lastCompleted = undefined;
		pendingCompaction = undefined;
		continueAfterCompaction = false;
	};

	const markStart = () => {
		if (!enabledForSession || startedAt !== undefined) return;
		startedAt =
			continueAfterCompaction && pendingCompaction
				? pendingCompaction.startedAt
				: Date.now();
		pendingCompaction = undefined;
		continueAfterCompaction = false;
	};

	const emit = (endedAt: number, ctx: ExtensionContext) => {
		if (startedAt === undefined) return;

		let model: string | undefined;
		if (ctx.model) {
			model = ctx.model.provider
				? `${ctx.model.provider}/${ctx.model.id}`
				: ctx.model.id;
		}

		let effort: string | undefined;
		try {
			const thinkingLevel = pi.getThinkingLevel();
			if (thinkingLevel && thinkingLevel !== "off") {
				effort = thinkingLevel;
			}
		} catch {
			// Ignore if getThinkingLevel is not available or throws
		}

		const completed: TurnSummaryData = {
			ms: Math.max(0, endedAt - startedAt),
			startedAt,
			endedAt,
			model,
			effort,
		};

		startedAt = undefined;
		lastCompleted = completed;
		pi.appendEntry<TurnSummaryData>(TURN_SUMMARY_TYPE, completed);
	};

	const renderSummary = (entry: { data?: TurnSummaryData }, theme: any) => {
		const data = entry.data;
		if (!data) return new Text("", 0, 0);
		const formatted = formatTurnSummaryText(data, options);
		return new Text(theme.fg("dim", formatted), 0, 0);
	};

	// 注册当前 turn-summary 渲染器
	pi.registerEntryRenderer<TurnSummaryData>(TURN_SUMMARY_TYPE, (entry, _options, theme) =>
		renderSummary(entry, theme),
	);

	// 向后兼容旧 session 中保存的 turn-duration 历史条目
	pi.registerEntryRenderer<TurnSummaryData>(
		LEGACY_TURN_DURATION_TYPE,
		(entry, _options, theme) => renderSummary(entry, theme),
	);

	pi.on("session_start", (_event, ctx) => {
		reset();
		enabledForSession = ctx.mode === "tui";
	});

	pi.on("input", (event) => {
		if (!enabledForSession) return;
		continueAfterCompaction =
			pendingCompaction !== undefined && event.source === "extension";
		if (!continueAfterCompaction) pendingCompaction = undefined;
	});
	pi.on("before_agent_start", () => markStart());
	pi.on("agent_start", () => markStart());

	pi.on("agent_settled", (_event, ctx) => {
		const endedAt = startedAt === undefined ? undefined : Date.now();
		if (endedAt === undefined || !ctx.isIdle()) return;
		emit(endedAt, ctx);
	});

	pi.on("session_compact", () => {
		if (!enabledForSession) return;
		pendingCompaction = startedAt === undefined ? lastCompleted : undefined;
	});

	pi.on("session_shutdown", () => {
		enabledForSession = false;
		reset();
	});
}
