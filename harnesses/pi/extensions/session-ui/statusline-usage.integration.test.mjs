import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { collectStats } from "./statusline-usage.ts";

const root = process.env.PI_PACKAGE_ROOT;
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
