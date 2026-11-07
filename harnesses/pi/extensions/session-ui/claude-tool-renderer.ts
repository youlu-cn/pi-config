import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import type { ClaudeToolStyleMode, SessionUiConfig } from "./config.ts";
import {
	formatErrorLines,
	formatResultSummary,
	formatToolHeader,
	getTextContent,
} from "./claude-tool-renderer-core.ts";
import {
	DEFAULT_RICH_DIFF_OPTIONS,
	formatRichEditDiff,
	formatRichWritePreview,
	type RichDiffOptions,
} from "./rich-diff-core.ts";
import {
	ASK_USER_QUESTION_TOOL_NAME,
	CODEMODE_TOOL_NAME,
	formatAskUserQuestionResult,
	formatCodemodeResult,
} from "./special-cards-core.ts";
import { installToolGrouping, type ToolGroupingHooks } from "./tool-grouping.ts";
import type { AnimationStyle } from "./work-animation-core.ts";

const activeAnimTimers = new Set<NodeJS.Timeout>();

export interface ClaudeToolRendererOptions {
	getStyle?: () => AnimationStyle;
	getIntervalMs?: () => number;
	getMode?: () => ClaudeToolStyleMode;
	getGrouping?: () => boolean;
	getDiffOptions?: () => RichDiffOptions;
	/** Dedicated AskUser / Codemode result cards (default true). */
	getSpecialCards?: () => boolean;
	/** Called when mode changes via /tool-style */
	onModeChange?: (mode: ClaudeToolStyleMode) => void;
}

export class ToolHeaderComponent implements Component {
	private textComponent = new Text("", 0, 0);
	private toolName = "";
	private args: any = null;
	private cwd = "";
	private theme!: Theme;
	private isDone = false;
	private isError = false;
	private animStep = 0;
	private style: AnimationStyle = "claude";
	private outputPad = 1;

	update(props: {
		toolName: string;
		args: any;
		cwd: string;
		theme: Theme;
		isDone: boolean;
		isError: boolean;
		animStep: number;
		style: AnimationStyle;
		outputPad: number;
	}): void {
		this.toolName = props.toolName;
		this.args = props.args;
		this.cwd = props.cwd;
		this.theme = props.theme;
		this.isDone = props.isDone;
		this.isError = props.isError;
		this.animStep = props.animStep;
		this.style = props.style;
		this.outputPad = props.outputPad;
		this.invalidate();
	}

	invalidate(): void {
		this.textComponent.invalidate();
	}

	render(width: number): string[] {
		const padWidth = Math.max(0, this.outputPad);
		const pad = " ".repeat(padWidth);
		const effectiveWidth = width > 0 ? width : (process.stdout?.columns || 0);
		const availableWidth = effectiveWidth > 0 ? Math.max(10, effectiveWidth - padWidth) : undefined;

		const headerText = formatToolHeader(
			this.toolName,
			this.args,
			this.cwd,
			this.theme,
			this.isDone,
			this.isError,
			this.animStep,
			this.style,
			availableWidth,
		);

		this.textComponent.setText(`${pad}${headerText}`);
		return this.textComponent.render(width);
	}
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
	intervalMs = 240,
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

function expandHint(expanded: boolean): string {
	return expanded ? "click / ctrl+o to collapse" : "click / ctrl+o to expand";
}

function toRichDiffOptions(
	cfg: SessionUiConfig["claudeToolStyle"] | undefined,
	width?: number,
): RichDiffOptions {
	return {
		viewMode: cfg?.diffViewMode ?? DEFAULT_RICH_DIFF_OPTIONS.viewMode,
		indicatorMode: cfg?.diffIndicatorMode ?? DEFAULT_RICH_DIFF_OPTIONS.indicatorMode,
		splitMinWidth: cfg?.diffSplitMinWidth ?? DEFAULT_RICH_DIFF_OPTIONS.splitMinWidth,
		editCollapsedLines:
			cfg?.editDiffCollapsedLines ?? DEFAULT_RICH_DIFF_OPTIONS.editCollapsedLines,
		writeCollapsedLines:
			cfg?.writeDiffCollapsedLines ?? DEFAULT_RICH_DIFF_OPTIONS.writeCollapsedLines,
		width,
	};
}

export function registerClaudeToolRenderer(
	pi: ExtensionAPI,
	rendererOptions: ClaudeToolRendererOptions = {},
): { setMode: (mode: ClaudeToolStyleMode) => void; getMode: () => ClaudeToolStyleMode } {
	let mode: ClaudeToolStyleMode = rendererOptions.getMode?.() ?? "on";
	let groupingHooks: ToolGroupingHooks | undefined;

	const getMode = () => rendererOptions.getMode?.() ?? mode;
	const setMode = (next: ClaudeToolStyleMode) => {
		mode = next;
		rendererOptions.onModeChange?.(next);
	};

	const groupingEnabled = () => {
		const m = getMode();
		if (m === "off") return false;
		return rendererOptions.getGrouping?.() ?? true;
	};

	if (typeof pi.registerToolRenderer === "function") {
		pi.registerToolRenderer((toolName, next) => {
			const defaultRenderers = next();
			const compact = () => getMode() === "compact";

			return {
				renderShell: "self",
				renderCall(args, theme, context) {
					const state = context.state as ToolAnimState;
					if (getMode() === "off") {
						stopSpinner(state);
						return defaultRenderers?.renderCall?.(args, theme, context);
					}
					groupingHooks?.setTheme(theme);
					const isDone =
						!context.isPartial &&
						(context.durationMs !== undefined || state.hasResult === true);
					const isError = context.isError === true;

					const currentStyle = rendererOptions.getStyle?.() ?? "claude";
					const currentIntervalMs = rendererOptions.getIntervalMs?.() ?? 240;

					let animStep = 0;
					if (!isDone) {
						animStep = getSpinnerStep(state, context, currentIntervalMs);
					} else {
						stopSpinner(state);
					}

					const component =
						context.lastComponent instanceof ToolHeaderComponent
							? context.lastComponent
							: new ToolHeaderComponent();

					component.update({
						toolName,
						args,
						cwd: context.cwd,
						theme,
						isDone,
						isError,
						animStep,
						style: currentStyle,
						outputPad: context.outputPad ?? 1,
					});

					return component;
				},

				renderResult(result, options, theme, context) {
					const state = context.state as ToolAnimState;
					if (getMode() === "off") {
						state.hasResult = true;
						stopSpinner(state);
						return defaultRenderers?.renderResult?.(result, options, theme, context);
					}
					state.hasResult = true;
					stopSpinner(state);

					const pad = " ".repeat(Math.max(0, context.outputPad ?? 1));
					const hint = expandHint(options.expanded);
					const width = process.stdout?.columns || 80;
					const diffOpts = {
						...(rendererOptions.getDiffOptions?.() ?? toRichDiffOptions(undefined, width)),
						width,
					};

					if (context.isError) {
						const errorText = getTextContent(result?.content) || "Tool execution failed";
						const component =
							context.lastComponent instanceof Text
								? context.lastComponent
								: new Text("", 0, 0);
						component.setText(formatErrorLines(errorText, theme, options.expanded, pad));
						return component;
					}

					const specialCards = rendererOptions.getSpecialCards?.() ?? true;

					if (specialCards && toolName === ASK_USER_QUESTION_TOOL_NAME) {
						const text = formatAskUserQuestionResult(
							result,
							theme,
							options.expanded,
							pad,
							hint,
							context.isError === true,
						);
						const component =
							context.lastComponent instanceof Text
								? context.lastComponent
								: new Text("", 0, 0);
						component.setText(text);
						return component;
					}

					if (specialCards && toolName === CODEMODE_TOOL_NAME) {
						const text = formatCodemodeResult(
							result,
							theme,
							options.expanded,
							pad,
							hint,
							context.isError === true,
							options.isPartial === true,
							context.args?.code ?? context.args?.script,
						);
						const component =
							context.lastComponent instanceof Text
								? context.lastComponent
								: new Text("", 0, 0);
						component.setText(text);
						return component;
					}

					// compact collapsed: one-line summary only (including edit/write)
					if (compact() && !options.expanded) {
						const summary = formatResultSummary(
							toolName,
							context.args,
							result,
							context.durationMs,
						);
						const line = `${pad}  ${theme.fg("dim", `└ ${summary} (${hint})`)}`;
						const component =
							context.lastComponent instanceof Text
								? context.lastComponent
								: new Text("", 0, 0);
						component.setText(line);
						return component;
					}

					if (toolName === "edit") {
						const diffPreview = formatRichEditDiff(
							context.args,
							result,
							theme,
							options.expanded,
							pad,
							hint,
							diffOpts,
						);
						const component =
							context.lastComponent instanceof Text
								? context.lastComponent
								: new Text("", 0, 0);
						component.setText(diffPreview);
						return component;
					}

					if (toolName === "write") {
						const writePreview = formatRichWritePreview(
							context.args,
							result,
							theme,
							options.expanded,
							pad,
							hint,
							diffOpts,
						);
						const component =
							context.lastComponent instanceof Text
								? context.lastComponent
								: new Text("", 0, 0);
						component.setText(writePreview);
						return component;
					}

					if (!options.expanded) {
						const summary = formatResultSummary(
							toolName,
							context.args,
							result,
							context.durationMs,
						);
						const line = `${pad}  ${theme.fg("dim", `└ ${summary} (${hint})`)}`;
						const component =
							context.lastComponent instanceof Text
								? context.lastComponent
								: new Text("", 0, 0);
						component.setText(line);
						return component;
					}

					const container =
						context.lastComponent instanceof Container
							? context.lastComponent
							: new Container();
					container.clear();
					container.addChild(
						new Text(`${pad}  ${theme.fg("dim", `└ (${hint})`)}`, 0, 0),
					);

					if (defaultRenderers?.renderResult) {
						try {
							const child = defaultRenderers.renderResult(result, options, theme, context);
							if (child) {
								container.addChild(child);
								return container;
							}
						} catch {
							/* fall through */
						}
					}

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
	}

	groupingHooks = installToolGrouping(groupingEnabled);

	pi.registerCommand("tool-style", {
		description: "Switch Claude tool card mode: on | compact | off",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (!arg || arg === "status") {
				ctx.ui.notify(
					`tool-style: mode=${getMode()} grouping=${groupingEnabled() ? "on" : "off"}`,
					"info",
				);
				return;
			}
			if (arg === "on" || arg === "compact" || arg === "off") {
				setMode(arg);
				ctx.ui.notify(`tool-style set to ${arg}`, "info");
				ctx.ui.requestRender?.(true);
				return;
			}
			ctx.ui.notify("Usage: /tool-style [on|compact|off|status]", "warning");
		},
	});

	const cleanup = () => {
		cleanupAllToolAnimationTimers();
	};
	pi.on("turn_end", cleanup);
	pi.on("agent_settled", cleanup);
	pi.on("session_shutdown", (_event, _ctx: ExtensionContext) => {
		cleanup();
		groupingHooks?.shutdown();
	});

	return { setMode, getMode };
}
