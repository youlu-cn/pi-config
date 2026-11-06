import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type {
	AgentToolResult,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	formatErrorLines,
	formatResultSummary,
	formatToolHeader,
	getTextContent,
	SPINNER_FRAMES,
} from "./claude-tool-renderer-core.ts";

const activeAnimTimers = new Set<NodeJS.Timeout>();

export function cleanupAllToolAnimationTimers(): void {
	for (const timer of activeAnimTimers) {
		clearInterval(timer);
	}
	activeAnimTimers.clear();
}

interface ToolAnimState {
	animTimer?: NodeJS.Timeout;
	frameIndex?: number;
	hasResult?: boolean;
}

function getSpinnerStep(state: ToolAnimState, context: ToolRenderContext): number {
	if (!state.animTimer) {
		state.frameIndex = 0;
		const timer = setInterval(() => {
			state.frameIndex = (state.frameIndex ?? 0) + 1;
			context.invalidate();
		}, 120);
		state.animTimer = timer;
		activeAnimTimers.add(timer);
	}
	return state.frameIndex ?? 0;
}

function stopSpinner(state: ToolAnimState): void {
	if (state.animTimer) {
		clearInterval(state.animTimer);
		activeAnimTimers.delete(state.animTimer);
		state.animTimer = undefined;
	}
}

export function registerClaudeToolRenderer(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const defaultRenderers = next();

		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				const state = context.state as ToolAnimState;
				const isDone =
					!context.isPartial &&
					(context.durationMs !== undefined || state.hasResult === true);
				const isError = context.isError === true;

				let animStep = 0;
				if (!isDone) {
					animStep = getSpinnerStep(state, context);
				} else {
					stopSpinner(state);
				}

				const headerText = formatToolHeader(
					toolName,
					args,
					context.cwd,
					theme,
					isDone,
					isError,
					animStep,
				);

				const pad = " ".repeat(Math.max(0, context.outputPad ?? 1));
				const component =
					context.lastComponent instanceof Text
						? context.lastComponent
						: new Text("", 0, 0);
				component.setText(`${pad}${headerText}`);
				return component;
			},

			renderResult(result, options, theme, context) {
				const state = context.state as ToolAnimState;
				state.hasResult = true;
				stopSpinner(state);

				const pad = " ".repeat(Math.max(0, context.outputPad ?? 1));

				// 1. 错误状态：红点 + 红字输出
				if (context.isError) {
					const errorText = getTextContent(result?.content) || "Tool execution failed";
					const component =
						context.lastComponent instanceof Text
							? context.lastComponent
							: new Text("", 0, 0);
					component.setText(formatErrorLines(errorText, theme, options.expanded, pad));
					return component;
				}

				// 2. 成功且默认折叠状态：树形摘要行
				if (!options.expanded) {
					const summary = formatResultSummary(
						toolName,
						context.args,
						result,
						context.durationMs,
					);
					const line = `${pad}  ${theme.fg("dim", `└ ${summary} (ctrl+o to expand)`)}`;
					const component =
						context.lastComponent instanceof Text
							? context.lastComponent
							: new Text("", 0, 0);
					component.setText(line);
					return component;
				}

				// 3. 成功且用户展开状态：保留折叠提示，并展示详细内容
				const container =
					context.lastComponent instanceof Container
						? context.lastComponent
						: new Container();
				container.clear();
				container.addChild(new Text(`${pad}  ${theme.fg("dim", "└ (ctrl+o to collapse)")}`, 0, 0));

				// 若原生 renderer 提供了带语法高亮的富组件，优先展示
				if (defaultRenderers?.renderResult) {
					try {
						const child = defaultRenderers.renderResult(result, options, theme, context);
						if (child) {
							container.addChild(child);
							return container;
						}
					} catch {}
				}

				// 通用展开内容输出
				const rawOutput = getTextContent(result?.content);
				if (rawOutput) {
					const lines = rawOutput.split("\n");
					const previewLines = lines
						.slice(0, 60)
						.map((l) => `  ${theme.fg("toolOutput", l)}`)
						.join("\n");
					const remaining = lines.length - 60;
					let text = previewLines;
					if (remaining > 0) {
						text += `\n  ${theme.fg("muted", `... (${remaining} more lines)`)}`;
					}
					container.addChild(new Text(text, 0, 0));
				}

				return container;
			},
		};
	});

	// 生命周期事件触发时兜底清理任何活跃的动画定时器
	const cleanup = () => cleanupAllToolAnimationTimers();
	pi.on("turn_end", cleanup);
	pi.on("agent_settled", cleanup);
	pi.on("session_shutdown", cleanup);
}
