import test from "node:test";
import assert from "node:assert/strict";
import { formatCountdown } from "./auth-helper.ts";
import { buildQuotaWindow } from "./adapters/base.ts";
import { ClaudeAdapter } from "./adapters/claude.ts";
import { AdapterRegistry } from "./registry.ts";
import {
	ANTIGRAVITY_3P_MODELS,
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
import type { ProviderAdapter, ProviderQuotaReport, QuotaWindow } from "./types.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function testReport(providerId = "test-a", keys = ["alpha"]): ProviderQuotaReport {
	const window = buildQuotaWindow({
		kind: "weekly", groupId: "test", label: keys[0]!, modelKeys: keys, remainingPercent: 42,
	});
	return { providerId, displayName: providerId, capturedAt: Date.now(), primaryWindow: window, windows: [window] };
}

function testScheduler(adapters: ProviderAdapter[], cacheTtlMs = 60_000) {
	const registry = new AdapterRegistry();
	for (const adapter of adapters) registry.register(adapter);
	const events: any[] = [];
	const scheduler = new QuotaScheduler({ events: { emit: (_name: string, data: unknown) => events.push(data) } } as any,
		registry, { cacheTtlMs });
	return { scheduler, events };
}

function testAdapter(fetchQuota: ProviderAdapter["fetchQuota"], id = "test-a"): ProviderAdapter {
	return { id, displayName: id, supportedProviders: [id], isConfigured: () => true, fetchQuota };
}

test("Claude Bridge reports unavailable instead of fabricating quota", async () => {
	const ctx = { model: { provider: "claude-bridge", id: "claude-test" } } as any;
	const adapter = new ClaudeAdapter();
	await assert.rejects(adapter.fetchQuota(ctx, new AbortController().signal), /no usage data source/);
	const { scheduler, events } = testScheduler([{ ...adapter, isConfigured: () => true, fetchQuota: adapter.fetchQuota.bind(adapter) }]);
	try {
		await scheduler.refreshActiveProvider(ctx);
		assert.equal(events.at(-1).status, "unavailable");
		assert.deepEqual(events.at(-1).windows, []);
	} finally { scheduler.stop(); }
});

for (const outcome of ["success", "failure"] as const) {
	test(`late provider ${outcome} cannot overwrite the new provider`, async () => {
		const pending = deferred<ProviderQuotaReport>();
		const { scheduler, events } = testScheduler([
			testAdapter(() => pending.promise),
			testAdapter(async () => testReport("test-b", ["beta"]), "test-b"),
		]);
		try {
			const ctx = { model: { provider: "test-a", id: "alpha" } } as any;
			const old = scheduler.refreshActiveProvider(ctx);
			await Promise.resolve();
			ctx.model = { provider: "test-b", id: "beta" };
			await scheduler.refreshActiveProvider(ctx);
			if (outcome === "success") pending.resolve(testReport());
			else pending.reject(new Error("Old provider failed"));
			await old;
			assert.equal(events.length, 1);
			assert.equal(events[0].providerId, "test-b");
			assert.equal(events[0].status, "ready");
		} finally { scheduler.stop(); }
	});
}

test("switching to an unsupported provider suppresses the pending result", async () => {
	const pending = deferred<ProviderQuotaReport>();
	const { scheduler, events } = testScheduler([testAdapter(() => pending.promise)]);
	try {
		const ctx = { model: { provider: "test-a", id: "alpha" } } as any;
		const old = scheduler.refreshActiveProvider(ctx);
		await Promise.resolve();
		ctx.model = { provider: "cursor", id: "default" };
		await scheduler.refreshActiveProvider(ctx);
		pending.resolve(testReport());
		await old;
		assert.equal(events.length, 1);
		assert.equal(events[0].providerId, "cursor");
		assert.equal(events[0].status, "unavailable");
	} finally { scheduler.stop(); }
});

test("singleflight publishes only the latest model's matched windows", async () => {
	const pending = deferred<ProviderQuotaReport>();
	let calls = 0;
	const { scheduler, events } = testScheduler([testAdapter(() => { calls++; return pending.promise; })]);
	try {
		const old = scheduler.refreshActiveProvider({ model: { provider: "test-a", id: "alpha" } } as any);
		const latest = scheduler.refreshActiveProvider({ model: { provider: "test-a", id: "beta" } } as any);
		const report = testReport();
		report.windows.push({ ...report.primaryWindow, groupId: "beta", label: "beta", modelKeys: ["beta"] });
		pending.resolve(report);
		await Promise.all([old, latest]);
		assert.equal(calls, 1);
		assert.equal(events.length, 1);
		assert.deepEqual(events[0].windows.map((w: QuotaWindow) => w.label), ["beta"]);
	} finally { scheduler.stop(); }
});

test("stopped requests cannot broadcast, cache, or remove replacement singleflight", async () => {
	const oldRequest = deferred<ProviderQuotaReport>();
	const newRequest = deferred<ProviderQuotaReport>();
	let calls = 0;
	const { scheduler, events } = testScheduler([testAdapter(() => ++calls === 1 ? oldRequest.promise : newRequest.promise)]);
	try {
		const ctx = { model: { provider: "test-a", id: "alpha" } } as any;
		const old = scheduler.refreshActiveProvider(ctx);
		await Promise.resolve();
		scheduler.stop();
		const latest = scheduler.refreshActiveProvider(ctx);
		await Promise.resolve();
		oldRequest.resolve(testReport());
		await old;
		assert.equal(events.length, 0);
		const joined = scheduler.refreshActiveProvider(ctx);
		const fresh = testReport();
		fresh.primaryWindow.remainingPercent = 17;
		newRequest.resolve(fresh);
		await Promise.all([latest, joined]);
		assert.equal(calls, 2);
		assert.equal(events.length, 1);
		assert.equal(events[0].windows[0].remainingPercent, 17);
		assert.equal(await scheduler.refreshActiveProvider(ctx), fresh);
	} finally { scheduler.stop(); }
});

test("a partial single group still requires model matching", async () => {
	const { scheduler, events } = testScheduler([testAdapter(async () => testReport("test-a", ["claude"]))]);
	try {
		await scheduler.refreshActiveProvider({ model: { provider: "test-a", id: "gemini-4-hydrogen" } } as any);
		assert.equal(events.at(-1).status, "unavailable");
	} finally { scheduler.stop(); }
});

test("provider-wide windows use an explicit adapter policy", async () => {
	const { scheduler, events } = testScheduler([
		{ ...testAdapter(async () => testReport()), modelMatching: "all" },
	]);
	try {
		await scheduler.refreshActiveProvider({ model: { provider: "test-a", id: "opaque-model-id" } } as any);
		assert.equal(events.at(-1).status, "ready");
	} finally { scheduler.stop(); }
});

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

test("Antigravity maps two summary pools and ignores the obsolete Argon group", () => {
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

	assert.equal(windows.length, 4);
	assert.equal(
		windows.filter((w) => w.groupId === ANTIGRAVITY_GEMINI_MODELS).length,
		2,
	);
	assert.equal(
		windows.filter((w) => w.groupId === ANTIGRAVITY_3P_MODELS).length,
		2,
	);

	const geminiLabels = windows
		.filter((w) => w.groupId === ANTIGRAVITY_GEMINI_MODELS)
		.map((w) => w.label)
		.sort();
	assert.deepEqual(geminiLabels, ["1w", "Gemini 5h"]);

	for (const id of ["gemini-4-carbon-high", "gemini-4-hydrogen", "gemini-4-neon", "gemini-4-argon"]) {
		const matched = matchQuotaWindowsForModel(windows, id);
		assert.deepEqual(matched.map((w) => w.remainingPercent), [85, 68]);
		assert.ok(matched.every((w) => w.resetsAt === resetsAt));
	}
	for (const id of ["claude-opus-5-5", "gpt-oss-120b"]) {
		assert.deepEqual(matchQuotaWindowsForModel(windows, id).map((w) => w.remainingPercent), [42, 80]);
	}
});

test("Antigravity recognizes a shared Gemini summary even when its name mentions Argon", () => {
	const windows = buildAntigravityWindows([
		{ displayName: "Gemini 4 Argon / Hydrogen", buckets: [{ window: "weekly", remainingFraction: 0.61 }] },
	], Date.now());
	assert.equal(matchQuotaWindow(windows, "gemini-4-carbon")?.remainingPercent, 61);
});

test("Antigravity catalog fallback reports one window per pool", () => {
	const resetsAt = Date.now() + 7 * 86400_000;
	const models = {
		"gemini-4-carbon": { quotaInfo: { remainingFraction: 0.8, resetTime: new Date(resetsAt).toISOString() } },
		"gemini-4-hydrogen": { quotaInfo: { remainingFraction: 0.8 } },
		"gemini-4-argon": { quotaInfo: { remainingFraction: 0.8 } },
		"claude-opus-5-5": { quotaInfo: { remainingFraction: 0.3 } },
		"gpt-oss-120b": { quotaInfo: { remainingFraction: 0.3 } },
	};
	const windows = buildAntigravityModelFallbackWindows(models, resetsAt - 1000);
	assert.deepEqual(windows.map((w) => w.groupId), [ANTIGRAVITY_GEMINI_MODELS, ANTIGRAVITY_3P_MODELS]);
	for (const id of ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon"]) {
		const quota = matchQuotaWindow(windows, id);
		assert.equal(quota?.remainingPercent, 80);
		assert.equal(quota?.kind, "weekly");
		assert.equal(quota?.resetsAt, resetsAt);
	}
	assert.equal(matchQuotaWindow(windows, "gpt-oss-120b")?.remainingPercent, 30);
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
	assert.equal(matchQuotaWindow(windows, "gemini-4-carbon")?.groupId, "gemini-models");
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
		model: { provider: "known", id: "gemini-4-carbon" },
	} as any);
	assert.equal(events.at(-1)?.data.status, "ready");
	assert.deepEqual(
		events.at(-1)?.data.windows.map((w: QuotaWindow) => w.label),
		["Gemini"],
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
