import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SESSION_UI_CONFIG, loadSessionUiConfig } from "./config.ts";

const TEST_ROOT = `/tmp/mozi-test/session-ui-config-${process.pid}-${Date.now()}`;

function withConfig(raw: unknown) {
	mkdirSync(TEST_ROOT, { recursive: true });
	const path = join(
		TEST_ROOT,
		`config-${Math.random().toString(16).slice(2)}.json`,
	);
	writeFileSync(path, `${JSON.stringify(raw)}\n`, "utf8");
	return withConfigPath(path);
}

function withConfigPath(path?: string) {
	const previous = process.env.PI_SESSION_UI_CONFIG;
	if (path === undefined) delete process.env.PI_SESSION_UI_CONFIG;
	else process.env.PI_SESSION_UI_CONFIG = path;
	try {
		return loadSessionUiConfig();
	} finally {
		if (previous === undefined) delete process.env.PI_SESSION_UI_CONFIG;
		else process.env.PI_SESSION_UI_CONFIG = previous;
	}
}

test.after(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
});

test("distinguishes an absent default config from an explicit missing path", () => {
	assert.deepEqual(withConfigPath().warnings, []);
	assert.deepEqual(withConfigPath("  ").warnings, []);
	const missing = join(TEST_ROOT, "missing.json");
	const result = withConfigPath(missing);
	assert.deepEqual(result.config, DEFAULT_SESSION_UI_CONFIG);
	assert.equal(result.path, missing);
	assert.equal(result.warnings.length, 1);
	assert.ok(result.warnings[0]!.includes(missing));
	assert.match(result.warnings[0]!, /failed to load/);
});

test("reports malformed JSON and unreadable config paths", () => {
	mkdirSync(TEST_ROOT, { recursive: true });
	const malformed = join(TEST_ROOT, "malformed.json");
	writeFileSync(malformed, "{");
	for (const path of [malformed, TEST_ROOT]) {
		const result = withConfigPath(path);
		assert.deepEqual(result.config, DEFAULT_SESSION_UI_CONFIG);
		assert.equal(result.warnings.length, 1);
		assert.ok(result.warnings[0]!.includes(path));
	}
});

test("warns on invalid roots and every explicitly invalid config section", () => {
	for (const raw of [null, [], false, "invalid", 3]) {
		assert.deepEqual(withConfig(raw).warnings, ["config root must be an object"]);
		for (const key of ["toolActivity", "workAnimation", "compactPaste", "statusline", "effort", "turnDuration", "uiMeta", "startupHeader", "markdownEnhance", "contextCommand", "reference", "stickyUserMessage"]) {
			const result = withConfig({ [key]: raw });
			assert.deepEqual(result.warnings, [`${key} must be an object`]);
			assert.deepEqual(result.config, DEFAULT_SESSION_UI_CONFIG);
		}
		for (const [parent, key] of [
			["statusline", "extensionStatuses"], ["uiMeta", "title"], ["uiMeta", "sessionName"],
		]) {
			const result = withConfig({ [parent!]: { [key!]: raw } });
			assert.deepEqual(result.warnings, [`${parent}.${key} must be an object`]);
			assert.deepEqual(result.config, DEFAULT_SESSION_UI_CONFIG);
		}
	}
});

test("keeps valid sibling settings when a config section falls back", () => {
	const result = withConfig({ workAnimation: false, statusline: { enabled: false } });
	assert.deepEqual(result.warnings, ["workAnimation must be an object"]);
	assert.equal(result.config.workAnimation.enabled, true);
	assert.equal(result.config.statusline.enabled, false);
	assert.deepEqual(withConfig({}).warnings, []);
});

test("loads tool activity defaults and overrides", () => {
	assert.deepEqual(withConfig({}).config.toolActivity, {
		enabled: true, placement: "aboveEditor", maxItems: 6,
	});
	const loaded = withConfig({
		toolActivity: { enabled: false, placement: "belowEditor", maxItems: 5 },
	});
	assert.deepEqual(loaded.config.toolActivity, {
		enabled: false, placement: "belowEditor", maxItems: 5,
	});
	assert.deepEqual(loaded.warnings, []);
});

test("warns and falls back for invalid tool activity fields", () => {
	const loaded = withConfig({
		toolActivity: { enabled: "yes", placement: "side", maxItems: 0 },
	});
	assert.deepEqual(loaded.config.toolActivity, {
		enabled: true, placement: "aboveEditor", maxItems: 6,
	});
	assert.deepEqual(loaded.warnings, [
		"toolActivity.placement must be aboveEditor or belowEditor",
		"toolActivity.enabled must be a boolean",
		"toolActivity.maxItems must be an integer between 1 and 20",
	]);
});

test("default statusline hides MCP without a public native connection status", () => {
	const { config } = withConfig({});
	assert.equal(config.statusline.segments.includes("mcp"), false);
	assert.ok(config.statusline.extensionStatuses.exclude.includes("mcp"));
});

test("loads optional UI metadata controls and name length limits", () => {
	assert.deepEqual(withConfig({}).config.uiMeta, {
		enabled: true,
		title: { enabled: true, maxLength: 36 },
		sessionName: { enabled: true, maxLength: 48 },
	});
	const loaded = withConfig({ uiMeta: {
		title: { enabled: false },
		sessionName: { enabled: false, maxLength: 60 },
	} });
	assert.deepEqual(loaded.config.uiMeta, {
		enabled: true,
		title: { enabled: false, maxLength: 36 },
		sessionName: { enabled: false, maxLength: 60 },
	});
	assert.deepEqual(loaded.warnings, []);
});

test("loads agentSummary, compactThinking, and workAnimation stats options", () => {
	const result = withConfig({
		workAnimation: {
			showStats: false,
			showTtft: false,
			tokenRateMode: "live",
		},
		agentSummary: { enabled: true, minToolCount: 2 },
		compactThinking: {
			enabled: true,
			previewLines: 5,
			completedPreviewLines: 0,
			animationIntervalMs: 120,
		},
		editorPrefix: { enabled: false },
		aliases: { enabled: false },
		specialCards: { enabled: false },
		startupHeader: { enabled: false },
		markdownEnhance: { enabled: false },
		contextCommand: { enabled: false },
		reference: {
			enabled: false,
			sessionReference: false,
			subagentAutocomplete: false,
		},
		stickyUserMessage: { enabled: false },
	});
	assert.equal(result.config.workAnimation.showStats, false);
	assert.equal(result.config.workAnimation.showTtft, false);
	assert.equal(result.config.workAnimation.tokenRateMode, "live");
	assert.equal(result.config.agentSummary.minToolCount, 2);
	assert.equal(result.config.compactThinking.previewLines, 5);
	assert.equal(result.config.compactThinking.completedPreviewLines, 0);
	assert.equal(result.config.compactThinking.animationIntervalMs, 120);
	assert.equal(result.config.editorPrefix.enabled, false);
	assert.equal(result.config.aliases.enabled, false);
	assert.equal(result.config.specialCards.enabled, false);
	assert.equal(result.config.startupHeader.enabled, false);
	assert.equal(result.config.markdownEnhance.enabled, false);
	assert.equal(result.config.contextCommand.enabled, false);
	assert.deepEqual(result.config.reference, {
		enabled: false,
		sessionReference: false,
		subagentAutocomplete: false,
	});
	assert.equal(result.config.stickyUserMessage.enabled, false);
	assert.deepEqual(withConfig({}).config.startupHeader, { enabled: true });
	assert.deepEqual(withConfig({}).config.markdownEnhance, { enabled: true });
	assert.deepEqual(withConfig({}).config.contextCommand, { enabled: true });
	assert.deepEqual(withConfig({}).config.reference, {
		enabled: true,
		sessionReference: true,
		subagentAutocomplete: true,
	});
	assert.deepEqual(withConfig({}).config.stickyUserMessage, { enabled: true });
});

test("loads claudeToolStyle mode, grouping, and diff options", () => {
	const result = withConfig({
		claudeToolStyle: {
			mode: "compact",
			grouping: false,
			diffViewMode: "split",
			diffIndicatorMode: "classic",
			diffSplitMinWidth: 100,
			editDiffCollapsedLines: 6,
			writeDiffCollapsedLines: 4,
		},
	});
	assert.equal(result.config.claudeToolStyle.mode, "compact");
	assert.equal(result.config.claudeToolStyle.grouping, false);
	assert.equal(result.config.claudeToolStyle.diffViewMode, "split");
	assert.equal(result.config.claudeToolStyle.diffIndicatorMode, "classic");
	assert.equal(result.config.claudeToolStyle.diffSplitMinWidth, 100);
	assert.equal(result.config.claudeToolStyle.editDiffCollapsedLines, 6);
	assert.equal(result.config.claudeToolStyle.writeDiffCollapsedLines, 4);

	const bad = withConfig({ claudeToolStyle: { mode: "nope" } });
	assert.ok(bad.warnings.some((w) => w.includes("claudeToolStyle.mode")));
	assert.equal(bad.config.claudeToolStyle.mode, "on");
});

test("loads the integrated workAnimation config", () => {
	const loaded = withConfig({
		workAnimation: {
			enabled: false,
			style: "gemini",
			intervalMs: 500,
			placement: "belowEditor",
		},
	});

	assert.deepEqual(loaded.config.workAnimation, {
		enabled: false,
		style: "gemini",
		intervalMs: 500,
		placement: "belowEditor",
		showStats: true,
		showTtft: true,
		tokenRateMode: "average",
	});
	assert.deepEqual(loaded.warnings, []);
});

test("falls back and warns for invalid workAnimation values", () => {
	const loaded = withConfig({
		workAnimation: {
			enabled: "yes",
			style: "unknown",
			intervalMs: 99,
			placement: "besideEditor",
		},
	});

	assert.deepEqual(loaded.config.workAnimation, {
		enabled: true,
		intervalMs: 240,
		placement: "aboveEditor",
		showStats: true,
		showTtft: true,
		tokenRateMode: "average",
	});
	assert.deepEqual(loaded.warnings, [
		"workAnimation.placement must be aboveEditor or belowEditor",
		"workAnimation.style must be one of: claude, gemini, braille, dots",
		"workAnimation.enabled must be a boolean",
		"workAnimation.intervalMs must be an integer between 100 and 500",
	]);
});
