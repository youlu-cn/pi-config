import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AutoModelRouter } from "./router.ts";
import { getScoutPromptInstruction } from "./heuristics.ts";

function extractText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

export default function autoModelRouter(pi: ExtensionAPI): void {
	let router: AutoModelRouter | undefined;
	let lastContext: any;

	// 1. 会话初始化与多时序防丢重发
	pi.on("session_start", (_event, ctx) => {
		lastContext = ctx;
		router = new AutoModelRouter(pi, ctx.cwd);
		router.updateStatusBar(ctx);

		// 排队微任务与短期宏任务，确保后初始化的扩展也能接收到广播
		queueMicrotask(() => {
			if (lastContext) router?.updateStatusBar(lastContext);
		});
		setTimeout(() => {
			if (lastContext) router?.updateStatusBar(lastContext);
		}, 80);
	});

	// 监听状态栏就绪事件，握手同步
	pi.events.on("session-ui/statusline/ready/v1", () => {
		if (router && lastContext) {
			router.updateStatusBar(lastContext);
		}
	});

	// 2. 在轮次启动前决策当前阶段与切换模型
	pi.on("before_agent_start", async (event, ctx) => {
		if (!router) router = new AutoModelRouter(pi, ctx.cwd);

		let userPrompt = "";
		if (event.messageType === "user") {
			userPrompt = event.prompt;
		}

		await router.handleBeforeAgentStart(userPrompt, ctx);

		// 如果当前被决策为 SCOUT 侦察阶段，向当前轮次注入全库侦察指令
		if (router.phase === "SCOUT" && event.messageType === "user") {
			const instruction = getScoutPromptInstruction();
			event.prompt = `${event.prompt}\n\n${instruction}`;
		}
	});

	// 3. 上下文折叠与剥离 (保护 Argon 配额)
	pi.on("context", (event, ctx) => {
		if (!router) return;
		const modified = router.handleContext(event.messages, ctx);
		if (modified !== event.messages) {
			event.messages.splice(0, event.messages.length, ...modified);
		}
	});

	// 4. 轮次结束：提取摘要或规划规格，并强制流转状态机
	pi.on("turn_end", async (event, ctx) => {
		if (!router) return;
		const assistantText = extractText(event.message);
		await router.handleTurnEnd(assistantText, ctx);
	});

	// 5. 模型或状态切换时保持状态栏更新
	pi.on("model_select", (_event, ctx) => {
		router?.updateStatusBar(ctx);
	});

	// 6. 注册交互命令
	pi.registerCommand("auto", {
		description: "Toggle Auto Model router on or off",
		async handler(_args, ctx) {
			if (!router) router = new AutoModelRouter(pi, ctx.cwd);
			await router.toggleAuto(ctx);
		},
	});

	pi.registerCommand("rescan", {
		description: "Clear project scan fingerprint cache and force full scout in next turn",
		async handler(_args, ctx) {
			if (!router) router = new AutoModelRouter(pi, ctx.cwd);
			router.rescan(ctx);
		},
	});

	pi.registerCommand("plan", {
		description: "Force next turn to use Argon for top-level architectural planning (with context collapse)",
		async handler(args, ctx) {
			if (!router) router = new AutoModelRouter(pi, ctx.cwd);
			router.requestPlan(ctx);
			if (args && args.trim().length > 0) {
				pi.sendUserMessage(args.trim());
			}
		},
	});
}
