import test from "node:test";
import assert from "node:assert/strict";
import {
	currentTtftMs,
	displayTokenRate,
	formatTokenCount,
	formatTokenRate,
	markFirstToken,
	recordProviderUsage,
	resetTokenRate,
	sampleTokenDelta,
	totalTokens,
} from "./token-rate.ts";

test("formatTokenCount abbreviates large values", () => {
	assert.equal(formatTokenCount(42), "42");
	assert.equal(formatTokenCount(1500), "1.5k");
	assert.equal(formatTokenCount(25_000), "25k");
});

test("token rate accumulates deltas and records TTFT", () => {
	resetTokenRate(1_000);
	assert.equal(totalTokens(), 0);
	assert.equal(currentTtftMs(), 0);

	markFirstToken(1_200);
	assert.equal(currentTtftMs(), 200);

	sampleTokenDelta("hello world", 1_500);
	assert.ok(totalTokens() > 0);

	recordProviderUsage(100, 2_000, true);
	assert.equal(totalTokens(), 100);
	assert.ok(displayTokenRate("average") > 0);

	const text = formatTokenRate(displayTokenRate("average"), currentTtftMs(), "average", true);
	assert.ok(text.includes("tok/s"));
	assert.ok(text.includes("TTFT"));
});
