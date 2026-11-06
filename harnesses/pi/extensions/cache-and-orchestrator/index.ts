import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CacheAndOrchestrator } from "./orchestrator.ts";
import { runScoutTask } from "./tools/scout.ts";
import { runArchitectTask } from "./tools/architect.ts";

export default function cacheAndOrchestratorExtension(pi: ExtensionAPI): void {
	const orchestrator = new CacheAndOrchestrator(pi);

	// 1. 注册专用的 scout 工具（只读扫描代码库，提炼架构指纹）
	pi.registerTool({
		name: "scout",
		label: "Scout Reconnaissance",
		description:
			"Scan repository architecture in an isolated context using gemini-3.8-flash, extract key components, and write 2000-token summary to .pi/scan-cache.json.",
		parameters: {
			type: "object",
			properties: {
				reason: {
					type: "string",
					description: "Trigger reason for scanning, e.g. project unindexed or major git changes",
				},
				focusPaths: {
					type: "array",
					items: { type: "string" },
					description: "Optional specific paths to prioritize",
				},
			},
		} as any,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const res = await runScoutTask(params || {}, ctx);
			if (res.success) {
				return {
					content: [
						{
							type: "text",
							text: `[SCOUT SUCCESS] Project architecture scanned and cached to .pi/scan-cache.json (HEAD: ${res.gitHead.slice(0, 7)}).\nSummary:\n${res.repoSummary}`,
						},
					],
				};
			}
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `[SCOUT FAILED] Could not complete reconnaissance: ${res.error || "Unknown error"}`,
					},
				],
			};
		},
	});

	// 2. 注册专用的 architect 工具（顶层规划，单轮物理隔离，保护 Argon 昂贵配额）
	pi.registerTool({
		name: "architect",
		label: "Architect Planning",
		description:
			"Consult gemini-4-argon in a clean, isolated single-turn context (<5K tokens) to generate a precise <task_spec> implementation blueprint without file modification tools.",
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Complex requirements, refactoring goals, or protocol/deadlock design details",
				},
				codeSnippets: {
					type: "string",
					description: "Key relevant code slices or signature definitions needed for planning",
				},
			},
			required: ["task"],
		} as any,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const res = await runArchitectTask(params as any, ctx);
			if (res.success) {
				return {
					content: [
						{
							type: "text",
							text: `[ARCHITECT PLAN GENERATED via ${res.modelUsed}]\n\n<task_spec>\n${res.taskSpec}\n</task_spec>\n\n请主模型根据上述任务规范与文件路径直接执行代码修改。`,
						},
					],
				};
			}
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `[ARCHITECT PLAN FAILED via ${res.modelUsed}]: ${res.error || "Unknown error"}`,
					},
				],
			};
		},
	});

	// 3. 会话启动：初选模型与状态栏呈现
	pi.on("session_start", async (_event, ctx) => {
		await orchestrator.checkInitialModelSelection(ctx);
		orchestrator.updateStatusBar(ctx);
	});

	// 4. 轮次开始前：维持 Cache 黏性锁，并向系统提示词注入架构编排指令
	pi.on("before_agent_start", async (event, ctx) => {
		await orchestrator.checkInitialModelSelection(ctx);

		const directive = orchestrator.buildOrchestrationDirective(ctx.cwd);
		if (event.messageType === "user") {
			event.prompt = `${event.prompt}\n\n${directive}`;
		}
	});

	// 5. context 钩子：手动切换到高成本模型时开启脱水只读视图
	pi.on("context", (event, ctx) => {
		const modified = orchestrator.dehydrateContextForHighCostModel(event.messages, ctx);
		if (modified !== event.messages) {
			event.messages.splice(0, event.messages.length, ...modified);
		}
	});

	// 6. 轮次结束与模型变更：保持状态栏同步
	pi.on("turn_end", (_event, ctx) => {
		orchestrator.updateStatusBar(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		orchestrator.updateStatusBar(ctx);
	});

	// 7. 注册 /rescan 命令
	pi.registerCommand("rescan", {
		description: "Force clean .pi/scan-cache.json and trigger scout reconnaissance",
		async handler(_args, ctx) {
			await orchestrator.rescan(ctx);
		},
	});
}
