import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionUiConfig } from "./config.ts";
import type { SessionTitleController } from "./title-controller.ts";
import { phaseForTool } from "./work-animation-core.ts";
import {
	loadWorkAnimationState,
	saveWorkAnimationState,
} from "./work-animation-state.ts";

type WorkAnimationConfig = SessionUiConfig["workAnimation"];

type ActiveTool = {
	phase: string;
};

const WIDGET_ID = "session-ui:work-animation";
const TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MASCOT_FRAMES = ["ᕕ( ᐛ )ᕗ", "ᕗ( ᐛ )ᕕ"];

export function registerWorkAnimation(
	pi: ExtensionAPI,
	initialConfig: WorkAnimationConfig,
	statePath: string,
	titleController: SessionTitleController,
): void {
	let config = { ...initialConfig };
	let lastStateWarning: string | undefined;
	let requestRender: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;
	let frameIndex = 0;
	let phase = "Working...";
	const activeTools = new Map<string, ActiveTool>();

	const renderOnce = () => requestRender?.();
	const isTui = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";

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
			const frame = TITLE_FRAMES[frameIndex % TITLE_FRAMES.length]!;
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
		titleController.setAnimationFrame(TITLE_FRAMES[0]);
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
		const saved = loadWorkAnimationState(statePath, initialConfig.enabled);
		config.enabled = saved.enabled;
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
						const mascot = MASCOT_FRAMES[frameIndex % MASCOT_FRAMES.length]!;
						const line = `${theme.fg("accent", mascot)} ${theme.fg("muted", phase)}`;
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
		startAnimation(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!config.enabled) return;
		const toolName = event.toolName || "tool";
		const toolPhase = phaseForTool(toolName);
		activeTools.set(event.toolCallId, { phase: toolPhase });
		if (running) updatePhase();
		else startAnimation(ctx, toolPhase);
	});

	pi.on("tool_execution_end", (event) => {
		if (!config.enabled) return;
		activeTools.delete(event.toolCallId);
		updatePhase();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.isIdle()) return;
		titleController.setWorking(false);
		stopAnimation();
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
		description: "Configure the session-ui work animation: on, off, status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";

			if (action === "status") {
				ctx.ui.notify(
					`Work animation: ${config.enabled ? "on" : "off"} · ${config.intervalMs}ms · ${config.placement}`,
					"info",
				);
				return;
			}

			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /work-animation [on|off|status]", "error");
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
				`Work animation ${config.enabled ? "enabled" : "disabled"}`,
				"info",
			);
		},
	});
}
