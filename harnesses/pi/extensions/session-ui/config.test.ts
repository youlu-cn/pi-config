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
		for (const key of ["toolActivity", "workAnimation", "compactPaste", "statusline", "effort", "turnDuration", "uiMeta"]) {
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

test("loads the integrated workAnimation config", () => {
	const loaded = withConfig({
		workAnimation: {
			enabled: false,
			intervalMs: 500,
			placement: "belowEditor",
		},
	});

	assert.deepEqual(loaded.config.workAnimation, {
		enabled: false,
		intervalMs: 500,
		placement: "belowEditor",
	});
	assert.deepEqual(loaded.warnings, []);
});

test("falls back and warns for invalid workAnimation values", () => {
	const loaded = withConfig({
		workAnimation: {
			enabled: "yes",
			intervalMs: 99,
			placement: "besideEditor",
		},
	});

	assert.deepEqual(loaded.config.workAnimation, {
		enabled: true,
		intervalMs: 180,
		placement: "aboveEditor",
	});
	assert.deepEqual(loaded.warnings, [
		"workAnimation.placement must be aboveEditor or belowEditor",
		"workAnimation.enabled must be a boolean",
		"workAnimation.intervalMs must be an integer between 100 and 500",
	]);
});
