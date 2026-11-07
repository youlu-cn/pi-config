import type { ExtensionAPI, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	formatEditDiffPreview,
	formatErrorLines,
	formatResultSummary,
	formatToolHeader,
	formatWritePreview,
	getTextContent,
} from "./claude-tool-renderer-core.ts";
import type { AnimationStyle } from "./work-animation-core.ts";

const activeAnimTimers = new Set<NodeJS.Timeout>();

export interface ClaudeToolRendererOptions {
	getStyle?: () => AnimationStyle;
	getIntervalMs?: () => number;
}

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

function getSpinnerStep(
	state: ToolAnimState,
	context: ToolRenderContext,
	intervalMs = 180,
): number {
	if (!state.animTimer) {
		state.frameIndex = 0;
		const timer = setInterval(() => {
			state.frameIndex = (state.frameIndex ?? 0) + 1;
			context.invalidate();
		}, intervalMs);
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

export function registerClaudeToolRenderer(
	pi: ExtensionAPI,
	rendererOptions: ClaudeToolRendererOptions = {},
): void {
	if (typeof pi.registerToolRenderer !== "function") return;
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

				const currentStyle = rendererOptions.getStyle?.() ?? "claude";
				const currentIntervalMs = rendererOptions.getIntervalMs?.() ?? 180;

				let animStep = 0;
				if (!isDone) {
					animStep = getSpinnerStep(state, context, currentIntervalMs);
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
					currentStyle,
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

				// 1. Error state: red bullet + red styled error text
				if (context.isError) {
					const errorText = getTextContent(result?.content) || "Tool execution failed";
					const component =
						context.lastComponent instanceof Text
							? context.lastComponent
							: new Text("", 0, 0);
					component.setText(formatErrorLines(errorText, theme, options.expanded, pad));
					return component;
				}

				// 2. Edit tool: always show Claude Code style colored diff preview (collapsed = 12 lines, expanded = all)
				if (toolName === "edit") {
					const diffPreview = formatEditDiffPreview(
						context.args,
						result,
						theme,
						options.expanded,
						pad,
					);
					const component =
						context.lastComponent instanceof Text
							? context.lastComponent
							: new Text("", 0, 0);
					component.setText(diffPreview);
					return component;
				}

				// 3. Write tool: show accurate line count + code preview (collapsed = 8 lines, expanded = all)
				if (toolName === "write") {
					const writePreview = formatWritePreview(
						context.args,
						result,
						theme,
						options.expanded,
						pad,
					);
					const component =
						context.lastComponent instanceof Text
							? context.lastComponent
							: new Text("", 0, 0);
					component.setText(writePreview);
					return component;
				}

				// 4. Other tools in collapsed state: render single-line tree summary
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

				// 5. Expanded state for other tools: keep collapse hint and render details
				const container =
					context.lastComponent instanceof Container
						? context.lastComponent
						: new Container();
				container.clear();
				container.addChild(new Text(`${pad}  ${theme.fg("dim", "└ (ctrl+o to collapse)")}`, 0, 0));

				// If native renderer provides rich component with syntax highlighting, prefer it
				if (defaultRenderers?.renderResult) {
					try {
						const child = defaultRenderers.renderResult(result, options, theme, context);
						if (child) {
							container.addChild(child);
							return container;
						}
					} catch {}
				}

				// Generic expanded text output
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

	// Safety cleanup: clear any lingering animation timers on lifecycle boundaries
	const cleanup = () => cleanupAllToolAnimationTimers();
	pi.on("turn_end", cleanup);
	pi.on("agent_settled", cleanup);
	pi.on("session_shutdown", cleanup);
}
