import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatEffortWithFast } from "./shared.ts";
import {
	findUnknownStatusSegments,
	fitStatuslineItems,
	isExtensionStatusExcluded,
	matchesStatusPattern,
	parseSubscriptionUsageEvent,
	separatorBetweenStatuslineSegments,
	type StatuslineLayoutItem,
} from "./statusline-core.ts";

function item(
	id: string,
	width: number,
	options: Partial<StatuslineLayoutItem> = {},
): StatuslineLayoutItem {
	return {
		id,
		priority: 50,
		required: false,
		value: id,
		width,
		...options,
	};
}

test("drop-right preserves the configured prefix", () => {
	const items = [item("model", 5), item("effort", 4), item("branch", 6)];
	assert.deepEqual(
		fitStatuslineItems(items, 11, 2, "drop-right").map(({ id }) => id),
		["model", "effort"],
	);
	assert.deepEqual(
		fitStatuslineItems(items, 10, 2, "drop-right").map(({ id }) => id),
		["model"],
	);
});

test("pair-aware separators use spaces and preserve available width", () => {
	const items = [item("model", 5), item("effort", 4), item("branch", 6)];
	const separatorWidth = (
		left: StatuslineLayoutItem,
		right: StatuslineLayoutItem,
	) => separatorBetweenStatuslineSegments(left.id, right.id, "  >  ").length;
	assert.deepEqual(
		fitStatuslineItems(items, 10, separatorWidth, "drop-right").map(
			({ id }) => id,
		),
		["model", "effort"],
	);
	assert.equal(
		separatorBetweenStatuslineSegments("directory", "branch", "  >  "),
		" ",
	);
	assert.equal(
		separatorBetweenStatuslineSegments("effort", "directory", "  >  "),
		"  >  ",
	);
});

test("priority compacts low-priority items before removing them", () => {
	const items = [
		item("model", 5, { priority: 100, required: true }),
		item("cache", 6, {
			priority: 10,
			compactValue: "c",
			compactWidth: 1,
		}),
		item("context", 4, { priority: 90, required: true }),
	];
	assert.deepEqual(
		fitStatuslineItems(items, 12, 1, "priority").map(({ value }) => value),
		["model", "c", "context"],
	);
	assert.deepEqual(
		fitStatuslineItems(items, 10, 1, "priority").map(({ id }) => id),
		["model", "context"],
	);
});

test("extension status filters support exact ids and star wildcards", () => {
	assert.equal(matchesStatusPattern("mcp-kimi-cu", "mcp-*"), true);
	assert.equal(matchesStatusPattern("fast", "fast"), true);
	assert.equal(matchesStatusPattern("fast", "mcp-*"), false);
	assert.equal(
		isExtensionStatusExcluded("mcp-kimi-cu", ["fast", "mcp-*"]),
		true,
	);
});

test("Fast follows effort with the original success color, bold text, and single space", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<bold>${text}</bold>`,
	} as unknown as Theme;
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
		const color = `thinking${level[0]!.toUpperCase()}${level.slice(1)}`;
		assert.equal(
			formatEffortWithFast(theme, level, "fast"),
			`<${color}>\uF0E7</${color}> ${level} <success><bold>fast</bold></success>`,
		);
	}
	assert.equal(
		formatEffortWithFast(theme, "off", "fast"),
		"<success><bold>fast</bold></success>",
	);
	assert.equal(
		formatEffortWithFast(theme, undefined, "fast"),
		"<success><bold>fast</bold></success>",
	);
	assert.equal(
		formatEffortWithFast(theme, "xhigh", undefined),
		"<thinkingXhigh>\uF0E7</thinkingXhigh> xhigh",
	);
	assert.equal(formatEffortWithFast(theme, "off", undefined), undefined);
});

test("unknown configured segments are reported", () => {
	assert.deepEqual(
		findUnknownStatusSegments(
			["model", "missing", "context"],
			new Set(["model", "context"]),
		),
		["missing"],
	);
});

test("subscription usage event is decoded and sorted by canonical window", () => {
	const view = parseSubscriptionUsageEvent({
		v: 1,
		status: "ready",
		providerId: "any-provider",
		capturedAt: 123,
		displayMode: "used",
		windows: [
			{
				kind: "monthly",
				label: "1m",
				remainingPercent: 60,
				usedPercent: 40,
				displayPercent: 40,
				windowMinutes: 43_200,
			},
			{
				kind: "weekly",
				label: "1w",
				remainingPercent: 70,
				usedPercent: 30,
				displayPercent: 30,
				windowMinutes: 10_080,
			},
			{
				kind: "hourly",
				label: "5h",
				remainingPercent: 80,
				usedPercent: 20,
				displayPercent: 20,
				windowMinutes: 300,
				resetsAt: 1_800_000_000,
				resetCountdown: "2h13m",
			},
		],
	});
	assert.deepEqual(
		view?.windows.map((window) => window.label),
		["5h", "1w", "1m"],
	);
	assert.equal(view?.displayMode, "used");
	assert.deepEqual(
		view?.windows.map((window) => window.displayPercent),
		[20, 30, 40],
	);
	assert.equal(view?.windows[0]?.resetsAt, 1_800_000_000);
	assert.equal(view?.windows[0]?.resetCountdown, "2h13m");
	assert.equal(view?.windows[1]?.resetCountdown, undefined);
	assert.equal(
		parseSubscriptionUsageEvent({ v: 1, status: "unavailable" }),
		undefined,
	);
});

test("legacy subscription usage events default to remaining display", () => {
	const view = parseSubscriptionUsageEvent({
		v: 1,
		status: "ready",
		providerId: "legacy-provider",
		capturedAt: 123,
		windows: [
			{
				kind: "hourly",
				label: "5h",
				remainingPercent: 80,
			},
		],
	});
	assert.equal(view?.displayMode, "remaining");
	assert.equal(view?.windows[0]?.usedPercent, 20);
	assert.equal(view?.windows[0]?.displayPercent, 80);
});

test("malformed reset countdowns are dropped without hiding the window", () => {
	const view = parseSubscriptionUsageEvent({
		v: 1,
		status: "ready",
		providerId: "openai-codex",
		capturedAt: 123,
		windows: [
			{
				kind: "hourly",
				label: "5h",
				remainingPercent: 80,
				resetCountdown: "\u001B[31m\u001B[0m",
			},
			{
				kind: "weekly",
				label: "1w",
				remainingPercent: 70,
				resetCountdown: "x".repeat(17),
			},
			{
				kind: "monthly",
				label: "1m",
				remainingPercent: 60,
				resetCountdown: 42,
			},
		],
	});
	assert.deepEqual(
		view?.windows.map((window) => [window.label, window.resetCountdown]),
		[
			["5h", undefined],
			["1w", undefined],
			["1m", undefined],
		],
	);
});
