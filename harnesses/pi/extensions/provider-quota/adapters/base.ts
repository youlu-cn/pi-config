import { formatCountdown } from "../auth-helper.ts";
import type { QuotaWindow, QuotaWindowKind } from "../types.ts";

export function buildQuotaWindow(options: {
	kind: QuotaWindowKind;
	label: string;
	remainingPercent: number;
	usedPercent?: number;
	windowMinutes?: number;
	resetsAt?: number;
	used?: number;
	limit?: number;
}): QuotaWindow {
	const remainingPercent = Math.max(0, Math.min(100, options.remainingPercent));
	const usedPercent =
		options.usedPercent !== undefined
			? Math.max(0, Math.min(100, options.usedPercent))
			: 100 - remainingPercent;

	let resetCountdown: string | undefined;
	if (options.resetsAt && options.resetsAt > Date.now()) {
		resetCountdown = formatCountdown(options.resetsAt - Date.now());
	}

	return {
		kind: options.kind,
		label: options.label,
		remainingPercent,
		usedPercent,
		displayPercent: remainingPercent,
		windowMinutes: options.windowMinutes,
		resetsAt: options.resetsAt,
		resetCountdown,
		used: options.used,
		limit: options.limit,
	};
}
