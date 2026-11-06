import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MODEL_POOL,
	isPeakHoursBeijing,
	getZaiPricingStatus,
} from "./config.ts";
import {
	checkScanState,
	saveScanCache,
	loadScanCache,
	clearScanCache,
} from "./git-cache.ts";
import {
	ARCH_INTENT_REGEX,
	SIMPLE_INTENT_REGEX,
	checkBlastRadius,
	decideNextPhase,
	isSingleFileTweak,
} from "./heuristics.ts";
import {
	collapseContextForArgon,
	collapseContextForExecute,
	distillContextForPhase,
	extractRepoSummary,
	extractTaskSpec,
} from "./context-collapser.ts";

test("DEFAULT_MODEL_POOL contains required role specifications", () => {
	assert.equal(DEFAULT_MODEL_POOL.scout, "google/gemini-3.8-flash");
	assert.equal(DEFAULT_MODEL_POOL.plan, "google/gemini-4-argon");
	assert.equal(DEFAULT_MODEL_POOL.executeFull, "zai/glm-5.3");
	assert.equal(DEFAULT_MODEL_POOL.executeFlash, "zai/glm-5.3-flash");
});

test("isPeakHoursBeijing correctly identifies UTC+8 14:00-18:00 on weekdays", () => {
	// 2026-11-09 是周一
	// UTC 06:00:00 -> 北京时间 14:00 (高峰开始)
	const mondayPeak = new Date("2026-11-09T06:00:00Z");
	assert.equal(isPeakHoursBeijing(mondayPeak), true);
	assert.equal(getZaiPricingStatus(mondayPeak).rate, "1x");

	// UTC 09:59:59 -> 北京时间 17:59 (高峰期内)
	const mondayPeakEnd = new Date("2026-11-09T09:59:59Z");
	assert.equal(isPeakHoursBeijing(mondayPeakEnd), true);

	// UTC 10:00:00 -> 北京时间 18:00 (高峰期结束，进入闲时 0.5x)
	const mondayOffPeak = new Date("2026-11-09T10:00:00Z");
	assert.equal(isPeakHoursBeijing(mondayOffPeak), false);
	assert.equal(getZaiPricingStatus(mondayOffPeak).rate, "0.5x");

	// 2026-11-08 是周日 (周末全天 0.5x 优惠)
	const sundayAfternoon = new Date("2026-11-08T07:00:00Z");
	assert.equal(isPeakHoursBeijing(sundayAfternoon), false);
	assert.equal(getZaiPricingStatus(sundayAfternoon).rate, "0.5x");
});

test("Scan cache persistence and lifecycle", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "auto-model-router-test-"));
	try {
		assert.equal(loadScanCache(tempDir), null);

		const dummyData = {
			gitHead: "abc1234",
			timestamp: Date.now(),
			repoSummary: "High-level summary of the architecture",
			scannedFiles: ["index.ts"],
		};

		saveScanCache(tempDir, dummyData);
		const loaded = loadScanCache(tempDir);
		assert.ok(loaded);
		assert.equal(loaded?.gitHead, "abc1234");
		assert.equal(loaded?.repoSummary, dummyData.repoSummary);

		assert.equal(clearScanCache(tempDir), true);
		assert.equal(loadScanCache(tempDir), null);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Heuristics: UNSCANNED triggers SCOUT phase", () => {
	const decision = decideNextPhase({
		prompt: "帮我实现一个分布式锁",
		scanState: "UNSCANNED",
	});

	assert.equal(decision.phase, "SCOUT");
	assert.equal(decision.modelRole, "scout");
	assert.ok(decision.reason.includes("全库架构侦察"));
});

test("Heuristics: Architecture intent triggers PLAN phase for Argon", () => {
	const decision = decideNextPhase({
		prompt: "请针对当前认证系统进行重构设计方案",
		scanState: "SCANNED",
	});

	assert.equal(decision.phase, "PLAN");
	assert.equal(decision.modelRole, "plan");
	assert.ok(decision.reason.includes("Argon"));
});

test("Heuristics: Simple bug fix or logging exempts from PLAN phase", () => {
	// 命中简单指令，豁免顶层规划，直接进入 EXECUTE
	const decision = decideNextPhase({
		prompt: "修一下报错：Cannot find module",
		scanState: "SCANNED",
		now: new Date("2026-11-08T10:00:00Z"), // 周日闲时
	});

	assert.equal(decision.phase, "EXECUTE");
	assert.equal(decision.modelRole, "executeFlash"); // 单文件/简单修复走 flash

	// 常规复杂需求在闲时走 executeFull
	const regularDecision = decideNextPhase({
		prompt: "开发数据同步模块与重试机制",
		scanState: "SCANNED",
		now: new Date("2026-11-08T10:00:00Z"), // 周日闲时
	});
	assert.equal(regularDecision.phase, "EXECUTE");
	assert.equal(regularDecision.modelRole, "executeFull");
});

test("Heuristics: Large blast radius (>= 4 directories) triggers PLAN phase", () => {
	const prompt = "需要同时调整 auth/user.ts, server/api.ts, db/schema.ts, 和 client/view.ts";
	assert.equal(checkBlastRadius(prompt, []), true);

	const decision = decideNextPhase({
		prompt,
		scanState: "SCANNED",
	});

	assert.equal(decision.phase, "PLAN");
	assert.equal(decision.modelRole, "plan");
});

test("Heuristics: Peak hours or single file tweak routes to EXECUTE_FLASH", () => {
	// 单文件轻量修改
	const tweakDecision = decideNextPhase({
		prompt: "改个变量名 userName to userId in auth/user.ts",
		scanState: "SCANNED",
		now: new Date("2026-11-08T10:00:00Z"), // 闲时
	});
	assert.equal(tweakDecision.phase, "EXECUTE");
	assert.equal(tweakDecision.modelRole, "executeFlash");

	// 高峰期任务
	const peakDecision = decideNextPhase({
		prompt: "实现通用数据导出脚本",
		scanState: "SCANNED",
		now: new Date("2026-11-09T08:00:00Z"), // 周一北京时间 16:00
	});
	assert.equal(peakDecision.phase, "EXECUTE");
	assert.equal(peakDecision.modelRole, "executeFlash");
});

test("Context collapser strips tool outputs and retains focus with task spec directive", () => {
	const mockMessages: any[] = [
		{ role: "user", content: "请看看当前项目结构" },
		{
			role: "assistant",
			content: "我来读取文件",
			toolCalls: [{ id: "c1", name: "read", arguments: {} }],
		},
		{ role: "toolResult", content: [{ type: "text", text: "1000 lines of file content..." }] },
		{ role: "assistant", content: "读取完成，准备修改" },
		{ role: "user", content: "请给出重构架构方案" },
	];

	const collapsed = collapseContextForArgon(
		mockMessages,
		"Core architecture uses microkernel pattern",
		"modified: src/core.ts",
	);

	// 1. 验证 toolResult 被完全剔除
	assert.equal(collapsed.some((m: any) => m.role === "toolResult"), false);
	assert.equal(collapsed.some((m: any) => m.role === "tool"), false);

	// 2. 验证注入了项目架构摘要
	const firstUser = collapsed[0] as any;
	assert.ok(firstUser.content.includes("[PROJECT ARCHITECTURE SUMMARY]"));
	assert.ok(firstUser.content.includes("microkernel pattern"));
	assert.ok(firstUser.content.includes("[RECENT UNCOMMITTED CHANGES]"));

	// 3. 验证最后一条 user 消息注入了 PLAN 模式约束
	const lastUser = collapsed[collapsed.length - 1] as any;
	assert.ok(lastUser.content.includes("<task_spec>"));
	assert.ok(lastUser.content.includes("严禁调用 write/edit"));
});

test("Extractors parse repo_summary and task_spec tags accurately", () => {
	const sampleScout = "这是思考过程\n<repo_summary>\n技术栈：TypeScript + Node\n入口：src/index.ts\n</repo_summary>\n结束";
	assert.equal(
		extractRepoSummary(sampleScout),
		"技术栈：TypeScript + Node\n入口：src/index.ts",
	);

	const samplePlan = "架构方案如下：\n<task_spec>\n1. 修改 src/auth.ts\n2. 补充测试\n</task_spec>";
	assert.equal(
		extractTaskSpec(samplePlan),
		"1. 修改 src/auth.ts\n2. 补充测试",
	);
});

test("collapseContextForExecute injects task spec, architecture summary and prevents rescan", () => {
	const mockMessages: any[] = [
		{ role: "user", content: "请排查下性能瓶颈" },
		{
			role: "toolResult",
			content: [{ type: "text", text: "line\n".repeat(100) }], // 超长早期输出
		},
		{ role: "user", content: "开始优化" },
		{ role: "assistant", content: "开始执行" },
		{ role: "user", content: "请修改对应文件" },
	];

	const distilled = collapseContextForExecute(
		mockMessages,
		"Architecture: microkernel with dynamic loader",
		"Task 1: optimize cache in src/cache.ts",
		"modified: src/cache.ts",
	);

	// 1. 验证前置注入了架构摘要与 Task Spec
	const first = distilled[0] as any;
	assert.ok(first.content.includes("[PROJECT ARCHITECTURE SUMMARY]"));
	assert.ok(first.content.includes("microkernel with dynamic loader"));
	assert.ok(first.content.includes("[ACTIVE TASK SPEC"));
	assert.ok(first.content.includes("Task 1: optimize cache"));

	// 2. 验证过早的巨大工具输出被折叠为轻量提示
	const toolRes = distilled.find((m: any) => m.role === "toolResult") as any;
	assert.ok(toolRes);
	assert.ok(toolRes.content[0].text.includes("Prior tool output omitted"));

	// 3. 验证注入了防重复扫描指令
	const lastUser = distilled[distilled.length - 1] as any;
	assert.ok(lastUser.content.includes("[SYSTEM DIRECTIVE: IMPLEMENTATION"));
	assert.ok(lastUser.content.includes("严禁重复进行全库盲目扫描"));
});
