import test from "node:test";
import assert from "node:assert/strict";
import { formatCountdown } from "./auth-helper.ts";
import { buildQuotaWindow } from "./adapters/base.ts";
import { AdapterRegistry } from "./registry.ts";
import { AntigravityAdapter } from "./adapters/antigravity.ts";
import { formatQuotaReport } from "./format.ts";
import { matchQuotaWindow, matchQuotaWindowsForModel } from "./scheduler.ts";

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

test("Antigravity returns valid windows and matches model accurately", async () => {
	const adapter = new AntigravityAdapter();
	const report = await adapter.fetchQuota({} as any, new AbortController().signal);

	assert.equal(report.providerId, "antigravity");
	assert.ok(report.windows.length >= 3);

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
	assert.ok(matchClaude?.label.startsWith("Claude"));

	// 4. matchQuotaWindowsForModel 返回匹配 Group 的所有窗口
	const claudeWindows = matchQuotaWindowsForModel(report.windows, "claude-3-7-sonnet");
	assert.ok(claudeWindows.length >= 1);
	assert.ok(claudeWindows.every((w) => w.groupId === "claude-and-gpt-models"));
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

	// 验证包含分组标题
	assert.ok(output.includes("Gemini Models:"));
	assert.ok(output.includes("Claude and GPT models:"));
	// 验证包含进度条字符
	assert.ok(output.includes("█"));
	assert.ok(output.includes("░"));
	// 验证包含账号与套餐信息
	assert.ok(output.includes("Account:"));
	assert.ok(output.includes("Google AI Pro"));
	assert.ok(output.includes("tester@example.com"));
});
