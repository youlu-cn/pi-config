import { dirname, sep } from "node:path";
import { isPeakHoursBeijing, type RouterPhase } from "./config.ts";
import type { ScanState } from "./git-cache.ts";

export const ARCH_INTENT_REGEX =
	/(重构|架构|设计|方案|死锁|并发|协议栈|怎么实现|为什么会|refactor|architect|design|redesign|concurrency|protocol)/i;

export const SIMPLE_INTENT_REGEX =
	/^(修一下|加个日志|改个变量名|改下变量|写个单测|单测|格式化|fix\s+(typo|bug|error)|add\s+log|rename)/i;

const SINGLE_FILE_TWEAK_REGEX =
	/^(修一下|加个日志|改个|改下|rename|fix|tweak)\s+[\w\-./\\]+\.[a-zA-Z0-9]+/i;

export interface DecisionOptions {
	prompt: string;
	scanState: ScanState;
	justFinishedScout?: boolean;
	explicitPlanRequested?: boolean;
	uncommittedFiles?: string[];
	now?: Date;
}

export interface PhaseDecision {
	phase: RouterPhase;
	reason: string;
	modelRole: "scout" | "plan" | "executeFull" | "executeFlash";
}

/**
 * 检测提及文件或 Git 变更是否跨越 >= 4 个不同根目录/模块 (Blast Radius 大)
 */
export function checkBlastRadius(prompt: string, uncommittedFiles: string[] = []): boolean {
	const directories = new Set<string>();

	// 从 git 脏文件提取
	for (const file of uncommittedFiles) {
		const parts = file.split(/[/\\]/);
		if (parts.length > 1 && parts[0]) {
			directories.add(parts[0]);
		}
	}

	// 从 prompt 中匹配可能的文件路径
	const pathMatches = prompt.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+/g) || [];
	for (const p of pathMatches) {
		const dir = dirname(p).split(sep)[0];
		if (dir && dir !== "." && !dir.startsWith("-")) {
			directories.add(dir);
		}
	}

	return directories.size >= 4;
}

/**
 * 判断是否为单文件简单微调
 */
export function isSingleFileTweak(prompt: string, uncommittedFiles: string[] = []): boolean {
	const trimmed = prompt.trim();
	const pathMatches = trimmed.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+/g) || [];

	// 1. 命中简单修改正则且提及文件不超过 1 个
	if (SIMPLE_INTENT_REGEX.test(trimmed)) {
		if (pathMatches.length <= 1) return true;
	}

	// 2. 常见单文件微调描述
	if (/(改个变量名|改下变量|加个日志|加日志|修一下|加注释|加个注释|改下|rename|fix typo|tweak)/i.test(trimmed)) {
		if (pathMatches.length <= 1) return true;
	}

	// 3. 当前 git 未提交文件仅有 1 个且非架构重构
	if (uncommittedFiles.length === 1 && !ARCH_INTENT_REGEX.test(trimmed)) {
		return true;
	}

	return false;
}

/**
 * 启发式核心决策状态机
 */
export function decideNextPhase(options: DecisionOptions): PhaseDecision {
	const trimmedPrompt = options.prompt.trim();

	// 1. 强制侦察：项目未扫描
	if (options.scanState === "UNSCANNED") {
		return {
			phase: "SCOUT",
			reason: "项目未扫描或发生重大变更，切至 Gemini 3.8 Flash 执行全库架构侦察",
			modelRole: "scout",
		};
	}

	// 2. 豁免检查：简单任务直接跳过 PLAN 进入 EXECUTE
	const isSimple = SIMPLE_INTENT_REGEX.test(trimmedPrompt);

	// 3. 按需触发顶层规划 (PLAN -> Argon)
	const isExplicitPlan = options.explicitPlanRequested === true;
	const isPostScoutArch = options.justFinishedScout && !isSimple;
	const hasArchIntent = ARCH_INTENT_REGEX.test(trimmedPrompt);
	const hasLargeBlastRadius = checkBlastRadius(trimmedPrompt, options.uncommittedFiles);

	const shouldPlan =
		!isSimple && (isExplicitPlan || isPostScoutArch || hasArchIntent || hasLargeBlastRadius);

	if (shouldPlan) {
		let reason = "检测到架构设计需求，已启动单轮 Argon 规划";
		if (isExplicitPlan) reason = "用户通过 /plan 显式请求，切至 Argon 执行单轮架构规划";
		else if (isPostScoutArch) reason = "全库侦察刚完成，切至 Argon 制定顶层实现方案";
		else if (hasArchIntent) reason = "命中核心架构意图正则，已折叠上下文并切至 Argon 规划";
		else if (hasLargeBlastRadius) reason = "检测到跨多个核心模块的高影响面变更，切至 Argon 规划";

		return {
			phase: "PLAN",
			reason,
			modelRole: "plan",
		};
	}

	// 4. 默认编码与测试循环 (EXECUTE -> Z.ai)
	const isPeak = isPeakHoursBeijing(options.now);
	const isTweak = isSingleFileTweak(trimmedPrompt, options.uncommittedFiles);

	if (isPeak || isTweak) {
		const reason = isPeak
			? "处于工作日高峰时段 (14:00-18:00)，切至 GLM-5.3-Flash 享受 3 倍配额"
			: "任务为单文件轻量修改，切至 GLM-5.3-Flash 高速执行";
		return {
			phase: "EXECUTE",
			reason,
			modelRole: "executeFlash",
		};
	}

	return {
		phase: "EXECUTE",
		reason: "非高峰期 (0.5x 优惠时段)，切至主力满血版 GLM-5.3 执行编码与调试",
		modelRole: "executeFull",
	};
}

export function getScoutPromptInstruction(): string {
	return `
[SYSTEM DIRECTIVE: PROJECT REPO RECONNAISSANCE]
当前项目尚未完成架构指纹提取。请执行侦察模式：
1. 优先使用 find/grep/read 工具，快速扫描根目录结构、核心模块入口文件、包定义（如 package.json/go.mod/Cargo.toml 等）及核心接口签名。
2. 严禁修改或写入任何代码。
3. 在本轮输出的末尾，必须使用 <repo_summary>...</repo_summary> 标签包裹浓缩的项目架构摘要（控制在 2000 Tokens 以内），内容需覆盖：核心技术栈、顶层目录职责、关键数据结构/入口流转，以及主要设计模式。
`.trim();
}
