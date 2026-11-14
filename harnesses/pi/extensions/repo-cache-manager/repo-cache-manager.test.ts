import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
	checkScanStatus,
	loadScanCache,
	saveScanCache,
	clearScanCache,
	parsePorcelainLine,
	type ScanCacheData,
} from "./scan-cache.ts";
import { extractRepoSummary, parseModelSpec } from "./tools/scout.ts";
import { extractTaskSpec, buildArchitectPrompt } from "./tools/architect.ts";
import { parseSubagentHandle } from "./tools/subagent-runner.ts";
import { ContextGuard } from "./context-guard.ts";
import { loadConfig } from "./config.ts";
import {
	DEFAULT_TELEMETRY_CONFIG,
	TurnTelemetryCollector,
	cloudCacheHitRate,
	comparePrefixLocks,
	estimateThinkingTax,
	estimateTokensFromChars,
	evaluateAuditTriggers,
	collectCacheMissNotes,
	formatAuditCardText,
	hashMessagePrefix,
	isHeavyModel,
	shouldShowAuditCard,
	shortHash,
} from "./telemetry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("loadConfig correctly reads configuration from disk", () => {
	const cfg = loadConfig();
	assert.ok(typeof cfg.scoutModel === "string");
	assert.ok(typeof cfg.architectModel === "string");
	assert.ok(cfg.maxChangedFiles >= 1);
});

test("parseModelSpec correctly splits provider and model ID", () => {
	assert.deepEqual(parseModelSpec("antigravity/gemini-3.8-flash"), {
		provider: "antigravity",
		model: "gemini-3.8-flash",
	});
	assert.deepEqual(parseModelSpec("google/gemini-pro"), {
		provider: "google",
		model: "gemini-pro",
	});
	assert.deepEqual(parseModelSpec("gemini-3.8-flash"), {
		provider: "antigravity",
		model: "gemini-3.8-flash",
	});
});

test("parseSubagentHandle extracts hex handle without matching 'Spawned'", () => {
	const realisticOutput = `Spawned scout (a1b2c3)\nState: busy\nAttach: tmux attach -t pi-subagent-a1b2c3\n`;
	assert.equal(parseSubagentHandle(realisticOutput), "a1b2c3");

	const unnamedOutput = `Spawned f09e1a\nState: busy\nAttach: tmux attach -t pi-subagent-f09e1a\n`;
	assert.equal(parseSubagentHandle(unnamedOutput), "f09e1a");

	assert.equal(parseSubagentHandle("Invalid output without handle"), null);
});

test("extractRepoSummary extracts XML tags or truncates fallback", () => {
	const raw = `Some chatter before
<repo_summary>
# Tech Stack: TypeScript, Pi Extension
# Core: src/index.ts
</repo_summary>
Some chatter after`;
	assert.equal(
		extractRepoSummary(raw),
		"# Tech Stack: TypeScript, Pi Extension\n# Core: src/index.ts",
	);

	const withoutTag = "Direct summary text without tag";
	assert.equal(extractRepoSummary(withoutTag), "Direct summary text without tag");
});

test("extractTaskSpec extracts XML tags correctly", () => {
	const raw = `Plan follows:
<task_spec>
1. Modify src/index.ts
2. Add export
</task_spec>`;
	assert.equal(extractTaskSpec(raw), "1. Modify src/index.ts\n2. Add export");
});

test("buildArchitectPrompt bounds total context length under budget", () => {
	const repoSummary = "Short repo summary";
	const task = "Refactor auth logic";
	const longSnippets = "A".repeat(30000); // 30KB of snippets

	const prompt = buildArchitectPrompt(repoSummary, task, longSnippets, 18000);
	assert.ok(prompt.length <= 18000);
	assert.ok(prompt.includes("=== PROJECT ARCHITECTURE SUMMARY ==="));
	assert.ok(prompt.includes("=== TASK OBJECTIVE & REQUIREMENTS ==="));
	assert.ok(prompt.includes("<task_spec>"));
});

test("parsePorcelainLine handles spaces, renames, and quoted paths accurately", () => {
	assert.equal(parsePorcelainLine(" M src/index.ts"), "src/index.ts");
	assert.equal(parsePorcelainLine("?? path with  two spaces.ts"), "path with  two spaces.ts");
	assert.equal(parsePorcelainLine("R  old/file.ts -> new/file.ts"), "new/file.ts");
	assert.equal(parsePorcelainLine('?? "quoted \\"path\\".ts"'), 'quoted "path".ts');
	assert.equal(parsePorcelainLine(""), null);
});

test("scan-cache save, load, and clear operations", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-scan-test-"));
	try {
		assert.equal(loadScanCache(tmpDir), null);

		const data: ScanCacheData = {
			gitHead: "abc1234567890",
			timestamp: Date.now(),
			repoSummary: "Sample repo summary",
		};
		saveScanCache(tmpDir, data);

		const loaded = loadScanCache(tmpDir);
		assert.ok(loaded);
		assert.equal(loaded?.gitHead, "abc1234567890");
		assert.equal(loaded?.repoSummary, "Sample repo summary");

		assert.equal(clearScanCache(tmpDir), true);
		assert.equal(loadScanCache(tmpDir), null);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("checkScanStatus detects UNSCANNED when no cache exists", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-scan-status-"));
	try {
		const status = checkScanStatus(tmpDir, 8);
		assert.equal(status.status, "UNSCANNED");
		if (status.status === "UNSCANNED") {
			assert.equal(status.reason, "no_cache");
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("ContextGuard: 100% unmodified when NO model switch occurs (KV Cache protected)", () => {
	const guard = new ContextGuard(1000);
	const modelA = "antigravity/gemini-3.8-flash";
	guard.setActiveModel(modelA);

	const msgUser: any = { role: "user", content: "read my file", timestamp: 1000 };
	const msgToolLarge: any = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "X".repeat(5000) }],
		timestamp: 1001,
	};
	const msgAssistant: any = {
		role: "assistant",
		provider: "antigravity",
		model: "gemini-3.8-flash",
		content: [{ type: "text", text: "done" }],
		timestamp: 1002,
	};

	const messages = [msgUser, msgToolLarge, msgAssistant];
	for (const m of messages) {
		guard.trackMessage(m, modelA);
	}

	// Simulate Pi's structuredClone(messages) in emitContext
	const clonedMessages = structuredClone(messages);

	// When running consecutively on the same model
	const result = guard.protectContextOnModelSwitch(clonedMessages, modelA);
	// Without cross-model switches, must return null (zero mutation, strictly preserve references)
	assert.equal(result, null);
});

test("ContextGuard: prunes giant tool outputs across manual model switch even after structuredClone", () => {
	const guard = new ContextGuard(1000);
	const modelFlash = "antigravity/gemini-3.8-flash";
	const modelArgon = "antigravity/gemini-4-argon";

	const msgUser: any = { role: "user", content: "inspect code", timestamp: 2000 };
	const msgToolLargeOld: any = {
		role: "toolResult",
		toolCallId: "call_large_1",
		toolName: "read",
		content: [{ type: "text", text: "X".repeat(4000) }],
		timestamp: 2001,
	};
	const msgToolShortOld: any = {
		role: "toolResult",
		toolCallId: "call_short_2",
		toolName: "grep",
		content: [{ type: "text", text: "found 1 match" }],
		timestamp: 2002,
	};
	const msgAssistantOld: any = {
		role: "assistant",
		content: [{ type: "text", text: "analyzed flash" }],
		provider: "antigravity",
		model: "gemini-3.8-flash",
		timestamp: 2003,
	};

	// Track messages generated under flash model
	guard.trackMessage(msgUser, modelFlash);
	guard.trackMessage(msgToolLargeOld, modelFlash);
	guard.trackMessage(msgToolShortOld, modelFlash);
	guard.trackMessage(msgAssistantOld, modelFlash);

	// Simulate Pi's structuredClone(messages) in runner.js emitContext()
	const clonedMessages = structuredClone([
		msgUser,
		msgToolLargeOld,
		msgToolShortOld,
		msgAssistantOld,
	]);

	// User manually switches to argon model
	const result = guard.protectContextOnModelSwitch(clonedMessages, modelArgon);
	assert.ok(result);
	assert.equal(result.length, 4);

	// User and Assistant messages remain intact
	assert.equal(result[0], clonedMessages[0]);
	assert.equal(result[3], clonedMessages[3]);

	// Short tool output remains intact
	assert.equal(result[2], clonedMessages[2]);

	// Bulky tool output from prior model is replaced with concise placeholder
	const prunedToolMsg: any = result[1];
	assert.notEqual(prunedToolMsg, clonedMessages[1]);
	assert.equal(prunedToolMsg.role, "toolResult");
	assert.ok(prunedToolMsg.content[0].text.includes("[Omitted: Cached 'read' output (4000 chars)"));
	assert.ok(prunedToolMsg.content[0].text.includes("gemini-4-argon"));
});

test("ContextGuard: infers cross-model history purely from assistant metadata without prior trackMessage", () => {
	const guard = new ContextGuard(1000);
	const modelArgon = "antigravity/gemini-4-argon";

	// Untracked messages (e.g. restored from session or without explicit map entry)
	const messages: any[] = structuredClone([
		{ role: "user", content: "read file", timestamp: 3000 },
		{
			role: "toolResult",
			toolCallId: "call_untracked",
			toolName: "read",
			content: [{ type: "text", text: "Y".repeat(3500) }],
			timestamp: 3001,
		},
		{
			role: "assistant",
			provider: "antigravity",
			model: "gemini-3.8-flash",
			content: [{ type: "text", text: "done" }],
			timestamp: 3002,
		},
	]);

	const result = guard.protectContextOnModelSwitch(messages, modelArgon);
	assert.ok(result);
	assert.ok(
		(result[1] as any).content[0].text.includes("[Omitted: Cached 'read' output (3500 chars)"),
	);
});

test("Verify NO setModel calls in entire repo-cache-manager codebase", () => {
	const files = [
		["index.ts", readFileSync(join(__dirname, "index.ts"), "utf8")],
		["scout.ts", readFileSync(join(__dirname, "tools", "scout.ts"), "utf8")],
		["architect.ts", readFileSync(join(__dirname, "tools", "architect.ts"), "utf8")],
		["subagent-runner.ts", readFileSync(join(__dirname, "tools", "subagent-runner.ts"), "utf8")],
		["context-guard.ts", readFileSync(join(__dirname, "context-guard.ts"), "utf8")],
		["telemetry.ts", readFileSync(join(__dirname, "telemetry.ts"), "utf8")],
		["cache-audit-view.ts", readFileSync(join(__dirname, "cache-audit-view.ts"), "utf8")],
	];

	for (const [file, content] of files) {
		assert.ok(
			!content.includes("setModel("),
			`Forbidden setModel() call found in ${file}! Extensions must never tamper with user-selected model.`,
		);
	}
});

test("telemetry: shortHash is stable and truncated", () => {
	assert.equal(shortHash("hello"), shortHash("hello"));
	assert.notEqual(shortHash("hello"), shortHash("world"));
	assert.equal(shortHash("hello").length, 8);
});

test("telemetry: estimateTokensFromChars uses ~4 chars/token", () => {
	assert.equal(estimateTokensFromChars(0), 0);
	assert.equal(estimateTokensFromChars(4), 1);
	assert.equal(estimateTokensFromChars(5), 2);
});

test("telemetry: prefix lock detects FIRST / LOCKED / BUSTED", () => {
	const msgs = [
		{ role: "user", content: "a" },
		{ role: "assistant", content: "b" },
		{ role: "user", content: "c" },
	];
	const hashes = hashMessagePrefix(msgs);
	assert.equal(hashes.length, 2);

	assert.equal(comparePrefixLocks(null, hashes).status, "first");
	assert.equal(comparePrefixLocks(hashes, hashes).status, "locked");
	assert.equal(comparePrefixLocks(hashes, hashes).label, "🔒 LOCKED");

	const busted = hashMessagePrefix([
		{ role: "user", content: "CHANGED" },
		{ role: "assistant", content: "b" },
		{ role: "user", content: "c" },
	]);
	const bust = comparePrefixLocks(hashes, busted);
	assert.equal(bust.status, "busted");
	assert.ok(bust.label.includes("BUSTED at msg[0]"));
});

test("telemetry: cloudCacheHitRate = cacheRead / (input + cacheRead)", () => {
	assert.equal(cloudCacheHitRate({ input: 25, cacheRead: 75, cacheWrite: 0, output: 10 }), 0.75);
	assert.equal(cloudCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 10, output: 1 }), null);
});

test("telemetry: thinking tax prefers provider reasoning, else estimates", () => {
	const fromProvider = estimateThinkingTax(1000, 350, 600);
	assert.equal(fromProvider.source, "provider_reasoning");
	assert.equal(fromProvider.thinkingTokens, 600);

	const estimated = estimateThinkingTax(1000, 350);
	assert.equal(estimated.source, "estimated");
	assert.equal(estimated.visibleEstTokens, 100); // 350/3.5
	assert.equal(estimated.thinkingTokens, 900);
});

test("telemetry: heavy model + cache bust triggers", () => {
	for (const modelId of [
		"antigravity/gemini-4-argon",
		"antigravity/gemini-4-carbon",
		"openai-codex/gpt-6-astra",
		"anthropic/claude-fable",
	]) {
		assert.ok(isHeavyModel(modelId, DEFAULT_TELEMETRY_CONFIG.heavyModelPattern), modelId);
	}
	for (const modelId of [
		"antigravity/gemini-3.8-flash",
		"anthropic/claude-opus-4",
		"openai/gpt-5",
		"openai/o3",
		"anthropic/claude-sonnet-4-thinking",
	]) {
		assert.ok(!isHeavyModel(modelId, DEFAULT_TELEMETRY_CONFIG.heavyModelPattern), modelId);
	}

	const base = {
		modelId: "antigravity/gemini-4-argon",
		injection: {
			repoCacheStatus: "injected" as const,
			repoCacheInjectedTokens: 500,
			sysPromptHash: "abcd1234",
			sysPromptMutated: false,
			sysPromptLabel: "✓ stable",
		},
		prefix: { status: "locked" as const, label: "🔒 LOCKED" },
		dehydration: {
			rawEstTokens: 10000,
			sentEstTokens: 4000,
			omittedTools: 3,
			omittedSavedTokens: 6000,
			omittedSavedRatio: 0.6,
		},
		cloud: { input: 60, cacheRead: 40, cacheWrite: 0, output: 200 },
		cloudCacheHitRate: 0.4,
		prevCloudCacheHitRate: 0.8,
		thinking: null,
		timing: {
			ttftMs: 120,
			totalDurationMs: 900,
			contextPercent: 42,
			contextTokens: 42000,
			contextWindow: 100000,
		},
		timestamp: Date.now(),
	};

	const triggers = evaluateAuditTriggers(base, DEFAULT_TELEMETRY_CONFIG);
	assert.ok(triggers.includes("heavy_model"));
	assert.ok(triggers.includes("local_dehydration"));
	assert.ok(triggers.includes("cache_bust"));
	assert.ok(shouldShowAuditCard(triggers, DEFAULT_TELEMETRY_CONFIG));

	const text = formatAuditCardText({ ...base, triggers });
	assert.ok(text.includes("Cache Audit"));
	assert.ok(text.includes("cloudCacheHitRate"));
	assert.ok(text.includes("🔒 LOCKED"));
	assert.ok(shouldShowAuditCard([], DEFAULT_TELEMETRY_CONFIG), "alwaysShow default emits every turn");
});

test("telemetry: deferred light-model injection has no unused-cache warning", () => {
	const deferred = {
		modelId: "cursor/default",
		injection: {
			repoCacheStatus: "deferred" as const,
			repoCacheInjectedTokens: 0,
			sysPromptHash: "abcd1234",
			sysPromptMutated: false,
			sysPromptLabel: "✓ stable",
		},
		prefix: { status: "first" as const, label: "🆕 FIRST_TURN" },
		dehydration: {
			rawEstTokens: 100,
			sentEstTokens: 100,
			omittedTools: 0,
			omittedSavedTokens: 0,
			omittedSavedRatio: null,
		},
		cloud: { input: 80, cacheRead: 0, cacheWrite: 0, output: 20 },
		cloudCacheHitRate: 0,
		prevCloudCacheHitRate: null,
		thinking: null,
		timing: {
			ttftMs: 50,
			totalDurationMs: 200,
			contextPercent: 10,
			contextTokens: 1000,
			contextWindow: 10000,
		},
		triggers: [] as const,
		timestamp: Date.now(),
	};

	const notes = collectCacheMissNotes(deferred);
	assert.ok(notes.some((n) => n.includes("deferred")));
	assert.ok(!notes.some((n) => n.includes("repo cache unused")));
	assert.ok(formatAuditCardText(deferred).includes("deferred (light model, 0 tok tax)"));
});

test("telemetry: cache-miss notes when repo/cloud cache unused", () => {
	const unused = {
		modelId: "cursor/default",
		injection: {
			repoCacheStatus: "unindexed" as const,
			repoCacheInjectedTokens: 0,
			sysPromptHash: "abcd1234",
			sysPromptMutated: false,
			sysPromptLabel: "✓ stable",
		},
		prefix: { status: "first" as const, label: "🆕 FIRST_TURN" },
		dehydration: {
			rawEstTokens: 100,
			sentEstTokens: 100,
			omittedTools: 0,
			omittedSavedTokens: 0,
			omittedSavedRatio: null,
		},
		cloud: { input: 80, cacheRead: 0, cacheWrite: 0, output: 20 },
		cloudCacheHitRate: 0,
		prevCloudCacheHitRate: null,
		thinking: null,
		timing: {
			ttftMs: 50,
			totalDurationMs: 200,
			contextPercent: 10,
			contextTokens: 1000,
			contextWindow: 10000,
		},
		triggers: [] as const,
		timestamp: Date.now(),
	};

	const notes = collectCacheMissNotes(unused);
	assert.ok(notes.some((n) => n.includes("repo cache unused")));
	assert.ok(notes.some((n) => n.includes("cloud cache unused")));
	assert.ok(notes.some((n) => n.includes("local dehydration unused")));

	const text = formatAuditCardText(unused);
	assert.ok(text.includes("notes:"));
	assert.ok(text.includes("unindexed (unused)"));
});

test("telemetry: TurnTelemetryCollector commits prefix only at finishTurn", () => {
	const collector = new TurnTelemetryCollector();
	collector.resetForNewTurn();
	collector.recordInjection({
		repoCacheStatus: "injected",
		repoCacheInjectedTokens: 100,
		sysPrompt: "system-v1",
	});

	const turn1 = [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "hi" },
	];
	collector.recordContext(turn1, {
		rawEstTokens: 10,
		sentEstTokens: 10,
		omittedTools: 0,
		omittedSavedTokens: 0,
		omittedSavedRatio: null,
	});
	assert.equal(collector.prefix?.status, "first");
	collector.finishTurn();

	collector.resetForNewTurn();
	collector.recordInjection({
		repoCacheStatus: "injected",
		repoCacheInjectedTokens: 100,
		sysPrompt: "system-v1",
	});
	assert.equal(collector.injection?.sysPromptMutated, false);

	const turn2 = [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: "hi" },
		{ role: "user", content: "next" },
	];
	collector.recordContext(turn2, {
		rawEstTokens: 20,
		sentEstTokens: 20,
		omittedTools: 0,
		omittedSavedTokens: 0,
		omittedSavedRatio: null,
	});
	assert.equal(collector.prefix?.status, "locked");

	collector.recordAssistantUsage(
		{ input: 10, cacheRead: 90, cacheWrite: 0, output: 50 },
		100,
	);
	collector.modelId = "antigravity/gemini-4-argon";
	const card = collector.buildCard(DEFAULT_TELEMETRY_CONFIG);
	assert.ok(card);
	assert.ok(card!.triggers.includes("heavy_model"));
	assert.equal(card!.cloudCacheHitRate, 0.9);
});

test("telemetry: empty first-context snapshot does not pin later turns as FIRST_TURN", () => {
	const collector = new TurnTelemetryCollector();
	collector.resetForNewTurn();
	collector.recordInjection({
		repoCacheStatus: "deferred",
		repoCacheInjectedTokens: 0,
		sysPrompt: "sys",
	});

	// First context call often sees only the new user message → empty prefix.
	collector.recordContext([{ role: "user", content: "hi" }], {
		rawEstTokens: 1,
		sentEstTokens: 1,
		omittedTools: 0,
		omittedSavedTokens: 0,
		omittedSavedRatio: null,
	});
	assert.equal(collector.prefix?.status, "first");

	// Later context in the same turn grows the transcript — keep the longer prefix.
	collector.recordContext(
		[
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "more" },
		],
		{
			rawEstTokens: 3,
			sentEstTokens: 3,
			omittedTools: 0,
			omittedSavedTokens: 0,
			omittedSavedRatio: null,
		},
	);
	collector.finishTurn();

	collector.resetForNewTurn();
	collector.recordInjection({
		repoCacheStatus: "deferred",
		repoCacheInjectedTokens: 0,
		sysPrompt: "sys",
	});
	collector.recordContext(
		[
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "more" },
			{ role: "assistant", content: "done" },
			{ role: "user", content: "next" },
		],
		{
			rawEstTokens: 5,
			sentEstTokens: 5,
			omittedTools: 0,
			omittedSavedTokens: 0,
			omittedSavedRatio: null,
		},
	);
	assert.equal(collector.prefix?.status, "locked");
});

test("ContextGuard: dehydration stats count omitted tools and saved tokens", () => {
	const guard = new ContextGuard(1000);
	const modelFlash = "antigravity/gemini-3.8-flash";
	const modelArgon = "antigravity/gemini-4-argon";

	const messages: any[] = structuredClone([
		{ role: "user", content: "inspect", timestamp: 1 },
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "Z".repeat(4000) }],
			timestamp: 2,
		},
		{
			role: "assistant",
			provider: "antigravity",
			model: "gemini-3.8-flash",
			content: [{ type: "text", text: "ok" }],
			timestamp: 3,
		},
	]);

	guard.trackMessage(messages[0], modelFlash);
	guard.trackMessage(messages[1], modelFlash);
	guard.trackMessage(messages[2], modelFlash);

	const pruned = guard.protectContextOnModelSwitch(messages, modelArgon);
	assert.ok(pruned);
	const stats = guard.getLastDehydrationStats();
	assert.equal(stats.omittedTools, 1);
	assert.ok(stats.omittedSavedTokens > 0);
	assert.equal(stats.modified, true);
});

test("loadConfig exposes telemetry defaults", () => {
	const cfg = loadConfig();
	assert.equal(typeof cfg.telemetryEnabled, "boolean");
	assert.ok(cfg.telemetryHeavyModelPattern.includes("argon"));
	assert.ok(cfg.telemetryCacheBustHitRateFloor > 0);
	assert.equal(cfg.injectRepoCacheOn, "heavy");
});
