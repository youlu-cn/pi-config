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
	type ScanCacheData,
} from "./scan-cache.ts";
import { extractRepoSummary, parseModelSpec } from "./tools/scout.ts";
import { extractTaskSpec, buildArchitectPrompt } from "./tools/architect.ts";
import { parseSubagentHandle } from "./tools/subagent-runner.ts";
import { ContextGuard } from "./context-guard.ts";
import { loadConfig } from "./config.ts";

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
	];

	for (const [file, content] of files) {
		assert.ok(
			!content.includes("setModel("),
			`Forbidden setModel() call found in ${file}! Extensions must never tamper with user-selected model.`,
		);
	}
});
