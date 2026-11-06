import type { ExtensionAPI, ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import {
	getZaiPricingStatus,
	loadRouterState,
	saveRouterState,
	type ModelPoolConfig,
	type RouterPhase,
	type RouterState,
} from "./config.ts";
import {
	checkScanState,
	clearScanCache,
	saveScanCache,
	type ScanStatusResult,
} from "./git-cache.ts";
import {
	decideNextPhase,
	getScoutPromptInstruction,
} from "./heuristics.ts";
import {
	distillContextForPhase,
	extractRepoSummary,
	extractTaskSpec,
} from "./context-collapser.ts";

export const AUTO_MODEL_STATUS_EVENT = "auto-model/status/v1";

export class AutoModelRouter {
	private readonly pi: ExtensionAPI;
	private state: RouterState;
	private currentPhase: RouterPhase = "EXECUTE";
	private justFinishedScout = false;
	private explicitPlanRequested = false;
	private manualModelSnapshot?: Model<any>;
	private lastTaskSpec?: string;

	private stateDir?: string;

	constructor(pi: ExtensionAPI, initialCwd: string, stateDir?: string) {
		this.pi = pi;
		this.stateDir = stateDir;
		this.state = loadRouterState(initialCwd, stateDir);
	}

	get isAutoEnabled(): boolean {
		return this.state.autoEnabled;
	}

	get modelPool(): ModelPoolConfig {
		return this.state.modelPool;
	}

	get phase(): RouterPhase {
		return this.currentPhase;
	}

	/**
	 * 智能解析模型定义
	 */
	findModel(ctx: ExtensionContext, modelSpec: string): Model<any> | undefined {
		const parts = modelSpec.split("/");
		if (parts.length === 2) {
			const [provider, modelId] = parts;
			const direct = ctx.modelRegistry.find(provider!, modelId!);
			if (direct) return direct;

			// 常见 provider 互转兼容 (例如 google <-> antigravity)
			if (provider === "google") {
				const ag = ctx.modelRegistry.find("antigravity", modelId!);
				if (ag) return ag;
			}
			if (provider === "antigravity") {
				const g = ctx.modelRegistry.find("google", modelId!);
				if (g) return g;
			}

			// 全局根据 ID 模糊匹配
			const all = ctx.modelRegistry.getAll();
			const byId = all.find((m) => m.id === modelId || m.name === modelId);
			if (byId) return byId;
		} else {
			const all = ctx.modelRegistry.getAll();
			const byId = all.find((m) => m.id === modelSpec || m.name === modelSpec);
			if (byId) return byId;
		}

		return undefined;
	}

	/**
	 * 更新底部状态栏
	 */
	updateStatusBar(ctx: ExtensionContext, scanStatus?: ScanStatusResult): void {
		// 1. 广播 Auto 状态给 session-ui，无缝融合左侧模型段
		this.pi.events.emit(AUTO_MODEL_STATUS_EVENT, {
			v: 1,
			enabled: this.state.autoEnabled,
			phase: this.currentPhase,
		});

		if (!ctx.hasUI) return;

		// 2. 根据要求：“Auto 关闭时，右侧什么都不用留”
		if (!this.state.autoEnabled) {
			ctx.ui.setStatus("auto-model-router", "");
			return;
		}

		// 3. Auto 开启时，右侧仅显示环境辅助指标，不再重复显示 Auto 和模型名
		const zaiPricing = getZaiPricingStatus();
		const scan = scanStatus || checkScanState(ctx.cwd);

		let repoBadge = "📦 Unscanned";
		if (scan.state === "SCANNED") {
			const shortHead = scan.gitHead ? scan.gitHead.slice(0, 7) : "clean";
			repoBadge = `📦 Clean (${shortHead})`;
		} else if (scan.state === "INCREMENTAL_DIRTY") {
			repoBadge = `📦 Dirty (+${scan.dirtyCount})`;
		}

		const statusText = `${repoBadge} · ⏱️ ${zaiPricing.label} (${zaiPricing.rate})`;
		ctx.ui.setStatus("auto-model-router", statusText);
	}

	/**
	 * 在单轮对话开始前进行启发式阶段决策与切模
	 */
	async handleBeforeAgentStart(
		prompt: string,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!this.state.autoEnabled) {
			this.updateStatusBar(ctx);
			return;
		}

		// 保存用户手动选择的模型快照
		if (!this.manualModelSnapshot && ctx.model) {
			this.manualModelSnapshot = ctx.model;
		}

		const scanStatus = checkScanState(ctx.cwd);

		const decision = decideNextPhase({
			prompt,
			scanState: scanStatus.state,
			justFinishedScout: this.justFinishedScout,
			explicitPlanRequested: this.explicitPlanRequested,
			uncommittedFiles: [],
		});

		this.justFinishedScout = false;
		this.explicitPlanRequested = false;
		this.currentPhase = decision.phase;

		// 获取目标模型规范
		const targetModelSpec = this.state.modelPool[decision.modelRole];
		const targetModel = this.findModel(ctx, targetModelSpec);

		if (targetModel) {
			const currentModelId = ctx.model?.id;
			const targetModelId = targetModel.id;

			if (currentModelId !== targetModelId) {
				try {
					await this.pi.setModel(targetModel);
					ctx.ui.notify(decision.reason, "info");
				} catch {
					// 切模失败静默保持当前模型
				}
			}
		}

		this.updateStatusBar(ctx, scanStatus);
	}

	/**
	 * context 钩子：在发送给新模型前进行跨阶段上下文智能蒸馏并注入架构知识
	 */
	handleContext(eventMessages: any[], ctx: ExtensionContext): any[] {
		if (!this.state.autoEnabled) return eventMessages;

		const scanStatus = checkScanState(ctx.cwd);
		const repoSummary = scanStatus.cache?.repoSummary || "";
		const dirtyDiff = scanStatus.diffSummary;

		return distillContextForPhase(
			this.currentPhase,
			eventMessages,
			repoSummary,
			this.lastTaskSpec,
			dirtyDiff,
		);
	}

	/**
	 * turn_end 钩子：处理各阶段回复解析、缓存写入及状态机流转
	 */
	async handleTurnEnd(
		assistantText: string,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!this.state.autoEnabled) {
			this.updateStatusBar(ctx);
			return;
		}

		// 1. SCOUT 阶段：提取并持久化架构摘要
		if (this.currentPhase === "SCOUT") {
			const repoSummary = extractRepoSummary(assistantText);
			if (repoSummary) {
				const scanStatus = checkScanState(ctx.cwd);
				const cacheData = {
					gitHead: scanStatus.gitHead || "unknown",
					timestamp: Date.now(),
					repoSummary,
					scannedFiles: [],
				};

				saveScanCache(ctx.cwd, cacheData);
				this.pi.appendEntry("auto-model-router:scan-cache", cacheData);

				ctx.ui.notify("✅ 项目架构摘要已生成并存入缓存", "info");
				this.justFinishedScout = true;
			}
		}

		// 2. PLAN 阶段：提取 Task Spec 并立即切回 EXECUTE 阶段
		if (this.currentPhase === "PLAN") {
			const spec = extractTaskSpec(assistantText);
			if (spec) {
				this.lastTaskSpec = spec;
			}

			// 强约束：Argon 规划完成立即退回执行阶段，严禁停留在多轮对话中消耗配额
			this.currentPhase = "EXECUTE";
			const zaiPricing = getZaiPricingStatus();
			const executeKey = zaiPricing.isPeak ? "executeFlash" : "executeFull";
			const nextModelSpec = this.state.modelPool[executeKey];
			const nextModel = this.findModel(ctx, nextModelSpec);

			if (nextModel && ctx.model?.id !== nextModel.id) {
				try {
					await this.pi.setModel(nextModel);
					ctx.ui.notify("⚡ 架构规划已完成，切至主力模型执行具体代码操作", "info");
				} catch {}
			}
		}

		this.updateStatusBar(ctx);
	}

	/**
	 * 切换 Auto 路由模式开关
	 */
	async toggleAuto(ctx: ExtensionContext): Promise<void> {
		this.state.autoEnabled = !this.state.autoEnabled;
		saveRouterState(this.state, this.stateDir);

		if (this.state.autoEnabled) {
			this.updateStatusBar(ctx);
			ctx.ui.notify("🤖 Auto Model 自动路由已开启", "info");
		} else {
			// 关闭时恢复用户最初的手动模型
			if (this.manualModelSnapshot) {
				try {
					await this.pi.setModel(this.manualModelSnapshot);
				} catch {}
			}
			this.updateStatusBar(ctx);
			ctx.ui.notify("⏸️ Auto Model 自动路由已关闭（已恢复手动模型）", "info");
		}
	}

	/**
	 * 强制清除扫描指纹缓存
	 */
	rescan(ctx: ExtensionContext): void {
		clearScanCache(ctx.cwd);
		this.currentPhase = "SCOUT";
		this.updateStatusBar(ctx);
		ctx.ui.notify("🔄 项目扫描缓存已清除，下一轮将强制全量架构侦察", "info");
	}

	/**
	 * 手动显式触发单轮规划
	 */
	requestPlan(ctx: ExtensionContext): void {
		this.explicitPlanRequested = true;
		this.currentPhase = "PLAN";
		this.updateStatusBar(ctx);
		ctx.ui.notify("🧠 下一轮将强制使用 Argon 进行顶层架构规划（带上下文折叠）", "info");
	}
}
