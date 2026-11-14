import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { collectStats } from "./statusline-usage.ts";

const root = process.env.PI_PACKAGE_ROOT;
test("rolling GPT and hourly Gemini use the same clock icon, separate from reset", { skip: !root }, async () => {
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const jiti = createJiti(import.meta.url, {
		moduleCache: false, fsCache: false,
		alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") },
	});
	const { registerStatusline } = await jiti.import(fileURLToPath(new URL("./statusline.ts", import.meta.url)));
	const events = new Map();
	const hooks = new Map();
	let footer;
	const theme = { fg: (_color, value) => value, bold: (value) => value };
	const pi = {
		events: { on: (name, handler) => events.set(name, handler) },
		on: (name, handler) => hooks.set(name, handler), registerCommand() {},
	};
	registerStatusline(pi, { segments: ["usage"], overflow: "priority", extensionStatuses: { exclude: [] } });
	hooks.get("session_start")({}, {
		hasUI: true, mode: "tui", sessionManager: { getEntries: () => [] },
		ui: { setFooter: (factory) => { footer = factory({ requestRender() {} }, theme, { onBranchChange: () => () => {} }); } },
	});
	for (const [kind, label] of [["rolling", "GPT 5h"], ["hourly", "Gemini 5h"]]) {
		events.get("subscription-usage/status/v1")({
			v: 1, status: "ready", providerId: "test", capturedAt: Date.now(),
			windows: [{ kind, label, remainingPercent: 80, resetCountdown: "2h" }],
		});
		assert.equal(footer.render(100)[0], `\uF017 ${label} 80% ↻2h`);
		assert.equal(footer.render(label.length + 6)[0], `\uF017 ${label} 80%`);
	}
});
test("read-only projection agrees with installed Pi native footer", { skip: !root }, async () => {
	// Internal modules are test oracles only, never extension runtime dependencies.
	const load = (path) => import(pathToFileURL(resolve(root, path)).href);
	const { FooterComponent, formatTokens } = await load("dist/modes/interactive/components/footer.js");
	const { initTheme } = await load("dist/modes/interactive/theme/theme.js");
	const { getUsageCostBreakdown } = await load("dist/core/usage-totals.js");
	const { stripVTControlCharacters } = await import("node:util");
	initTheme("dark", false);
	const usage = { input: 137, output: 19, cacheRead: 31, cacheWrite: 7, totalTokens: 194,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } };
	const samples = [
		{ type: "usage", kind: "cache_warm", provider: "test", model: "test", usage },
		{ type: "message", message: { role: "assistant", provider: "test", model: "test", usage } },
		{ type: "message", message: { role: "toolResult", usage } },
		{ type: "compaction", usage },
		{ type: "branch_summary", usage },
	];
	for (const entries of [...samples.map((entry) => [entry]), samples]) {
		const snapshot = JSON.stringify(entries);
		const session = {
			state: {},
			sessionManager: {
				getEntries: () => entries, getEntryCount: () => entries.length,
				getSessionId: () => "test", getLeafId: () => null,
				getCwd: () => "/tmp", getSessionName: () => undefined,
			},
			getContextUsage: () => undefined,
		};
		const footer = new FooterComponent(session, {
			getGitBranch: () => null, getAvailableProviderCount: () => 0, getExtensionStatuses: () => new Map(),
		});
		const text = stripVTControlCharacters(footer.render(200).join("\n"));
		const stats = collectStats(entries);
		assert.ok(text.includes(`↑${formatTokens(stats.input)}`), text);
		assert.ok(text.includes(`↓${formatTokens(stats.output)}`), text);
		assert.equal(JSON.stringify(entries), snapshot);
	}
});
