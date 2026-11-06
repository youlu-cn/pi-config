import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface CacheUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CacheHitRates {
	current?: number;
	rolling5?: number;
	session?: number;
}

export interface Stats {
	input: number;
	output: number;
	cacheHitRates: CacheHitRates;
}

function tokenWeightedHitRate(usages: readonly CacheUsage[]): number | undefined {
	let cacheRead = 0;
	let promptTokens = 0;
	for (const usage of usages) {
		cacheRead += usage.cacheRead;
		promptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
	}
	return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
}

/** Read-only projection of public session entries; no IO or retained state.
 * Pi 0.86 exposes entries, not footer totals, to extensions. Keep the billable
 * entry selection aligned with its native footer. Costs come from recorded
 * usage, never local pricing. Cache rates are an assistant-only display metric.
 */
export function collectStats(entries: readonly SessionEntry[]): Stats {
	const stats: Stats = { input: 0, output: 0, cacheHitRates: {} };
	const assistantUsages: CacheUsage[] = [];
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (entry.type === "usage") {
			usage = entry.usage;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			usage = entry.message.usage;
			if (usage) assistantUsages.push(usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			usage = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			usage = entry.usage;
		}
		if (!usage) continue;
		stats.input += usage.input;
		stats.output += usage.output;
	}
	const current = tokenWeightedHitRate(assistantUsages.slice(-1));
	const rolling5 = tokenWeightedHitRate(assistantUsages.slice(-5));
	const session = tokenWeightedHitRate(assistantUsages);
	stats.cacheHitRates = {
		...(current === undefined ? {} : { current }),
		...(rolling5 === undefined ? {} : { rolling5 }),
		...(session === undefined ? {} : { session }),
	};
	return stats;
}
