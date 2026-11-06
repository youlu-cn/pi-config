import type { ExtensionAPI, ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_CONFIG,
	getScheduledModelSelection,
	isHighCostModel,
	loadOrchestratorConfig,
	type OrchestratorConfig,
} from "./config.ts";
import {
	checkScanState,
	clearScanCache,
	loadScanCache,
	type ScanStatusInfo,
} from "./scan-cache.ts";
import { runScoutTask } from "./tools/scout.ts";

export class CacheAndOrchestrator {
	private readonly pi: ExtensionAPI;
	private currentConfig: OrchestratorConfig;
	private cacheLockActive = false;
	private lastInitialModelAssigned?: string;
	private readonly overrideStateDir?: string;

	constructor(pi: ExtensionAPI, initialCwd: string = process.cwd(), overrideStateDir?: string) {
		this.pi = pi;
		this.overrideStateDir = overrideStateDir;
		this.currentConfig = loadOrchestratorConfig(initialCwd, overrideStateDir);
	}

	get config(): OrchestratorConfig {
		return this.currentConfig;
	}

	get isCacheLocked(): boolean {
		return this.cacheLockActive;
	}

	/**
	 * 重新从磁盘加载配置（支持工作区及全局热更新）
	 */
	reloadConfig(cwd: string): void {
		this.currentConfig = loadOrchestratorConfig(cwd, this.overrideStateDir);
	}

	/**
	 * 更新底部状态栏
	 * 格式：📦 Scan: Cached/Dirty/Unscanned | 🔥 Cache Lock: Active/Unlocked | ⏱️ Z.ai: 0.5x/1.0x
	 */
	updateStatusBar(ctx: ExtensionContext, scanInfo?: ScanStatusInfo): void {
		if (!ctx.hasUI) return;

		const scan = scanInfo || checkScanState(ctx.cwd);
		const scheduled = getScheduledModelSelection(this.currentConfig, new Date());
		const rate = scheduled.rate;

		let scanBadge = "📦 Scan: Unscanned";
		if (scan.status === "CACHED") {
			const head = scan.gitHead ? scan.gitHead.slice(0, 7) : "ok";
			scanBadge = `📦 Scan: Cached (${head})`;
		} else if (scan.status === "DIRTY") {
			scanBadge = `📦 Scan: Dirty (+${scan.changedFilesCount})`;
		}

		const lockBadge = this.cacheLockActive ? "🔥 Cache Lock: Active" : "🔓 Cache Lock: Unlocked";
		const zaiBadge = `⏱️ Rate: ${rate}`;

		ctx.ui.setStatus("cache-and-orchestrator", `${scanBadge} | ${lockBadge} | ${zaiBadge}`);
	}

	/**
	 * 黏性 KV Cache 闲忙时初选：仅在会话初始阶段自动选择主模型（基于本机时间与配置规则）
	 */
	async checkInitialModelSelection(ctx: ExtensionContext): Promise<void> {
		this.reloadConfig(ctx.cwd);

		const entries = ctx.sessionManager.getEntries();
		const messageCount = entries.filter((e: any) => e.type === "message").length;

		// 消息数 > 2 说明会话已有真实历史上下文，锁定黏性 Cache，严禁中途切模打穿缓存
		if (messageCount > 2) {
			this.cacheLockActive = true;
			this.updateStatusBar(ctx);
			return;
		}

		this.cacheLockActive = false;

		// 依据本机时间和配置规则评估初选模型
		const scheduled = getScheduledModelSelection(this.currentConfig, new Date());
		const targetModelSpec = scheduled.model;

		if (this.lastInitialModelAssigned === targetModelSpec) {
			this.updateStatusBar(ctx);
			return;
		}

		const targetModel = this.findModel(ctx, targetModelSpec);
		if (targetModel && ctx.model?.id !== targetModel.id) {
			try {
				await this.pi.setModel(targetModel);
				this.lastInitialModelAssigned = targetModelSpec;
				const timingNotice = scheduled.ruleName
					? `⚡ 命中时段配置 [${scheduled.ruleName}]，主模型初选为 ${targetModel.name || targetModel.id} (${scheduled.rate})`
					: `💰 处于常规时段 (${scheduled.rate})，主模型初选为 ${targetModel.name || targetModel.id}`;
				ctx.ui.notify(timingNotice, "info");
			} catch {}
		}

		this.updateStatusBar(ctx);
	}

	/**
	 * 构建系统架构提示词挂载
	 */
	buildOrchestrationDirective(cwd: string): string {
		const scan = checkScanState(cwd);

		if (scan.status === "UNSCANNED") {
			return `
[SYSTEM DIRECTIVE: REPOSITORY ARCHITECTURE UNINDEXED]
当前项目尚未完成架构指纹提取或近期发生大面积变动（>=8个文件）。
编排指南：
1. 若用户需求依赖全局架构上下文，建议先调用 scout 工具执行只读扫描更新 .pi/scan-cache.json。
2. 常规单文件修改或轻量修复可直接处理。
`.trim();
		}

		const summary = scan.cache?.repoSummary || "";
		const dirtySection = scan.diffSummary
			? `\n[RECENT MODIFIED FILES]\n${scan.diffSummary}`
			: "";

		return `
[SYSTEM DIRECTIVE: REPOSITORY ARCHITECTURE MOUNTED]
[PROJECT ARCHITECTURE SUMMARY]
${summary}${dirtySection}

编排指南：
1. 项目架构已知，严禁重复进行全库盲目扫描。
2. 常规编码、修 Bug、跑测试直接由你（主模型）完成。
3. 遇到跨多模块重大重构、复杂协议/并发/死锁设计或用户明确要求顶层规划时：请调用 architect 工具获取 Task Spec 蓝图后再执行代码修改。
`.trim();
	}

	/**
	 * 手动切模型防破产兜底：若切到 Argon/Opus 等高成本模型，进行脱水保护
	 */
	dehydrateContextForHighCostModel(
		messages: AgentMessage[],
		ctx: ExtensionContext,
	): AgentMessage[] {
		// 若当前主会话模型不是昂贵的高成本模型，不做额外脱水处理，保持 100% 原始历史
		if (!isHighCostModel(ctx.model?.id)) {
			return messages;
		}

		const scan = loadScanCache(ctx.cwd);
		const repoSummary = scan?.repoSummary || "";

		// 找到最近 2 轮用户消息作为分界线
		const userIndices: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			if ((messages[i] as any)?.role === "user") {
				userIndices.push(i);
			}
		}
		const cutoffIndex = userIndices.length > 2 ? userIndices[userIndices.length - 2]! : 0;

		const dehydrated: AgentMessage[] = [];

		// 前置挂载浓缩架构指纹
		if (repoSummary.trim().length > 0) {
			dehydrated.push({
				role: "user",
				content: `[PROJECT ARCHITECTURE REPO SUMMARY]\n${repoSummary.trim()}\n\n请参考上述架构摘要。`,
			} as any);
			dehydrated.push({
				role: "assistant",
				content: "已同步架构指纹摘要，已进入高费率模型防破产保护脱水视图。",
			} as any);
		}

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i] as any;
			const isOlder = i < cutoffIndex;

			// 早期超大 toolResult 替换为摘要占位符
			if (isOlder && (msg.role === "toolResult" || msg.role === "tool")) {
				const text = this.extractTextContent(msg.content);
				if (text.length > 500) {
					dehydrated.push({
						...msg,
						content: [
							{
								type: "text",
								text: `[Prior tool output omitted (${text.split("\n").length} lines) to protect model quota - refer to architecture summary]`,
							},
						],
					});
					continue;
				}
			}

			dehydrated.push(msg);
		}

		return dehydrated;
	}

	/**
	 * 手动触发重新扫描
	 */
	async rescan(ctx: ExtensionContext): Promise<void> {
		clearScanCache(ctx.cwd);
		ctx.ui.notify("🔄 正在调用 scout 启动项目架构扫描...", "info");
		const res = await runScoutTask({ forceRefresh: true }, ctx, this.currentConfig.scoutModel);
		if (res.success) {
			ctx.ui.notify(`✅ 项目架构侦察完成并已写入 .pi/scan-cache.json (HEAD: ${res.gitHead.slice(0, 7)})`, "info");
		} else {
			ctx.ui.notify(`⚠️ 侦察未完成: ${res.error || "未知异常"}`, "warning");
		}
		this.updateStatusBar(ctx);
	}

	private findModel(ctx: ExtensionContext, spec: string): Model<any> | undefined {
		const parts = spec.split("/");
		if (parts.length === 2) {
			const [p, id] = parts;
			const m = ctx.modelRegistry.find(p!, id!);
			if (m) return m;

			if (p === "google") {
				const ag = ctx.modelRegistry.find("antigravity", id!);
				if (ag) return ag;
			}
			if (p === "antigravity") {
				const g = ctx.modelRegistry.find("google", id!);
				if (g) return g;
			}
		}
		const all = ctx.modelRegistry.getAll();
		return all.find((m) => spec.includes(m.id) || m.id === spec);
	}

	private extractTextContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("\n");
		}
		return "";
	}
}
