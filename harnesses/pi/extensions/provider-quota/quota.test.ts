import test from "node:test";
import assert from "node:assert/strict";
import { formatCountdown } from "./auth-helper.ts";
import { buildQuotaWindow } from "./adapters/base.ts";
import { AdapterRegistry } from "./registry.ts";
import { AntigravityAdapter } from "./adapters/antigravity.ts";
import { matchQuotaWindow } from "./scheduler.ts";

test("formatCountdown formats ms into human-readable countdowns", () => {
	assert.equal(formatCountdown(30_000), "30s");
	assert.equal(formatCountdown(59_000), "59s");
	assert.equal(formatCountdown(60_000), "1m");
	assert.equal(formatCountdown(3_600_000), "1h");
	assert.equal(formatCountdown(5_400_000), "1h 30m");
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

test("Antigravity returns 3 distinct windows and matches model accurately", async () => {
	const adapter = new AntigravityAdapter();
	const report = await adapter.fetchQuota({} as any, new AbortController().signal);

	assert.equal(report.providerId, "antigravity");
	assert.equal(report.windows.length, 3);

	// 1. gemini-3.8-flash 应精确匹配到 Gemini Models
	const matchFlash = matchQuotaWindow(report.windows, "gemini-3.8-flash");
	assert.equal(matchFlash?.groupId, "gemini-models");
	assert.equal(matchFlash?.label, "Gemini");

	// 2. gemini-4-argon 应精确匹配到 Argon（而不是更宽泛的 Gemini）
	const matchArgon = matchQuotaWindow(report.windows, "gemini-4-argon");
	assert.equal(matchArgon?.groupId, "gemini-argon");
	assert.equal(matchArgon?.label, "Argon");

	// 3. claude-3-7-sonnet 应精确匹配到 Claude/GPT
	const matchClaude = matchQuotaWindow(report.windows, "claude-3-7-sonnet");
	assert.equal(matchClaude?.groupId, "claude-and-gpt-models");
	assert.equal(matchClaude?.label, "Claude/GPT");
});
