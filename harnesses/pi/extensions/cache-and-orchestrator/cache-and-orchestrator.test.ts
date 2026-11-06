import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	isPeakHoursBeijing,
	getZaiPricingRate,
	isHighCostModel,
} from "./config.ts";
import {
	checkScanState,
	saveScanCache,
	loadScanCache,
	clearScanCache,
} from "./scan-cache.ts";
import { extractTaskSpec } from "./tools/architect.ts";
import { extractRepoSummary } from "./tools/scout.ts";
import { CacheAndOrchestrator } from "./orchestrator.ts";

test("config: model definitions and high-cost detection", () => {
	assert.equal(DEFAULT_CONFIG.scoutModel, "google/gemini-3.8-flash");
	assert.equal(DEFAULT_CONFIG.architectModel, "google/gemini-4-argon");
	assert.equal(DEFAULT_CONFIG.executeFullModel, "zai/glm-5.3");
	assert.equal(DEFAULT_CONFIG.executeFlashModel, "zai/glm-5.3-flash");

	assert.equal(isHighCostModel("gemini-4-argon"), true);
	assert.equal(isHighCostModel("claude-3-opus"), true);
	assert.equal(isHighCostModel("glm-5.3"), false);
	assert.equal(isHighCostModel("gemini-3.8-flash"), false);
});

test("config: peak hours (UTC+8 Mon-Fri 14:00-18:00) vs off-peak rates", () => {
	// 周一北京时间 15:00 (高峰)
	const mondayPeak = new Date("2026-11-09T07:00:00Z");
	assert.equal(isPeakHoursBeijing(mondayPeak), true);
	assert.equal(getZaiPricingRate(mondayPeak), "1.0x");

	// 周一北京时间 19:00 (非高峰 0.5x)
	const mondayNight = new Date("2026-11-09T11:00:00Z");
	assert.equal(isPeakHoursBeijing(mondayNight), false);
	assert.equal(getZaiPricingRate(mondayNight), "0.5x");

	// 周末全天 0.5x
	const sunday = new Date("2026-11-08T07:00:00Z");
	assert.equal(isPeakHoursBeijing(sunday), false);
	assert.equal(getZaiPricingRate(sunday), "0.5x");
});

test("scan-cache: lifecycle and file tracking", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "scan-cache-test-"));
	try {
		assert.equal(loadScanCache(tempDir), null);

		const data = {
			gitHead: "head1234",
			timestamp: Date.now(),
			repoSummary: "Architecture: microkernel pattern",
		};
		saveScanCache(tempDir, data);

		const loaded = loadScanCache(tempDir);
		assert.ok(loaded);
		assert.equal(loaded?.gitHead, "head1234");
		assert.equal(loaded?.repoSummary, data.repoSummary);

		assert.equal(clearScanCache(tempDir), true);
		assert.equal(loadScanCache(tempDir), null);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("tools extractors: task_spec and repo_summary tags", () => {
	const specText = "方案如下：\n<task_spec>\n1. 修改 src/app.ts\n2. 补充测试\n</task_spec>";
	assert.equal(extractTaskSpec(specText), "1. 修改 src/app.ts\n2. 补充测试");

	const summaryText = "报告：\n<repo_summary>\n技术栈：Node.js\n架构：分层设计\n</repo_summary>";
	assert.equal(extractRepoSummary(summaryText), "技术栈：Node.js\n架构：分层设计");
});

test("orchestrator: status bar formatting", () => {
	let statusKey = "";
	let statusText = "";

	const mockPi: any = {
		setModel: async () => true,
	};
	const orchestrator = new CacheAndOrchestrator(mockPi);

	const mockCtx: any = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setStatus(key: string, text: string) {
				statusKey = key;
				statusText = text;
			},
		},
	};

	orchestrator.updateStatusBar(mockCtx);
	assert.equal(statusKey, "cache-and-orchestrator");
	assert.ok(statusText.includes("📦 Scan:"));
	assert.ok(statusText.includes("Cache Lock:"));
	assert.ok(statusText.includes("⏱️ Z.ai:"));
});

test("orchestrator: sticky KV cache lock preserves session model once history accumulates", async () => {
	let currentModel = "zai/glm-5.3";
	const mockPi: any = {
		setModel: async (m: any) => {
			currentModel = m.id;
			return true;
		},
	};
	const orchestrator = new CacheAndOrchestrator(mockPi);

	// 1. 初始空会话（<= 2 条消息）：允许自动初选
	const initialCtx: any = {
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: {
			getEntries: () => [{ type: "message" }],
		},
		model: { id: "gemini-3.8-flash" },
		modelRegistry: {
			find: (_p: string, id: string) => ({ id, provider: "zai" }),
			getAll: () => [],
		},
		ui: { setStatus: () => {}, notify: () => {} },
	};

	await orchestrator.checkInitialModelSelection(initialCtx);
	assert.equal(orchestrator.isCacheLocked, false);

	// 2. 消息累积（> 2 条消息）：触发 Cache 黏性锁，中途严禁切换主模型
	const accumulatedCtx: any = {
		...initialCtx,
		sessionManager: {
			getEntries: () => [
				{ type: "message" },
				{ type: "message" },
				{ type: "message" },
			],
		},
	};

	await orchestrator.checkInitialModelSelection(accumulatedCtx);
	assert.equal(orchestrator.isCacheLocked, true);
});

test("orchestrator: context dehydration only activates for high-cost models (Argon/Opus)", () => {
	const mockPi: any = {};
	const orchestrator = new CacheAndOrchestrator(mockPi);

	const mockMessages: any[] = [
		{ role: "user", content: "第一轮用户问题" },
		{
			role: "toolResult",
			content: [{ type: "text", text: "x".repeat(600) }], // 超过 500 字符的早期日志
		},
		{ role: "user", content: "第二轮用户问题" },
		{ role: "assistant", content: "回答" },
		{ role: "user", content: "第三轮用户问题" },
	];

	// 1. 普通模型 (GLM-5.3)：保持 100% 原始历史上下文，不触发脱水
	const normalCtx: any = {
		cwd: process.cwd(),
		model: { id: "glm-5.3" },
	};
	const normalResult = orchestrator.dehydrateContextForHighCostModel(mockMessages, normalCtx);
	assert.deepEqual(normalResult, mockMessages);

	// 2. 高成本模型 (Argon)：激活脱水保护，早期庞大 toolResult 替换为紧凑占位符
	const argonCtx: any = {
		cwd: process.cwd(),
		model: { id: "gemini-4-argon" },
	};
	const dehydrated = orchestrator.dehydrateContextForHighCostModel(mockMessages, argonCtx);

	// 验证早期 toolResult 被安全折叠
	const toolRes = dehydrated.find((m: any) => m.role === "toolResult") as any;
	assert.ok(toolRes);
	assert.ok(toolRes.content[0].text.includes("Prior tool output omitted"));
});

test("orchestrator: directive mounting guides model to use scout or architect", () => {
	const mockPi: any = {};
	const orchestrator = new CacheAndOrchestrator(mockPi);

	const tempDir = mkdtempSync(join(tmpdir(), "directive-test-"));
	try {
		// 1. 未扫描状态：引导调用 scout 工具
		const unindexedDirective = orchestrator.buildOrchestrationDirective(tempDir);
		assert.ok(unindexedDirective.includes("scout"));

		// 2. 已缓存架构状态：引导调用 architect 工具
		saveScanCache(tempDir, {
			gitHead: "head123",
			timestamp: Date.now(),
			repoSummary: "Architecture summary content",
		});
		const cachedDirective = orchestrator.buildOrchestrationDirective(tempDir);
		assert.ok(cachedDirective.includes("architect"));
		assert.ok(cachedDirective.includes("Architecture summary content"));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
