import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectStats } from "./statusline-usage.ts";

function usage(input = 100, output = 10, cacheRead = 300) {
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead };
}
function entries(values: unknown[]): SessionEntry[] {
	return values as SessionEntry[];
}
function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value)) freeze(child);
	}
}

test("includes all native billable entry types without changing recorded data", () => {
	const source = entries([
		{ type: "message", message: { role: "assistant", usage: usage() } },
		{ type: "message", message: { role: "toolResult", usage: usage() } },
		{ type: "compaction", usage: usage() },
		{ type: "branch_summary", usage: usage() },
		{ type: "usage", kind: "cache_warm", usage: usage() },
		{ type: "usage", kind: "future_kind", usage: usage() },
		{ type: "message", message: { role: "user", content: "hello" } },
		{ type: "message", message: { role: "toolResult" } },
		{ type: "compaction" },
	]);
	const before = JSON.stringify(source);
	freeze(source);
	const result = collectStats(source);
	assert.deepEqual(result, { input: 600, output: 60,
		cacheHitRates: { current: 75, rolling5: 75, session: 75 } });
	assert.equal(JSON.stringify(source), before);
	assert.deepEqual(collectStats(source), result);
});

test("standalone usage changes totals, not assistant cache-rate semantics", () => {
	assert.deepEqual(collectStats(entries([{ type: "usage", usage: usage() }])),
		{ input: 100, output: 10, cacheHitRates: {} });
	assert.deepEqual(collectStats([]), { input: 0, output: 0, cacheHitRates: {} });
});

test("cache rates remain token weighted with a five-assistant rolling window", () => {
	const source = entries([
		{ type: "message", message: { role: "assistant", usage: usage(0, 0, 900) } },
		...Array.from({ length: 5 }, () => ({ type: "message", message: { role: "assistant", usage: usage(100, 0, 0) } })),
		{ type: "usage", usage: usage(100000, 1, 100000) },
	]);
	assert.deepEqual(collectStats(source).cacheHitRates,
		{ current: 0, rolling5: 0, session: 900 / 1400 * 100 });
});
