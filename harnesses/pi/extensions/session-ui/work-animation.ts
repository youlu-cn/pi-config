import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionUiConfig } from "./config.ts";
import type { SessionTitleController } from "./title-controller.ts";
import {
	getTitleSpinnerFrame,
	isValidAnimationStyle,
	phaseForTool,
	renderSpinnerFrame,
	type AnimationStyle,
} from "./work-animation-core.ts";
import {
	loadWorkAnimationState,
	saveWorkAnimationState,
} from "./work-animation-state.ts";
import {
	carryTokenRate,
	currentTtftMs,
	displayTokenRate,
	formatElapsed,
	formatTokenCount,
	formatTokenRate,
	markFirstToken,
	pauseTokenRate,
	recordProviderUsage,
	resetTokenRate,
	resumeTokenRate,
	sampleTokenDelta,
	startMessageSegment,
	totalTokens,
	type TokenRateMode,
} from "./token-rate.ts";

type WorkAnimationConfig = SessionUiConfig["workAnimation"];

type ActiveTool = {
	phase: string;
};

const WIDGET_ID = "session-ui:work-animation";
const SHOW_TIMER_AFTER_MS = 3_000;

export interface WorkAnimationController {
	getStyle(): AnimationStyle;
	getIntervalMs(): number;
}

function outputUsage(message: { usage?: { output?: unknown } } | undefined): number {
	const value = Number(message?.usage?.output);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function registerWorkAnimation(
	pi: ExtensionAPI,
	initialConfig: WorkAnimationConfig,
	statePath: string,
	titleController: SessionTitleController,
): WorkAnimationController {
	let config = { ...initialConfig };
	let activeStyle: AnimationStyle = initialConfig.style ?? "claude";
	let lastStateWarning: string | undefined;
	let requestRender: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;
	let frameIndex = 0;
	let phase = "Working...";
	const activeTools = new Map<string, ActiveTool>();
	let agentStartTime = 0;
	let rateRunStartTime = 0;
	const rateMode: TokenRateMode = config.tokenRateMode ?? "average";
	const showTtft = config.showTtft !== false;
	const showWorkingStats = config.showStats !== false;

	const renderOnce = () => requestRender?.();
	const isTui = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";

	const buildStatsSuffix = (): string => {
		if (!showWorkingStats || !agentStartTime) return "";
		const parts: string[] = [];
		const tokens = totalTokens();
		if (tokens > 0) parts.push(`↓ ${formatTokenCount(tokens)} tok`);
		const elapsed = Date.now() - agentStartTime;
		if (elapsed >= SHOW_TIMER_AFTER_MS || tokens > 0) {
			parts.push(formatElapsed(elapsed));
		}
		const rate = formatTokenRate(displayTokenRate(rateMode), currentTtftMs(), rateMode, showTtft);
		if (rate) parts.push(rate);
		return parts.length ? ` (${parts.join(" · ")})` : "";
	};

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const stopAnimation = () => {
		running = false;
		activeTools.clear();
		stopTimer();
		frameIndex = 0;
		titleController.setAnimationFrame(undefined);
		renderOnce();
	};

	const applyEnabledState = (ctx: ExtensionContext) => {
		if (!isTui(ctx)) return;
		ctx.ui.setWorkingVisible(!config.enabled);
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
		if (!config.enabled) titleController.setAnimationFrame(undefined);
		titleController.paint();
		renderOnce();
	};

	const startTimer = () => {
		stopTimer();
		timer = setInterval(() => {
			frameIndex++;
			const frame = getTitleSpinnerFrame(frameIndex, activeStyle);
			titleController.setAnimationFrame(frame);
			renderOnce();
		}, config.intervalMs);
	};

	const startAnimation = (ctx: ExtensionContext, nextPhase = "Working...") => {
		if (!config.enabled || !isTui(ctx)) return;
		running = true;
		frameIndex = 0;
		phase = nextPhase;
		ctx.ui.setWorkingVisible(false);
		titleController.setAnimationFrame(getTitleSpinnerFrame(0, activeStyle));
		startTimer();
		renderOnce();
	};

	const updatePhase = () => {
		phase = [...activeTools.values()].at(-1)?.phase ?? "Wrapping up...";
		renderOnce();
	};

	pi.on("session_start", (_event, ctx) => {
		requestRender = undefined;
		stopTimer();
		running = false;
		frameIndex = 0;
		phase = "Working...";
		activeTools.clear();
		const saved = loadWorkAnimationState(
			statePath,
			initialConfig.enabled,
			initialConfig.style ?? "claude",
		);
		config.enabled = saved.enabled;
		if (saved.style) {
			activeStyle = saved.style;
		} else {
			activeStyle = initialConfig.style ?? "claude";
		}
		if (ctx.hasUI) {
			if (saved.warning && saved.warning !== lastStateWarning) {
				ctx.ui.notify(saved.warning, "warning");
			}
			lastStateWarning = saved.warning;
		}

		if (!isTui(ctx)) return;
		ctx.ui.setWidget(
			WIDGET_ID,
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					render(width: number): string[] {
						if (!running || !config.enabled) return [];
						const spinner = renderSpinnerFrame(frameIndex, theme, activeStyle, 4);
						const stats = buildStatsSuffix();
						const line = `${spinner}  ${theme.fg("muted", `${phase}${stats}`)}`;
						return [truncateToWidth(line, Math.max(1, width), "")];
					},
					invalidate() {},
				};
			},
			{ placement: config.placement },
		);
		applyEnabledState(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		titleController.setWorking(true);
		const now = Date.now();
		if (!agentStartTime) agentStartTime = now;
		if (rateRunStartTime !== agentStartTime) {
			rateRunStartTime = agentStartTime;
			resetTokenRate(agentStartTime);
		}
		startAnimation(ctx);
	});

	pi.on("turn_start", (event) => {
		const now = event?.timestamp || Date.now();
		if (!agentStartTime) agentStartTime = now;
		if (rateRunStartTime !== agentStartTime) {
			rateRunStartTime = agentStartTime;
			resetTokenRate(now);
		}
		startMessageSegment(now);
	});

	pi.on("message_update", (event) => {
		const evt = (event as { assistantMessageEvent?: any })?.assistantMessageEvent;
		if (!evt) return;
		if (
			evt.type === "thinking_start" ||
			evt.type === "text_start" ||
			evt.type === "toolcall_start"
		) {
			markFirstToken();
			const output = outputUsage(evt.partial);
			if (output > 0) recordProviderUsage(output);
		} else if (
			evt.type === "thinking_delta" ||
			evt.type === "text_delta" ||
			evt.type === "toolcall_delta"
		) {
			if (typeof evt.delta === "string") sampleTokenDelta(evt.delta);
			const output = outputUsage(evt.partial);
			if (output > 0) recordProviderUsage(output);
		} else if (evt.type === "text_end" || evt.type === "thinking_end") {
			const output = outputUsage(evt.partial);
			if (output > 0) recordProviderUsage(output);
		}
		renderOnce();
	});

	pi.on("message_end", (event) => {
		const message = (event as { message?: { role?: string; usage?: { output?: unknown }; stopReason?: string } })
			?.message;
		if (message?.role !== "assistant") return;
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		const output = outputUsage(message);
		if (output > 0) recordProviderUsage(output, Date.now(), !failed);
		renderOnce();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!config.enabled) return;
		pauseTokenRate();
		const toolName = event.toolName || "tool";
		const toolPhase = phaseForTool(toolName);
		activeTools.set(event.toolCallId, { phase: toolPhase });
		if (running) updatePhase();
		else startAnimation(ctx, toolPhase);
	});

	pi.on("tool_execution_end", (event) => {
		if (!config.enabled) return;
		resumeTokenRate();
		activeTools.delete(event.toolCallId);
		updatePhase();
	});

	pi.on("turn_end", () => {
		carryTokenRate();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.isIdle()) return;
		titleController.setWorking(false);
		stopAnimation();
		agentStartTime = 0;
		rateRunStartTime = 0;
	});

	pi.on("agent_end", () => {
		agentStartTime = 0;
		rateRunStartTime = 0;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopAnimation();
		titleController.setWorking(false);
		if (isTui(ctx)) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setWorkingMessage();
			ctx.ui.setWorkingIndicator();
		}
		requestRender = undefined;
	});

	pi.registerCommand("work-animation", {
		description: "Configure the session-ui work animation: on, off, status, claude, gemini, braille, dots",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";

			if (action === "status") {
				ctx.ui.notify(
					`Work animation: ${config.enabled ? "on" : "off"} · ${activeStyle} · ${config.intervalMs}ms · ${config.placement}`,
					"info",
				);
				return;
			}

			if (isValidAnimationStyle(action)) {
				activeStyle = action;
				config = { ...config, enabled: true, style: action };
				applyEnabledState(ctx);
				if (titleController.isWorking()) {
					startAnimation(ctx, phase);
				}
				try {
					saveWorkAnimationState(statePath, config.enabled, activeStyle);
				} catch (error) {
					ctx.ui.notify(
						`Work animation style set to ${activeStyle} for this session only; could not save ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(`Work animation style set to ${activeStyle}`, "info");
				return;
			}

			if (action !== "on" && action !== "off") {
				ctx.ui.notify(
					"Usage: /work-animation [on|off|status|claude|gemini|braille|dots]",
					"error",
				);
				return;
			}

			if (running) stopAnimation();
			config = { ...config, enabled: action === "on" };
			applyEnabledState(ctx);
			if (config.enabled && titleController.isWorking()) {
				startAnimation(ctx);
			}
			try {
				saveWorkAnimationState(statePath, config.enabled);
			} catch (error) {
				ctx.ui.notify(
					`Work animation ${config.enabled ? "on" : "off"} for this session only; could not save ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Work animation ${config.enabled ? "enabled" : "disabled"} (${activeStyle})`,
				"info",
			);
		},
	});

	return {
		getStyle: () => activeStyle,
		getIntervalMs: () => config.intervalMs,
	};
}
