import test from "node:test";
import assert from "node:assert/strict";
import { formatCountdown } from "./auth-helper.ts";
import { buildQuotaWindow } from "./adapters/base.ts";
import { AdapterRegistry } from "./registry.ts";
import {
	ANTIGRAVITY_3P_MODELS,
	ANTIGRAVITY_ARGON_MODELS,
	ANTIGRAVITY_GEMINI_MODELS,
	buildAntigravityModelFallbackWindows,
	buildAntigravityWindows,
} from "./adapters/antigravity.ts";
import { formatQuotaReport } from "./format.ts";
import {
	QuotaScheduler,
	SUBSCRIPTION_USAGE_EVENT,
	matchQuotaWindow,
	matchQuotaWindowsForModel,
} from "./scheduler.ts";
import type { ProviderQuotaReport, QuotaWindow } from "./types.ts";

test("formatCountdown formats ms into compact countdowns", () => {
	assert.equal(formatCountdown(30_000), "30s");
	assert.equal(formatCountdown(59_000), "59s");
	assert.equal(formatCountdown(60_000), "1m");
	assert.equal(formatCountdown(3_600_000), "1h");
	assert.equal(formatCountdown(5_400_000), "1h30m");
	assert.equal(formatCountdown(23 * 3_600_000 + 15 * 60_000), "23h15m");
	assert.equal(formatCountdown(24 * 3_600_000), "1d");
	assert.equal(formatCountdown(26 * 3_600_000), "1d2h");
	assert.equal(formatCountdown(157 * 3_600_000 + 47 * 60_000), "6d13h");
});

test("buildQuotaWindow clamps percentages and computes countdown", () => {
	const win = buildQuotaWindow({
		kind: "rolling",
		label: "Test Window",
		remainingPercent: 120, // should clamp to 100
		resetsAt: Date.now() + 1800_000,
	});

	assert.equal(win.remainingPercent, 100);
	assert.equal(win.usedPercent, 0);
	assert.equal(win.kind, "rolling");
	assert.ok(win.resetCountdown?.includes("m"));
});

test("AdapterRegistry correctly routes providers to adapters", () => {
	const registry = new AdapterRegistry();

	const antigravity = registry.findAdapterForProvider("antigravity");
	assert.ok(antigravity);
	assert.equal(antigravity.id, "antigravity");

	const gpt = registry.findAdapterForProvider("openai-codex");
	assert.ok(gpt);
	assert.equal(gpt.id, "gpt");

	const claude = registry.findAdapterForProvider("claude");
	assert.ok(claude);
	assert.equal(claude.id, "claude");

	const grok = registry.findAdapterForProvider("xai");
	assert.ok(grok);
	assert.equal(grok.id, "grok");

	const unknown = registry.findAdapterForProvider("some-non-existent-provider");
	assert.equal(unknown, undefined);
});

test("Antigravity maps all three quota-summary groups onto windows", () => {
	const resetsAt = Date.now() + 3600_000;
	const windows = buildAntigravityWindows(
		[
			{
				displayName: "Gemini Models",
				buckets: [
					{
						bucketId: "gemini-weekly",
						displayName: "Weekly Limit Remaining",
						window: "weekly",
						resetTime: new Date(resetsAt).toISOString(),
						remainingFraction: 0.85,
					},
					{
						bucketId: "gemini-5h",
						displayName: "Five Hour Limit Remaining",
						window: "5h",
						resetTime: new Date(resetsAt).toISOString(),
						remainingFraction: 0.68,
					},
				],
			},
			{
				displayName: "Claude and GPT models",
				buckets: [
					{
						bucketId: "3p-weekly",
						displayName: "Weekly Limit Remaining",
						window: "weekly",
						resetTime: new Date(resetsAt).toISOString(),
						remainingFraction: 0.42,
					},
					{
						bucketId: "3p-5h",
						displayName: "Five Hour Limit Remaining",
						window: "5h",
						resetTime: new Date(resetsAt).toISOString(),
						remainingFraction: 0.8,
					},
				],
			},
			{
				displayName: "Gemini 4 Argon",
				buckets: [
					{
						bucketId: "gemini-argon-wtu-weekly",
						displayName: "Gemini 4 Argon Weekly Limit",
						window: "weekly",
						resetTime: new Date(resetsAt).toISOString(),
						remainingFraction: 0.65,
					},
				],
			},
		],
		resetsAt,
	);

	assert.equal(windows.length, 5);
	assert.equal(
		windows.filter((w) => w.groupId === ANTIGRAVITY_GEMINI_MODELS).length,
		2,
	);
	assert.equal(
		windows.filter((w) => w.groupId === ANTIGRAVITY_3P_MODELS).length,
		2,
	);
	assert.equal(
		windows.filter((w) => w.groupId === ANTIGRAVITY_ARGON_MODELS).length,
		1,
	);

	const geminiLabels = windows
		.filter((w) => w.groupId === ANTIGRAVITY_GEMINI_MODELS)
		.map((w) => w.label)
		.sort();
	assert.deepEqual(geminiLabels, ["1w", "Gemini 5h"]);

	const argon = windows.find((w) => w.groupId === ANTIGRAVITY_ARGON_MODELS);
	assert.equal(argon?.remainingPercent, 65);
	assert.equal(argon?.label, "Argon 1w");

	const fallback = buildAntigravityModelFallbackWindows(
		{
			"gemini-3-8-flash": {
				displayName: "Gemini 3.8 Flash",
				quotaInfo: { remainingFraction: 0.85 },
			},
			"gemini-4-argon-high": {
				displayName: "Gemini 4 Argon (High)",
				quotaInfo: { remainingFraction: 0.65 },
			},
		},
		resetsAt,
	);
	assert.equal(fallback.length, 2);
});

test("Antigravity does not fabricate windows when the summary has no data", () => {
	const resetsAt = Date.now();
	assert.deepEqual(buildAntigravityWindows([], resetsAt), []);
	assert.deepEqual(
		buildAntigravityWindows([{ displayName: "Claude and GPT models", buckets: [] }], resetsAt),
		[],
	);
	// A bucket without a usable fraction must not be reported as 100% remaining.
	assert.deepEqual(
		buildAntigravityWindows(
			[
				{
					displayName: "Gemini Models",
					buckets: [{ bucketId: "g-weekly", window: "weekly" }],
				},
			],
			resetsAt,
		),
		[],
	);
});

test("model matching attributes windows to the right group or nothing", () => {
	const windows: QuotaWindow[] = [
		buildQuotaWindow({
			kind: "weekly",
			label: "Gemini",
			groupId: "gemini-models",
			modelKeys: ["gemini-flash", "gemini-pro", "gemini-3", "gemini-2", "gemini"],
			remainingPercent: 55,
		}),
		buildQuotaWindow({
			kind: "weekly",
			label: "Argon",
			groupId: "gemini-argon",
			modelKeys: ["argon", "gemini-4-argon", "gemini-4"],
			remainingPercent: 70,
		}),
		buildQuotaWindow({
			kind: "hourly",
			label: "Claude 5h",
			groupId: "claude-and-gpt-models",
			modelKeys: ["claude", "gpt"],
			remainingPercent: 90,
			windowMinutes: 300,
		}),
		buildQuotaWindow({
			kind: "weekly",
			label: "Claude 1w",
			groupId: "claude-and-gpt-models",
			modelKeys: ["claude", "gpt"],
			remainingPercent: 88,
		}),
	];

	assert.equal(matchQuotaWindow(windows, "gemini-3.8-flash")?.groupId, "gemini-models");
	assert.equal(matchQuotaWindow(windows, "gemini-4-argon")?.groupId, "gemini-argon");
	assert.deepEqual(
		matchQuotaWindowsForModel(windows, "claude-opus-5-5").map((w) => w.label),
		["Claude 5h", "Claude 1w"],
	);

	// Unknown models (e.g. cursor / deepseek) must not inherit another group's quota.
	assert.deepEqual(matchQuotaWindowsForModel(windows, "composer-2.5"), []);
	assert.deepEqual(matchQuotaWindowsForModel(windows, "deepseek-v4-pro"), []);
	assert.equal(matchQuotaWindow(windows, "composer-2.5"), undefined);
});

test("statusline events clear the display for unknown providers and models", async () => {
	const windows: QuotaWindow[] = [
		buildQuotaWindow({
			kind: "weekly",
			label: "Argon",
			groupId: "gemini-argon",
			modelKeys: ["argon", "gemini-4-argon", "gemini-4"],
			remainingPercent: 70,
		}),
		buildQuotaWindow({
			kind: "weekly",
			label: "Gemini",
			groupId: "gemini-models",
			modelKeys: ["gemini"],
			remainingPercent: 55,
		}),
	];
	const report: ProviderQuotaReport = {
		providerId: "known",
		displayName: "Known Provider",
		capturedAt: Date.now(),
		primaryWindow: windows[0]!,
		windows,
	};
	const events: any[] = [];
	const pi = { events: { emit: (name: string, data: unknown) => events.push({ name, data }) } };
	const registry = new AdapterRegistry();
	// Replace built-in adapters with one controllable test adapter.
	for (const adapter of registry.list()) {
		registry.register({ ...adapter, supportedProviders: ["__none__"] });
	}
	registry.register({
		id: "known",
		displayName: "Known Provider",
		supportedProviders: ["known"],
		isConfigured: () => true,
		fetchQuota: async () => report,
	});
	const scheduler = new QuotaScheduler(pi as any, registry, { cacheTtlMs: 0 });

	// Unknown provider (e.g. cursor): emit a non-ready status instead of keeping stale data.
	const result = await scheduler.refreshActiveProvider({
		model: { provider: "cursor", id: "composer-2.5" },
	} as any);
	assert.equal(result, undefined);
	assert.equal(events.at(-1)?.name, SUBSCRIPTION_USAGE_EVENT);
	assert.equal(events.at(-1)?.data.status, "unavailable");
	assert.deepEqual(events.at(-1)?.data.windows, []);

	// Known provider but unmatched model: no window describes it, so clear as well.
	await scheduler.refreshActiveProvider({
		model: { provider: "known", id: "some-unrelated-model" },
	} as any);
	assert.equal(events.at(-1)?.data.status, "unavailable");

	// Known provider and matching model: broadcast remaining quota.
	await scheduler.refreshActiveProvider({
		model: { provider: "known", id: "gemini-4-argon" },
	} as any);
	assert.equal(events.at(-1)?.data.status, "ready");
	assert.deepEqual(
		events.at(-1)?.data.windows.map((w: QuotaWindow) => w.label),
		["Argon"],
	);
});

test("formatQuotaReport renders grouped sections and progress bars", () => {
	const output = formatQuotaReport({
		providerId: "antigravity",
		displayName: "Google Antigravity",
		planName: "Google AI Pro",
		accountEmail: "tester@example.com",
		capturedAt: Date.now(),
		primaryWindow: {
			kind: "weekly",
			label: "Gemini",
			groupId: "gemini-models",
			groupLabel: "Gemini Models",
			remainingPercent: 12,
		},
		windows: [
			{
				kind: "weekly",
				label: "Gemini",
				groupId: "gemini-models",
				groupLabel: "Gemini Models",
				windowMinutes: 10080,
				remainingPercent: 12,
			},
			{
				kind: "hourly",
				label: "Claude 5h",
				groupId: "claude-and-gpt-models",
				groupLabel: "Claude and GPT models",
				windowMinutes: 300,
				remainingPercent: 100,
			},
		],
	}, "gemini-3.8-flash");

	// Verify group headers
	assert.ok(output.includes("Gemini Models:"));
	assert.ok(output.includes("Claude and GPT models:"));
	// Verify progress bar blocks
	assert.ok(output.includes("█"));
	assert.ok(output.includes("░"));
	// Verify account and plan details
	assert.ok(output.includes("Account:"));
	assert.ok(output.includes("Google AI Pro"));
	assert.ok(output.includes("tester@example.com"));
});
