import test from "node:test";
import assert from "node:assert/strict";
import {
	formatTurnDuration,
	formatTurnSummaryText,
	type TurnSummaryData,
} from "./turn-summary-core.ts";

test("formatTurnDuration formats seconds, minutes and hours correctly", () => {
	assert.equal(formatTurnDuration(500), "0.5s");
	assert.equal(formatTurnDuration(4200), "4.2s");
	assert.equal(formatTurnDuration(15000), "15s");
	assert.equal(formatTurnDuration(65000), "1m 5s");
	assert.equal(formatTurnDuration(120000), "2m");
	assert.equal(formatTurnDuration(3665000), "1h 1m 5s");
});

test("formatTurnSummaryText formats duration, model and effort", () => {
	const fullData: TurnSummaryData = {
		ms: 4200,
		startedAt: 1000,
		endedAt: 5200,
		model: "antigravity/gemini-3.8-flash",
		effort: "medium",
	};

	assert.equal(
		formatTurnSummaryText(fullData),
		"\u{F051B} 4.2s · antigravity/gemini-3.8-flash (medium)",
	);

	const noEffortData: TurnSummaryData = {
		ms: 1800,
		startedAt: 1000,
		endedAt: 2800,
		model: "deepseek/deepseek-flash",
	};

	assert.equal(
		formatTurnSummaryText(noEffortData),
		"\u{F051B} 1.8s · deepseek/deepseek-flash",
	);

	const offEffortData: TurnSummaryData = {
		ms: 2500,
		startedAt: 1000,
		endedAt: 3500,
		model: "cursor/default",
		effort: "off",
	};

	assert.equal(
		formatTurnSummaryText(offEffortData),
		"\u{F051B} 2.5s · cursor/default",
	);
});

test("formatTurnSummaryText respects visibility options", () => {
	const data: TurnSummaryData = {
		ms: 3200,
		startedAt: 1000,
		endedAt: 4200,
		model: "antigravity/gemini-4-argon",
		effort: "high",
	};

	assert.equal(
		formatTurnSummaryText(data, { showModel: false }),
		"\u{F051B} 3.2s",
	);

	assert.equal(
		formatTurnSummaryText(data, { showEffort: false }),
		"\u{F051B} 3.2s · antigravity/gemini-4-argon",
	);

	assert.equal(
		formatTurnSummaryText(data, { showDuration: false }),
		"antigravity/gemini-4-argon (high)",
	);
});
